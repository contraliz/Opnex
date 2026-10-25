const { app, BrowserWindow, WebContentsView, session, ipcMain, utilityProcess, shell, dialog } = require('electron');
const { createServer } = require('node:net');
const { createHmac, randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { assignTabToPane, removeTabFromPanes } = require('./pane-state.cjs');
const { safeAnnotation, captureScript, disableScript } = require('./annotation.cjs');
const { browserProfilePath } = require('./browser-profile.cjs');
const { clampNativeBounds } = require('./browser-bounds.cjs');
const { navigationState, navigate, attachNavigationHandlers } = require('./browser-navigation.cjs');
const { openCodexThread } = require('./codex-thread-link.cjs');

const partition = 'persist:pseudoharness-browser-v1';
const projectRoot=path.resolve(__dirname,'..');
let mainWindow;
let backend;
let backendExitCode=null;
let origin;
let bounds={main:null,side:null,chat:null};
let assignments={main:null,side:null,chat:null};
const workspaceBounds=new Map();
const workspaceTabs=new Map();
let tabSequence=0;
const tabs=new Map();
let annotationTimer;

if(process.env.PSEUDOHARNESS_INTERACTION_TEST==='1'&&process.env.PSEUDOHARNESS_CDP_PORT)app.commandLine.appendSwitch('remote-debugging-port',String(Number(process.env.PSEUDOHARNESS_CDP_PORT)));

if(process.env.PSEUDOHARNESS_ELECTRON_DATA_DIR){const userData=path.resolve(process.env.PSEUDOHARNESS_ELECTRON_DATA_DIR);mkdirSync(userData,{recursive:true});app.setPath('userData',userData);}
const browserProfile=browserProfilePath({platform:process.platform,localAppData:process.env.LOCALAPPDATA,userData:app.getPath('userData'),isolated:!!process.env.PSEUDOHARNESS_ELECTRON_DATA_DIR});
mkdirSync(browserProfile,{recursive:true});app.setPath('sessionData',browserProfile);

function pickPort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
function validAppSender(event){try{return !!mainWindow&&event.sender===mainWindow.webContents&&new URL(event.senderFrame?.url).origin===origin;}catch{return false;}}
function requireAppSender(event){if(!validAppSender(event))throw new Error('Only the local Pseudoharness window may control browser tabs.');}
function normalizeUrl(input){let url;try{url=new URL(input);}catch{throw new Error('Enter a complete website URL.');}if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('Only HTTP and HTTPS browser addresses are supported.');if(url.username||url.password)throw new Error('URLs that contain credentials are not accepted.');return url.toString();}
function stateForTab(tab){const contents=tab.view.webContents;return {id:tab.id,url:tab.url,title:tab.title||(!contents.isDestroyed()?contents.getTitle():'')||tab.url,pane:tab.workspaceId?'hidden':assignments.chat===tab.id?'chat':assignments.side===tab.id?'side':assignments.main===tab.id?'main':'hidden',loading:!contents.isDestroyed()&&contents.isLoading(),commenting:!!tab.commenting,...(tab.workspaceId?{workspaceId:tab.workspaceId}:{}),...(tab.workspaceId&&!contents.isDestroyed()?navigationState(contents):{}),...(tab.failure?{failure:{...tab.failure}}:{})};}
function state(){return [...tabs.values()].map(stateForTab);}
function legacyState(){return state().filter(tab=>!tab.workspaceId);}
function sendEvent(type,tab,extra={}){if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('pseudoharness:browser-event',{type,tabs:state(),...(tab?{tab:{id:tab.id,url:tab.url,title:tab.title, ...(tab.workspaceId?{workspaceId:tab.workspaceId}:{})}}:{}),...extra});}
function workspaceId(value){if(typeof value!=='string'||value.length<1||value.length>160||!/^[A-Za-z0-9._:-]+$/.test(value))throw new Error('A stable browser workspace ID is required.');return value;}
function workspaceTab(id){const host=workspaceId(id);const tabId=workspaceTabs.get(host);return tabId?tabs.get(tabId):undefined;}
function isSensitiveAuthPage(raw){try{const url=new URL(raw);return url.hostname.toLowerCase()==='github.com'&&/^\/(?:login|oauth|session)(?:\/|$)/i.test(url.pathname);}catch{return false;}}
function startAnnotationPolling(){if(annotationTimer)return;annotationTimer=setInterval(async()=>{for(const tab of tabs.values()){if(!tab.commenting||tab.view.webContents.isDestroyed())continue;try{const value=await tab.view.webContents.executeJavaScript('(()=>{const item=window.__pseudoharnessAnnotation;if(!item)return null;window.__pseudoharnessAnnotation=null;return item})()');if(!value||typeof value!=='object')continue;tab.annotationOverlay=true;applyBounds();sendEvent('annotation',tab,{annotation:safeAnnotation(value,{url:tab.view.webContents.getURL(),title:tab.title})});}catch{}}if(![...tabs.values()].some(tab=>tab.commenting)){clearInterval(annotationTimer);annotationTimer=undefined;}},350);annotationTimer.unref?.();}
function applyBounds(){if(!mainWindow||mainWindow.isDestroyed())return;const [width,height]=mainWindow.getContentSize();for(const tab of tabs.values()){let rect=null;let reserved=0;if(tab.workspaceId){const host=workspaceBounds.get(tab.workspaceId);rect=host?.active?host.bounds:null;reserved=tab.annotationOverlay?host?.annotationHeight||270:0;}else{const pane=panesFor(tab.id);rect=pane?bounds[pane]:null;reserved=tab.annotationOverlay?270:0;}const target=tab.failure?null:rect?{...rect,height:Math.max(0,rect.height-reserved)}:null;tab.view.setBounds(clampNativeBounds(target,{width,height}));}}
function panesFor(id){return ['main','side','chat'].find(pane=>assignments[pane]===id)||null;}
function activate(id,pane='main'){const tab=tabs.get(id);if(!tab)throw new Error('Browser tab no longer exists.');if(tab.workspaceId)throw new Error('Use the owning browser workspace to select this page.');assignments=assignTabToPane(assignments,id,pane);tab.pane=pane;applyBounds();sendEvent('selected',tab);return legacyState();}
function addTab(rawUrl,pane='main',hostId){
  const url=normalizeUrl(rawUrl);const id=`browser-${++tabSequence}`;const browserSession=session.fromPartition(partition,{cache:true});
  const view=new WebContentsView({webPreferences:{session:browserSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
  const tab={id,url,title:url,view,...(hostId?{workspaceId:hostId}:{}),failure:null,annotationOverlay:false,commenting:false};tabs.set(id,tab);if(hostId)workspaceTabs.set(hostId,id);
  view.webContents.setWindowOpenHandler(({url:opened})=>{try{const target=normalizeUrl(opened);if(tab.workspaceId)sendEvent('open-request',tab,{workspaceId:tab.workspaceId,url:target});else addTab(target,'main');}catch{}return {action:'deny'};});
  attachNavigationHandlers(view.webContents,{validateUrl:normalizeUrl,onMainFrameStart:url=>{tab.failure=null;tab.url=url;applyBounds();sendEvent('loading',tab);}});
  view.webContents.on('page-title-updated',(_event,title)=>{tab.title=title.slice(0,180);tab.url=view.webContents.getURL()||tab.url;sendEvent('updated',tab);});
  view.webContents.on('did-finish-load',()=>{if(tab.commenting)void view.webContents.executeJavaScript(captureScript).catch(()=>{});});
  view.webContents.on('did-navigate',(_event,next)=>{tab.url=next;tab.failure=null;if(tab.commenting&&isSensitiveAuthPage(next)){tab.commenting=false;tab.annotationOverlay=false;void view.webContents.executeJavaScript(disableScript).catch(()=>{});}applyBounds();sendEvent('updated',tab);});
  view.webContents.on('did-navigate-in-page',(_event,next)=>{tab.url=next;tab.failure=null;sendEvent('updated',tab);});
  view.webContents.on('did-fail-load',(_event,code,description,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.failure={code,description:String(description||'The page could not be loaded.').slice(0,240)};tab.title=`Could not load page (${code})`;applyBounds();sendEvent('failed',tab);}});
  mainWindow.contentView.addChildView(view);if(hostId)applyBounds();else activate(id,pane);void view.webContents.loadURL(url).catch(()=>{});return legacyState();
}
function closeTab(id){const tab=tabs.get(id);if(!tab)return legacyState();mainWindow.contentView.removeChildView(tab.view);tab.view.webContents.close();tabs.delete(id);if(tab.workspaceId){workspaceTabs.delete(tab.workspaceId);workspaceBounds.delete(tab.workspaceId);}const wasMain=assignments.main===id;assignments=removeTabFromPanes(assignments,id);if(wasMain)assignments.main=[...tabs.keys()].find(key=>!tabs.get(key)?.workspaceId&&key!==assignments.side&&key!==assignments.chat)||null;applyBounds();return legacyState();}

async function startBackend(){const port=await pickPort();origin=`http://127.0.0.1:${port}`;const launcher=path.join(projectRoot,'bin','pseudoharness.js');const data=path.join(app.getPath('userData'),'local-state');const startupSecret=randomBytes(32).toString('hex');const backendEnv={...process.env,NODE_ENV:'production',PORT:String(port),PSEUDOHARNESS_DATA_DIR:data,PSEUDOHARNESS_DESKTOP:'1',PSEUDOHARNESS_STARTUP_SECRET:startupSecret,PSEUDOHARNESS_PACKAGED_APP:app.isPackaged?'1':'0',PSEUDOHARNESS_RESOURCES_PATH:process.resourcesPath};backend=utilityProcess.fork(launcher,[],{cwd:app.getPath('userData'),env:backendEnv,stdio:process.env.PSEUDOHARNESS_SMOKE_TEST==='1'?'inherit':'ignore',serviceName:'Pseudoharness local backend'});backend.once('error',error=>console.error('Pseudoharness backend failed to start:',error.message));backend.once('exit',code=>{backendExitCode=code;});
  const deadline=Date.now()+20_000;while(Date.now()<deadline){if(backendExitCode!==null)throw new Error('Pseudoharness backend exited during startup.');try{const challenge=randomBytes(32).toString('hex');const expected=createHmac('sha256',startupSecret).update(challenge).digest('hex');const response=await fetch(`${origin}/api/health`,{headers:{'x-pseudoharness-startup-challenge':challenge}});if(response.ok){const health=await response.json();if(health.startupProof!==expected)throw new Error('The selected local port is not serving the Pseudoharness backend. Startup was stopped.');if(health.stateCode){const error=new Error(health.stateError||'Pseudoharness could not claim its local state directory.');error.code=health.stateCode;throw error;}return;}}catch(error){if(error instanceof Error&&(error.code==='STATE_DIRECTORY_IN_USE'||error.code==='STATE_OWNER_UNAVAILABLE'||error.message.includes('not serving the Pseudoharness backend')))throw error;}await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Pseudoharness backend did not become ready.');}

function registerIpc(){
  ipcMain.handle('pseudoharness:window-minimize',event=>{requireAppSender(event);mainWindow.minimize();});
  ipcMain.handle('pseudoharness:window-toggle-maximize',event=>{requireAppSender(event);if(mainWindow.isMaximized())mainWindow.restore();else mainWindow.maximize();return mainWindow.isMaximized();});
  ipcMain.handle('pseudoharness:window-close',event=>{requireAppSender(event);mainWindow.close();});
  ipcMain.handle('pseudoharness:open-codex-thread',(event,threadId)=>{requireAppSender(event);return openCodexThread(threadId,url=>shell.openExternal(url));});
  ipcMain.handle('pseudoharness:browser-list',event=>{requireAppSender(event);return legacyState();});
  ipcMain.handle('pseudoharness:browser-open',(event,payload)=>{requireAppSender(event);return addTab(payload?.url,payload?.pane);});
  ipcMain.handle('pseudoharness:browser-select',(event,payload)=>{requireAppSender(event);return activate(payload?.id,payload?.pane);});
  ipcMain.handle('pseudoharness:browser-side',(event,id)=>{requireAppSender(event);return activate(id,'side');});
  ipcMain.handle('pseudoharness:browser-main',(event,id)=>{requireAppSender(event);return activate(id,'main');});
  ipcMain.handle('pseudoharness:browser-chat',(event,id)=>{requireAppSender(event);return tabs.has(id)?activate(id,'chat'):legacyState();});
  ipcMain.handle('pseudoharness:browser-undock',(event,id)=>{requireAppSender(event);return activate(id,'main');});
  ipcMain.handle('pseudoharness:browser-close',(event,id)=>{requireAppSender(event);if(tabs.get(id)?.workspaceId)throw new Error('Use the owning browser workspace to close this page.');return closeTab(id);});
  ipcMain.handle('pseudoharness:browser-navigate',(event,payload)=>{requireAppSender(event);const tab=tabs.get(payload?.id);if(!tab||tab.workspaceId)throw new Error('Browser tab is no longer available to the legacy workspace.');navigate(tab.view.webContents,payload.action);return legacyState();});
  ipcMain.handle('pseudoharness:browser-commenting',async(event,payload)=>{requireAppSender(event);const tab=tabs.get(payload?.id);if(!tab||tab.workspaceId)throw new Error('Browser tab is no longer available to the legacy workspace.');if(payload?.enabled&&isSensitiveAuthPage(tab.view.webContents.getURL()))throw new Error('Commenting is disabled on GitHub sign-in pages.');tab.commenting=payload?.enabled===true;tab.annotationOverlay=false;applyBounds();await tab.view.webContents.executeJavaScript(tab.commenting?captureScript:disableScript);if(tab.commenting)startAnnotationPolling();return legacyState();});
  ipcMain.handle('pseudoharness:browser-annotation-overlay',(event,payload)=>{requireAppSender(event);const tab=tabs.get(payload?.id);if(!tab||tab.workspaceId)return legacyState();tab.annotationOverlay=payload?.visible===true;applyBounds();return legacyState();});
  ipcMain.handle('pseudoharness:browser-workspace-get',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const tab=workspaceTab(host);return tab?stateForTab(tab):null;});
  ipcMain.handle('pseudoharness:browser-workspace-open',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const existing=workspaceTab(host);if(existing)return stateForTab(existing);const url=normalizeUrl(payload?.url);addTab(url,'hidden',host);const created=workspaceTab(host);if(!created)throw new Error('The browser workspace could not be opened.');return stateForTab(created);});
  ipcMain.handle('pseudoharness:browser-workspace-release',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const tab=workspaceTab(host);if(tab)closeTab(tab.id);else workspaceBounds.delete(host);});
  ipcMain.handle('pseudoharness:browser-workspace-bounds',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const rect=payload?.bounds;const accepted=rect&&[rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)&&rect.width>0&&rect.height>0?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,annotationHeight:Number.isFinite(rect.annotationHeight)?Math.max(0,Math.min(480,rect.annotationHeight)):270}:null;workspaceBounds.set(host,{bounds:accepted,active:payload?.active===true});applyBounds();});
  ipcMain.handle('pseudoharness:browser-workspace-navigate',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const tab=workspaceTab(host);if(!tab)throw new Error('This browser workspace is no longer open.');const navigation=payload?.navigation;const contents=tab.view.webContents;if(typeof navigation==='object'&&navigation&&typeof navigation.url==='string'){const url=normalizeUrl(navigation.url);tab.failure=null;tab.url=url;tab.title=url;applyBounds();sendEvent('loading',tab);void contents.loadURL(url).catch(()=>{});}else if(['back','forward'].includes(navigation))navigate(contents,navigation);else if(navigation==='reload'){tab.failure=null;applyBounds();navigate(contents,navigation);}else if(!['back','forward','reload'].includes(navigation))throw new Error('Choose a valid browser navigation action.');return stateForTab(tab);});
  ipcMain.handle('pseudoharness:browser-workspace-commenting',async(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const tab=workspaceTab(host);if(!tab)throw new Error('This browser workspace is no longer open.');if(payload?.enabled&&isSensitiveAuthPage(tab.view.webContents.getURL()))throw new Error('Commenting is disabled on GitHub sign-in pages.');tab.commenting=payload?.enabled===true;tab.annotationOverlay=false;applyBounds();await tab.view.webContents.executeJavaScript(tab.commenting?captureScript:disableScript);if(tab.commenting)startAnnotationPolling();sendEvent('commenting',tab);});
  ipcMain.handle('pseudoharness:browser-workspace-annotation-overlay',(event,payload)=>{requireAppSender(event);const host=workspaceId(payload?.workspaceId);const tab=workspaceTab(host);if(!tab)return;tab.annotationOverlay=payload?.visible===true;applyBounds();});
  if(process.env.PSEUDOHARNESS_INTERACTION_TEST==='1'){
    ipcMain.handle('pseudoharness:interaction-state',event=>{requireAppSender(event);return [...tabs.values()].map(tab=>({id:tab.id,url:tab.view.webContents.getURL(),bounds:tab.view.getBounds(),annotationOverlay:!!tab.annotationOverlay,pane:panesFor(tab.id),...(tab.workspaceId?{workspaceId:tab.workspaceId}:{})}));});
    ipcMain.handle('pseudoharness:interaction-resize',(event,size)=>{requireAppSender(event);if(Number.isInteger(size?.width)&&Number.isInteger(size?.height))mainWindow.setSize(Math.max(900,size.width),Math.max(620,size.height));return mainWindow.getSize();});
  }
  ipcMain.handle('pseudoharness:browser-bounds',(event,value)=>{requireAppSender(event);const [width,height]=mainWindow.getContentSize();for(const pane of ['main','side','chat']){const r=value?.[pane];bounds[pane]=r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0?clampNativeBounds(r,{width,height}):null;}applyBounds();});
  ipcMain.handle('pseudoharness:browser-hide',event=>{requireAppSender(event);bounds={main:null,side:null,chat:null};applyBounds();});
  ipcMain.handle('pseudoharness:browser-clear-data',async event=>{requireAppSender(event);await session.fromPartition(partition).clearStorageData();await session.fromPartition(partition).clearCache();for(const tab of tabs.values())try{tab.view.webContents.reload();}catch{}return true;});
}

app.whenReady().then(async()=>{
  try{await startBackend();await session.fromPartition(partition).setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));registerIpc();mainWindow=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:620,frame:process.platform!=='win32',title:'Pseudoharness',backgroundColor:'#141414',show:process.env.PSEUDOHARNESS_SMOKE_TEST!=='1',webPreferences:{preload:path.join(projectRoot,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});if(process.platform!=='darwin')mainWindow.setMenuBarVisibility(false);mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));attachNavigationHandlers(mainWindow.webContents,{validateUrl:url=>{if(new URL(url).origin!==origin)throw new Error('Only the local Pseudoharness origin may navigate the main window.');},onMainFrameStart:()=>{}});mainWindow.on('resize',applyBounds);mainWindow.on('maximize',()=>mainWindow.webContents.send('pseudoharness:window-state',true));mainWindow.on('unmaximize',()=>mainWindow.webContents.send('pseudoharness:window-state',false));mainWindow.on('closed',()=>{mainWindow=null;});await mainWindow.loadURL(origin);if(process.env.PSEUDOHARNESS_SMOKE_TEST==='1'){const smokeUrl=process.env.PSEUDOHARNESS_SMOKE_URL;if(smokeUrl){const [smokeTab]=addTab(smokeUrl,'main');tabs.get(smokeTab.id)?.view.webContents.once('did-finish-load',()=>void session.fromPartition(partition).cookies.flushStore().finally(()=>app.quit()));}else app.quit();}}
  catch(error){console.error(error);if(error instanceof Error&&error.code==='STATE_DIRECTORY_IN_USE')dialog.showErrorBox('Pseudoharness is already running',error.message);else if(error instanceof Error&&error.code==='STATE_OWNER_UNAVAILABLE')dialog.showErrorBox('Pseudoharness could not use local state',error.message);process.exitCode=1;app.quit();}
});
app.on('before-quit',()=>{if(annotationTimer)clearInterval(annotationTimer);for(const tab of tabs.values())try{tab.view.webContents.close();}catch{}tabs.clear();backend?.kill();});
app.on('window-all-closed',()=>app.quit());
