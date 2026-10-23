const { app, BrowserWindow, WebContentsView, session, ipcMain, utilityProcess } = require('electron');
const { createServer } = require('node:net');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { assignTabToPane, removeTabFromPanes } = require('./pane-state.cjs');

const partition = 'persist:pseudoharness-browser-v1';
const projectRoot=path.resolve(__dirname,'..');
let mainWindow;
let backend;
let backendExitCode=null;
let origin;
let bounds={main:null,side:null,chat:null};
let assignments={main:null,side:null,chat:null};
let tabSequence=0;
const tabs=new Map();

if(process.env.PSEUDOHARNESS_ELECTRON_DATA_DIR){const userData=path.resolve(process.env.PSEUDOHARNESS_ELECTRON_DATA_DIR);mkdirSync(userData,{recursive:true});app.setPath('userData',userData);}

function pickPort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
function validAppSender(event){try{return !!mainWindow&&event.sender===mainWindow.webContents&&new URL(event.senderFrame?.url).origin===origin;}catch{return false;}}
function requireAppSender(event){if(!validAppSender(event))throw new Error('Only the local Pseudoharness window may control browser tabs.');}
function normalizeUrl(input){let url;try{url=new URL(input);}catch{throw new Error('Enter a complete website URL.');}if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('Only HTTP and HTTPS browser addresses are supported.');if(url.username||url.password)throw new Error('URLs that contain credentials are not accepted.');return url.toString();}
function state(){return [...tabs.values()].map(tab=>({id:tab.id,url:tab.view.webContents.getURL()||tab.url,title:tab.title||tab.view.webContents.getTitle()||tab.url,pane:assignments.chat===tab.id?'chat':assignments.side===tab.id?'side':assignments.main===tab.id?'main':'hidden',loading:tab.view.webContents.isLoading()}));}
function sendEvent(type,tab){if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('pseudoharness:browser-event',{type,tabs:state(),...(tab?{tab:{id:tab.id,url:tab.url,title:tab.title}}:{})});}
function applyBounds(){for(const tab of tabs.values()){const pane=panesFor(tab.id);const rect=pane?bounds[pane]:null;tab.view.setBounds(rect&&rect.width>0&&rect.height>0?rect:{x:0,y:0,width:0,height:0});}}
function panesFor(id){return ['main','side','chat'].find(pane=>assignments[pane]===id)||null;}
function activate(id,pane='main'){const tab=tabs.get(id);if(!tab)throw new Error('Browser tab no longer exists.');assignments=assignTabToPane(assignments,id,pane);tab.pane=pane;applyBounds();sendEvent('selected',tab);return state();}
function addTab(rawUrl,pane='main'){
  const url=normalizeUrl(rawUrl);const id=`browser-${++tabSequence}`;const browserSession=session.fromPartition(partition,{cache:true});
  const view=new WebContentsView({webPreferences:{session:browserSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
  const tab={id,url,title:url,view};tabs.set(id,tab);
  view.webContents.setWindowOpenHandler(({url:opened})=>{try{addTab(opened,'main');}catch{}return {action:'deny'};});
  view.webContents.on('will-navigate',(event,next)=>{try{normalizeUrl(next);}catch{event.preventDefault();}});
  view.webContents.on('will-redirect',(event,next)=>{try{normalizeUrl(next);}catch{event.preventDefault();}});
  view.webContents.on('page-title-updated',(_event,title)=>{tab.title=title.slice(0,180);tab.url=view.webContents.getURL()||tab.url;sendEvent('updated',tab);});
  view.webContents.on('did-navigate',(_event,next)=>{tab.url=next;sendEvent('updated',tab);});
  view.webContents.on('did-navigate-in-page',(_event,next)=>{tab.url=next;sendEvent('updated',tab);});
  view.webContents.on('did-fail-load',(_event,code,description,isMainFrame)=>{if(isMainFrame){tab.title=`Could not load page (${code})`;sendEvent('failed',tab);}});
  mainWindow.contentView.addChildView(view);activate(id,pane);void view.webContents.loadURL(url).catch(()=>{});return state();
}
function closeTab(id){const tab=tabs.get(id);if(!tab)return state();mainWindow.contentView.removeChildView(tab.view);tab.view.webContents.close();tabs.delete(id);const wasMain=assignments.main===id;assignments=removeTabFromPanes(assignments,id);if(wasMain)assignments.main=[...tabs.keys()].find(key=>key!==assignments.side&&key!==assignments.chat)||null;applyBounds();return state();}

async function startBackend(){const port=await pickPort();origin=`http://127.0.0.1:${port}`;const launcher=path.join(projectRoot,'bin','pseudoharness.js');const data=path.join(app.getPath('userData'),'local-state');const backendEnv={...process.env,NODE_ENV:'production',PORT:String(port),PSEUDOHARNESS_DATA_DIR:data,PSEUDOHARNESS_DESKTOP:'1'};backend=utilityProcess.fork(launcher,[],{cwd:app.getPath('userData'),env:backendEnv,stdio:process.env.PSEUDOHARNESS_SMOKE_TEST==='1'?'inherit':'ignore',serviceName:'Pseudoharness local backend'});backend.once('error',error=>console.error('Pseudoharness backend failed to start:',error.message));backend.once('exit',code=>{backendExitCode=code;});
  const deadline=Date.now()+20_000;while(Date.now()<deadline){if(backendExitCode!==null)throw new Error('Pseudoharness backend exited during startup.');try{const response=await fetch(`${origin}/api/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Pseudoharness backend did not become ready.');}

function registerIpc(){
  ipcMain.handle('pseudoharness:browser-list',event=>{requireAppSender(event);return state();});
  ipcMain.handle('pseudoharness:browser-open',(event,payload)=>{requireAppSender(event);return addTab(payload?.url,payload?.pane);});
  ipcMain.handle('pseudoharness:browser-select',(event,payload)=>{requireAppSender(event);return activate(payload?.id,payload?.pane);});
  ipcMain.handle('pseudoharness:browser-side',(event,id)=>{requireAppSender(event);return activate(id,'side');});
  ipcMain.handle('pseudoharness:browser-main',(event,id)=>{requireAppSender(event);return activate(id,'main');});
  ipcMain.handle('pseudoharness:browser-chat',(event,id)=>{requireAppSender(event);return activate(id,'chat');});
  ipcMain.handle('pseudoharness:browser-undock',(event,id)=>{requireAppSender(event);return activate(id,'main');});
  ipcMain.handle('pseudoharness:browser-close',(event,id)=>{requireAppSender(event);return closeTab(id);});
  ipcMain.handle('pseudoharness:browser-navigate',(event,payload)=>{requireAppSender(event);const tab=tabs.get(payload?.id);if(!tab)throw new Error('Browser tab no longer exists.');if(payload.action==='back'&&tab.view.webContents.canGoBack())tab.view.webContents.goBack();else if(payload.action==='forward'&&tab.view.webContents.canGoForward())tab.view.webContents.goForward();else if(payload.action==='reload')tab.view.webContents.reload();return state();});
  ipcMain.handle('pseudoharness:browser-bounds',(event,value)=>{requireAppSender(event);for(const pane of ['main','side','chat']){const r=value?.[pane];bounds[pane]=r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>=0&&r.height>=0?{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,mainWindow.getContentSize()[0]),height:Math.min(r.height,mainWindow.getContentSize()[1])}:null;}applyBounds();});
  ipcMain.handle('pseudoharness:browser-hide',event=>{requireAppSender(event);bounds={main:null,side:null,chat:null};applyBounds();});
  ipcMain.handle('pseudoharness:browser-clear-data',async event=>{requireAppSender(event);await session.fromPartition(partition).clearStorageData();await session.fromPartition(partition).clearCache();for(const tab of tabs.values())try{tab.view.webContents.reload();}catch{}return true;});
}

app.whenReady().then(async()=>{
  try{await startBackend();await session.fromPartition(partition).setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));registerIpc();mainWindow=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:620,backgroundColor:'#141414',show:process.env.PSEUDOHARNESS_SMOKE_TEST!=='1',webPreferences:{preload:path.join(projectRoot,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});if(process.platform!=='darwin')mainWindow.setMenuBarVisibility(false);mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));mainWindow.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==origin)event.preventDefault();}catch{event.preventDefault();}});mainWindow.on('resize',applyBounds);mainWindow.on('closed',()=>{mainWindow=null;});await mainWindow.loadURL(origin);if(process.env.PSEUDOHARNESS_SMOKE_TEST==='1'){const smokeUrl=process.env.PSEUDOHARNESS_SMOKE_URL;if(smokeUrl){const [smokeTab]=addTab(smokeUrl,'main');tabs.get(smokeTab.id)?.view.webContents.once('did-finish-load',()=>void session.fromPartition(partition).cookies.flushStore().finally(()=>app.quit()));}else app.quit();}}
  catch(error){console.error(error);process.exitCode=1;app.quit();}
});
app.on('before-quit',()=>{for(const tab of tabs.values())try{tab.view.webContents.close();}catch{}tabs.clear();backend?.kill();});
app.on('window-all-closed',()=>app.quit());
