import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'opnex-electron-annotation-'));
const repo=path.join(temp,'fixture-repo');const data=path.join(temp,'electron-data');const output=process.env.OPNEX_ELECTRON_OUTPUT||process.env.PSEUDOHARNESS_ELECTRON_OUTPUT?path.resolve(process.env.OPNEX_ELECTRON_OUTPUT||process.env.PSEUDOHARNESS_ELECTRON_OUTPUT):await mkdtemp(path.join(os.tmpdir(),'opnex-electron-annotation-evidence-'));
const keepAppOpen=(process.env.OPNEX_ELECTRON_KEEP_OPEN||process.env.PSEUDOHARNESS_ELECTRON_KEEP_OPEN)==='1';
let emulatedViewport=false;
await mkdir(repo,{recursive:true});await mkdir(path.join(data,'local-state'),{recursive:true});await mkdir(output,{recursive:true});
const git=(args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore',windowsHide:true});
function cdp(target){let id=0;const pending=new Map();const socket=new WebSocket(target.webSocketDebuggerUrl);return new Promise((resolve,reject)=>{socket.addEventListener('open',()=>resolve({socket,send(method,params={}){const callId=++id;return new Promise((done,fail)=>{pending.set(callId,{done,fail});socket.send(JSON.stringify({id:callId,method,params}));});},close(){socket.close();}}));socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const item=pending.get(message.id);if(!item)return;pending.delete(message.id);if(message.error)item.fail(new Error(message.error.message));else item.done(message.result);});socket.addEventListener('error',reject);});}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(read,condition,label,timeout=25_000){const end=Date.now()+timeout;let lastError;while(Date.now()<end){try{const value=await read();if(condition(value))return value;}catch(error){lastError=error;}if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error(`Electron exited with code ${child.exitCode} while waiting for ${label}.`);await sleep(200);}throw new Error(`Timed out waiting for ${label}.${lastError?` Last error: ${lastError}`:''}`);}
async function resizeApp(client,width,height){
  const targetWidth=Math.max(720,width),targetHeight=Math.max(620,height);
  const emulate=async()=>{await client.send('Emulation.setDeviceMetricsOverride',{width:targetWidth,height:targetHeight,deviceScaleFactor:1,mobile:false});emulatedViewport=true;await waitFor(()=>evalValue(client,'innerWidth'),value=>value===targetWidth,`${width}×${height}px emulated Electron viewport`,3000);};
  if(emulatedViewport&&width<1440){await emulate();await sleep(100);return;}
  if(emulatedViewport){await client.send('Emulation.clearDeviceMetricsOverride');emulatedViewport=false;}
  await evalValue(client,`window.opnexDesktop.interactionTest.resize({width:${width},height:${height}})`);
  try{await waitFor(()=>evalValue(client,'({width:innerWidth,height:innerHeight})'),value=>value.width===targetWidth&&Math.abs(value.height-targetHeight)<=3,`${width}×${height}px Electron viewport`,2000);}
  catch{await emulate();}
  await sleep(100);
}
async function evalValue(client,expression){const result=await client.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Renderer evaluation failed.');return result.result?.value;}
async function saveScreenshot(client,name){const capture=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,name),Buffer.from(capture.data,'base64'));}
async function measureSessionLayout(client,label){
  const value=await evalValue(client,`(()=>{
    const rect=element=>{if(!element)return null;const box=element.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,top:box.top,bottom:box.bottom,height:box.height};};
    const content=document.querySelector('.workspace-content');
    const visible=[...content.querySelectorAll('.pane-body[data-tab-kind="session"]:not([hidden])')];
    const panes=visible.map(body=>{
      const bodyRect=body.getBoundingClientRect(),conversation=body.querySelector('.conversation'),composer=body.querySelector(':scope > .composer-dock .composer, .new-tab-center .composer'),newTabCenter=body.querySelector('.new-tab-center');
      const convRect=conversation?.getBoundingClientRect(),style=conversation?getComputedStyle(conversation):null,paddingLeft=parseFloat(style?.paddingLeft)||0,paddingRight=parseFloat(style?.paddingRight)||0;
      const contentCenter=convRect?convRect.left+conversation.clientLeft+paddingLeft+(conversation.clientWidth-paddingLeft-paddingRight)/2:null;
      const readingChildren=conversation?[...conversation.children].map(element=>{const box=element.getBoundingClientRect();return {className:typeof element.className==='string'?element.className:element.tagName.toLowerCase(),rect:rect(element),centerError:contentCenter===null?null:Math.abs((box.left+box.right)/2-contentCenter)}}):[];
      const paneCenter=(bodyRect.left+bodyRect.right)/2,composerRect=composer?.getBoundingClientRect(),newTabRect=newTabCenter?.getBoundingClientRect();
      const overflowDescendants=[body,...body.querySelectorAll('*')].filter(element=>element.scrollWidth>element.clientWidth+2).map(element=>({className:typeof element.className==='string'?element.className:element.tagName.toLowerCase(),scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,rect:rect(element),marginLeft:getComputedStyle(element).marginLeft,minWidth:getComputedStyle(element).minWidth,whiteSpace:getComputedStyle(element).whiteSpace}));
      return {rect:rect(body),kind:body.dataset.tabKind,tab:body.dataset.workspaceTab,hasConversation:!!conversation,readingChildren,overflowDescendants,composer:rect(composer),newTabCenter:rect(newTabCenter),composerCenterError:composerRect?Math.abs((composerRect.left+composerRect.right)/2-paneCenter):null,newTabCenterError:newTabRect?Math.abs((newTabRect.left+newTabRect.right)/2-paneCenter):null,horizontalOverflow:Math.max(0,body.scrollWidth-body.clientWidth,conversation?conversation.scrollWidth-conversation.clientWidth:0)};
    });
    const shell=document.querySelector('.app-shell'),sidebar=document.querySelector('.sidebar'),workspaceArea=document.querySelector('.workspace-area'),workspaceRect=content.getBoundingClientRect(),shellRect=shell.getBoundingClientRect(),areaRect=workspaceArea.getBoundingClientRect();
    const shellStyle=getComputedStyle(shell);
    return {viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},sidebarCollapsed:shell.classList.contains('sidebar-collapsed'),shell:{left:shellRect.left,width:shellRect.width,columns:shellStyle.gridTemplateColumns,inline:shell.getAttribute('style'),sidebarWidthVar:shellStyle.getPropertyValue('--sidebar-width'),transition:shellStyle.transition,animations:shell.getAnimations().map(animation=>({playState:animation.playState,currentTime:animation.currentTime}))},sidebarWidth:sidebar.getBoundingClientRect().width,workspaceArea:{left:areaRect.left,width:areaRect.width},workspace:{left:workspaceRect.left,right:workspaceRect.right,width:workspaceRect.width,center:(workspaceRect.left+workspaceRect.right)/2,scrollWidth:Math.max(0,content.scrollWidth-content.clientWidth)},panes};
  })()`);
  return {label,...value};
}
async function waitForSessionLayout(client,label,condition){
  let last;
  try{return await waitFor(async()=>{last=await measureSessionLayout(client,label);return last;},condition,label,5000);}
  catch(error){throw new Error(`${error.message} Last observed layout: ${JSON.stringify(last)}`);}
}
function assertSessionLayout(layout){
  if(layout.workspace.scrollWidth>1||layout.viewport.scrollWidth>layout.viewport.width+1)throw new Error(`${layout.label}: workspace overflowed horizontally (${JSON.stringify(layout)}).`);
  for(const pane of layout.panes){
    if(pane.horizontalOverflow>1)throw new Error(`${layout.label}: session pane overflowed horizontally (${JSON.stringify(pane)}).`);
    if(pane.composerCenterError!==null&&pane.composerCenterError>2)throw new Error(`${layout.label}: composer is off-center (${JSON.stringify(pane)}).`);
    if(pane.newTabCenterError!==null&&pane.newTabCenterError>2)throw new Error(`${layout.label}: empty-session content is off-center (${JSON.stringify(pane)}).`);
    for(const child of pane.readingChildren)if(child.centerError!==null&&child.centerError>2)throw new Error(`${layout.label}: ${child.className} is off-center in its conversation (${JSON.stringify(child)}).`);
  }
}
async function checkPassUsageTooltip(client,label){
  const target=await evalValue(client,`(()=>{const datum=document.querySelector('.pane-body[data-tab-kind="session"]:not([hidden]) .pass-usage-datum'),body=datum?.closest('.pane-body');if(!body||!datum)return {error:'pass usage datum missing'};datum.scrollIntoView({block:'center',behavior:'instant'});const button=datum.getBoundingClientRect();return {x:button.left+button.width/2,y:button.top+button.height/2};})()`);
  if(target.error)throw new Error(`${label}: ${target.error}.`);
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});await sleep(120);
  const tooltip=await evalValue(client,`(()=>{const datum=document.querySelector('.pane-body[data-tab-kind="session"]:not([hidden]) .pass-usage-datum'),body=datum?.closest('.pane-body'),element=datum?.querySelector('.pass-usage-tooltip');if(!body||!element)return {error:'pass usage tooltip missing'};const b=body.getBoundingClientRect(),t=element.getBoundingClientRect(),style=getComputedStyle(element);return {visibility:style.visibility,left:t.left,right:t.right,width:t.width,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,pane:{left:b.left,right:b.right}}})()`);
  if(tooltip.error||tooltip.visibility!=='visible'||tooltip.left<tooltip.pane.left-1||tooltip.right>tooltip.pane.right+1||tooltip.scrollWidth>tooltip.clientWidth+1)throw new Error(`${label}: pass usage tooltip escapes its narrow pane (${JSON.stringify(tooltip)}).`);
  await evalValue(client,"document.querySelector('.pane-body[data-tab-kind=\\\"session\\\"]:not([hidden]) .pass-usage-datum')?.closest('.conversation')?.scrollTo({top:0,behavior:'instant'});true");
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  return tooltip;
}
async function measureNativeBrowser(client){
  return await evalValue(client,`(async()=>{const shell=document.querySelector('.app-shell'),host=document.querySelector('.native-browser-page'),state=await window.pseudoharnessDesktop.interactionTest.state(),rect=host?.getBoundingClientRect(),style=getComputedStyle(shell);return {viewport:{width:innerWidth,height:innerHeight},sidebarCollapsed:shell.classList.contains('sidebar-collapsed'),transition:style.transition,transitionDuration:style.transitionDuration,transitionProperty:style.transitionProperty,transitioning:shell.getAnimations().some(animation=>animation.transitionProperty==='grid-template-columns'&&animation.playState==='running'),host:rect?{left:rect.left,top:rect.top,width:rect.width,height:rect.height}:null,browser:state.map(item=>({id:item.id,url:item.url,pane:item.pane,workspaceId:item.workspaceId,bounds:item.bounds}))}})()`);
}
async function captureSidebarTransition(client,fixtureUrl,label,startCollapsed=false){
  const sample=()=>Promise.race([measureNativeBrowser(client),sleep(2500).then(()=>{throw new Error(`${label}: native bounds IPC did not return within 2.5 seconds.`);})]);
  const before=await sample();
  if(before.sidebarCollapsed!==startCollapsed)throw new Error(`${label}: sidebar transition began in the wrong state (${before.sidebarCollapsed?'collapsed':'expanded'}).`);
  const started=await evalValue(client,`(()=>{const shell=document.querySelector('.app-shell');document.querySelector('.rail-toggle').click();return {transition:getComputedStyle(shell).transition,transitionDuration:getComputedStyle(shell).transitionDuration,transitionProperty:getComputedStyle(shell).transitionProperty}})()`);
  await sleep(80);const middle=await sample();
  await sleep(80);const late=await sample();
  await sleep(160);const after=await sample();
  const frames=[middle,late,after],values=[before.host.width,...frames.map(item=>item.host.width)],minWidth=Math.min(...values),maxWidth=Math.max(...values);
  const hasIntermediate=frames.slice(0,2).some(item=>item.host.width>minWidth+2&&item.host.width<maxWidth-2);
  const misaligned=frames.filter(item=>{const browser=item.browser.find(candidate=>candidate.url.startsWith(fixtureUrl))?.bounds;return !browser||Math.abs(browser.x-item.host.left)>4||Math.abs(browser.y-item.host.top)>4||Math.abs(browser.width-item.host.width)>4||Math.abs(browser.height-item.host.height)>4;});
  const trace={label,before,started,frames,minWidth,maxWidth,maxBoundsError:Math.max(0,...frames.map(item=>{const browser=item.browser.find(candidate=>candidate.url.startsWith(fixtureUrl))?.bounds;return browser?Math.max(Math.abs(browser.x-item.host.left),Math.abs(browser.y-item.host.top),Math.abs(browser.width-item.host.width),Math.abs(browser.height-item.host.height)):Infinity;}))};
  if(!started.transition.includes('grid-template-columns')||!started.transitionDuration.split(',').some(value=>parseFloat(value)>0)||!middle.transitioning||!late.transitioning||after.sidebarCollapsed===startCollapsed||!hasIntermediate||after.transitioning||misaligned.length)throw new Error(`${label}: animated sidebar or native BrowserView tracking failed (${JSON.stringify({...trace,misaligned})}).`);
  return trace;
}
async function hoverFixtureSessionActions(client,label){
  const point=await evalValue(client,`(()=>{const row=[...document.querySelectorAll('.session-row')].find(item=>item.textContent.includes('Fixture review session'));if(!row)return null;const box=row.getBoundingClientRect();return {x:box.left+Math.min(70,box.width/2),y:box.top+box.height/2}})()`);
  if(!point)throw new Error(`${label}: fixture session row is not visible.`);
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});await sleep(40);
  const visible=await evalValue(client,`(()=>{const button=document.querySelector('.session-row .session-actions-trigger[aria-label="Actions for Fixture review session"]');return !!button&&getComputedStyle(button).opacity==='1'&&button.getBoundingClientRect().width>0})()`);
  if(!visible)throw new Error(`${label}: hovering the visible session row did not reveal its actions button.`);
}
async function dragSidebar(client,fixtureUrl,delta,label){
  const point=()=>evalValue(client,"(()=>{const separator=document.querySelector('.sidebar-resizer');if(!separator)return null;const box=separator.getBoundingClientRect();return {x:box.left+box.width/2,y:Math.max(30,box.height/2),width:parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--sidebar-width'))}})()");
  const moveTo=async(targetWidth,step)=>{
    const origin=await point();
    if(!origin||origin.width<=0)throw new Error(`${label}: sidebar resizer is not available in the expanded state.`);
    const shift=targetWidth-origin.width;
    await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:origin.x,y:origin.y});
    await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:origin.x,y:origin.y,button:'left',buttons:1});
    const active=await waitFor(()=>evalValue(client,"document.querySelector('.app-shell').classList.contains('sidebar-resizing')"),Boolean,`${label} ${step} resize start`);
    const activeTransition=await evalValue(client,"getComputedStyle(document.querySelector('.app-shell')).transition");
    if(!active||activeTransition!=='none')throw new Error(`${label}: pointer resizing did not suppress toggle animation while following the pointer (${activeTransition}).`);
    await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:origin.x+shift,y:origin.y,button:'left',buttons:1});
    await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:origin.x+shift,y:origin.y,button:'left',buttons:0});
    const width=await waitFor(()=>evalValue(client,"({width:parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--sidebar-width')),resizing:document.querySelector('.app-shell').classList.contains('sidebar-resizing')})"),state=>!state.resizing&&Math.abs(state.width-targetWidth)<2,`${label} ${step} resize endpoint`);
    const browser=await waitFor(()=>measureNativeBrowser(client),state=>{const item=state.browser.find(candidate=>candidate.url.startsWith(fixtureUrl));return !state.sidebarCollapsed&&item&&Math.abs(item.bounds.x-state.host.left)<3&&Math.abs(item.bounds.width-state.host.width)<3;},`${label} ${step} native browser bounds`);
    return {width:width.width,host:browser.host,browser:browser.browser.find(item=>item.url.startsWith(fixtureUrl)).bounds};
  };
  const initial=await point();
  if(!initial||initial.width<=0)throw new Error(`${label}: sidebar resizer is not available in the expanded state.`);
  const resized=await moveTo(initial.width+delta,'drag');
  const restored=await moveTo(initial.width,'restore');
  return {label,delta,initialWidth:initial.width,resized,restored};
}
async function measureIconCenters(client,label){
  const icons=await evalValue(client,`(()=>{
    const selector='.activity-rail button,.sidebar-tools .icon-btn,.session-row .session-actions-trigger,.document-tabs .tab-close,.document-tabs .new-tab,.session-pane-actions button,.send-btn,[data-heads-up-panel] .heads-up-close,[data-heads-up-panel] .heads-up-thread-open,[data-heads-up-panel] .heads-up-thread-id-row > button';
    return [...document.querySelectorAll(selector)].filter(button=>button.getClientRects().length&&getComputedStyle(button).visibility!=='hidden'&&Number(getComputedStyle(button).opacity)>.01).flatMap(button=>{const svg=button.querySelector(':scope > svg');if(!svg)return [];const box=button.getBoundingClientRect(),icon=svg.getBoundingClientRect();return [{label:button.getAttribute('aria-label')||button.className,width:box.width,height:box.height,padding:getComputedStyle(button).padding,x:Math.abs((box.left+box.right-icon.left-icon.right)/2),y:Math.abs((box.top+box.bottom-icon.top-icon.bottom)/2)}]});
  })()`);
  const disclosure=await evalValue(client,`(()=>[...document.querySelectorAll('[data-heads-up-panel] .heads-up-disclosure-trigger')].filter(button=>button.getClientRects().length).map(button=>{const box=button.getBoundingClientRect(),icon=button.querySelector(':scope > svg').getBoundingClientRect();return {label:button.textContent.trim(),height:box.height,iconY:Math.abs((box.top+box.bottom-icon.top-icon.bottom)/2),iconRightGap:box.right-icon.right,expanded:button.getAttribute('aria-expanded')}}))()`);
  if(!icons.length||icons.some(icon=>icon.x>1||icon.y>1||icon.width<22||icon.height<22||!icon.label))throw new Error(`${label}: an icon-only control is misaligned, undersized, or unlabeled (${JSON.stringify({icons,disclosure})}).`);
  if(disclosure.some(item=>item.iconY>1||item.iconRightGap<0))throw new Error(`${label}: a disclosure chevron is misaligned or outside its hit target (${JSON.stringify(disclosure)}).`);
  return {label,icons,disclosure};
}
async function measureHeadsUp(client,label){
  const value=await evalValue(client,`(()=>{const panel=document.querySelector('[data-heads-up-panel]'),section=panel?.querySelector('.heads-up-token-section'),total=section?.querySelector('.heads-up-token-total > strong'),grid=section?.querySelector('.heads-up-token-breakdown'),box=section?.getBoundingClientRect(),panelStyle=panel?getComputedStyle(panel):null;return {panel:panel?{left:panel.getBoundingClientRect().left,right:panel.getBoundingClientRect().right,width:panel.getBoundingClientRect().width,opacity:parseFloat(panelStyle.opacity),transform:panelStyle.transform}:null,section:box?{width:box.width,scrollWidth:section.scrollWidth,clientWidth:section.clientWidth}:null,total:total?{text:total.textContent,fontSize:getComputedStyle(total).fontSize,rect:(()=>{const r=total.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})()}:null,columns:grid?getComputedStyle(grid).gridTemplateColumns.trim().split(/\\s+/).length:0,roles:grid?[...grid.children].map(item=>{const label=item.querySelector('b'),value=item.querySelector('span > span'),a=label.getBoundingClientRect(),b=value.getBoundingClientRect();return {label:label.textContent,value:value.textContent,labelRight:a.right,valueLeft:b.left,valueRight:b.right,within:grid.getBoundingClientRect().right>=b.right-1}}):[],overflow:panel?Math.max(0,panel.scrollWidth-panel.clientWidth,section?.scrollWidth-section?.clientWidth||0):0};})()`);
  const report={label,...value};
  if(report.total?.text!=='14,549 tokens'||report.total.fontSize!=='14px')throw new Error(`${label}: token total is missing or not compact 14px text (${JSON.stringify(report)}).`);
  if(report.overflow>1||report.section.scrollWidth>report.section.clientWidth+1)throw new Error(`${label}: token section overflows (${JSON.stringify(report)}).`);
  const expectedColumns=report.section.width<=260?1:2;
  if(report.columns!==expectedColumns)throw new Error(`${label}: expected ${expectedColumns} aligned token columns at ${report.section.width}px (${JSON.stringify(report)}).`);
  if(report.roles.some(role=>role.valueRight>report.panel.right-8||!role.within))throw new Error(`${label}: a token role/value escapes the panel (${JSON.stringify(report)}).`);
  return report;
}
async function measureGitGraph(client,label){
  const value=await evalValue(client,`(()=>{const graph=document.querySelector('.git-commit-graph'),svg=graph?.querySelector('.git-graph-lines'),svgRect=svg?.getBoundingClientRect(),rows=[...document.querySelectorAll('.git-commit-row')],connectors=[...(graph?.querySelectorAll('.git-graph-lines .git-commit-connector')||[])],edges=[...(graph?.querySelectorAll('.git-graph-lines .first-parent-edge,.git-graph-lines .merge-edge,.git-graph-lines .external-edge')||[])];return {viewportWidth:innerWidth,columnGap:parseFloat(getComputedStyle(rows[0]||document.body).columnGap)||0,count:rows.length,rows:rows.map(row=>{const box=row.getBoundingClientRect(),node=row.querySelector('.git-graph-space i'),nodeBox=node?.getBoundingClientRect(),nodeStyle=node?getComputedStyle(node):null;return {left:box.left,right:box.right,top:box.top,height:box.height,hash:row.querySelector(':scope > code')?.title||'',subject:row.querySelector('.git-commit-copy strong')?.textContent||'',laneLeft:node?.style.left||'',node:nodeBox?{left:nodeBox.left,top:nodeBox.top,width:nodeBox.width,height:nodeBox.height,transform:nodeStyle.transform,animationName:nodeStyle.animationName}:null}}),connectors:connectors.map((path,index)=>{const row=rows[index],node=row?.querySelector('.git-graph-space i'),text=row?.querySelector('.git-commit-copy'),nodeBox=node?.getBoundingClientRect(),textBox=text?.getBoundingClientRect(),box=path.getBBox(),style=getComputedStyle(path),coords=path.getAttribute('d')?.match(/^M ([\\d.]+) ([\\d.]+) H ([\\d.]+)$/);return {d:path.getAttribute('d'),startX:coords?Number(coords[1]):null,endX:coords?Number(coords[3]):null,stroke:style.stroke,strokeWidth:parseFloat(style.strokeWidth),opacity:parseFloat(style.opacity),startError:nodeBox&&svgRect?Math.abs(nodeBox.left+nodeBox.width/2-(svgRect.left+box.x)):null,centerError:nodeBox&&svgRect?Math.abs(nodeBox.top+nodeBox.height/2-(svgRect.top+box.y)):null,endGap:textBox&&svgRect?textBox.left-(svgRect.left+box.x+box.width):null}}),edgePaths:edges.map(path=>({className:path.getAttribute('class'),d:path.getAttribute('d')})),graphHeight:graph?.getBoundingClientRect().height||0,rowHeight:parseFloat(getComputedStyle(graph||document.body).getPropertyValue('--git-graph-row-height'))||0,mergeEdges:document.querySelectorAll('.git-graph-lines .merge-edge').length,externalEdges:document.querySelectorAll('.git-graph-lines .external-edge').length,externalLabels:document.querySelectorAll('.git-external-parent').length,hasCommitGlyph:!!document.querySelector('.git-commit-row .commit-glyph'),animationName:getComputedStyle(rows[0]||document.body).animationName,filter:document.querySelector('.git-filter input')?.value||''};})()`);
  return {label,...value};
}
function assertGitConnectors(graph,label){
  if(graph.connectors.length!==graph.count||graph.hasCommitGlyph)throw new Error(`${label}: expected one SVG connector per commit and no duplicate commit glyph (${JSON.stringify({count:graph.count,connectors:graph.connectors.length,hasCommitGlyph:graph.hasCommitGlyph})}).`);
  const expectedGap=graph.columnGap-5;
  for(let index=0;index<graph.connectors.length;index++){
    const connector=graph.connectors[index],nodeX=parseFloat(graph.rows[index].laneLeft),match=connector.d?.match(/^M ([\d.]+) ([\d.]+) H ([\d.]+)$/);
    if(!match||Math.abs(Number(match[1])-nodeX)>0.01||connector.startError>1||connector.centerError>1||Math.abs(connector.endGap-expectedGap)>1||connector.strokeWidth<1||connector.opacity<0.6)throw new Error(`${label}: connector does not visibly join the node toward commit text (${JSON.stringify({row:graph.rows[index],connector,expectedGap})}).`);
  }
}
async function checkBrowserToolbar(client,label){const result=await evalValue(client,`(()=>{const form=document.querySelector('.native-browser-address'),toolbar=document.querySelector('.native-browser-toolbar');if(!form||!toolbar)return {error:'native browser address form missing'};const rect=element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,display:getComputedStyle(element).display};};const nav=form.querySelector('.native-browser-nav'),input=form.querySelector('input'),go=form.querySelector('.native-browser-go'),comment=toolbar.querySelector('[aria-label="Commenting"]'),clear=toolbar.querySelector('[aria-label="Clear local browser data"]');return {toolbar:rect(toolbar),form:rect(form),nav:rect(nav),input:rect(input),go:rect(go),comment:rect(comment),commentLabel:rect(comment.querySelector('span')),clear:rect(clear),commentName:comment.getAttribute('aria-label'),commentText:getComputedStyle(comment.querySelector('span')).display}})()`);if(result.error)throw new Error(`${label}: ${result.error}`);const visible=[result.nav,result.input,result.go,result.comment,result.clear].filter(item=>item.display!=='none'&&item.width>0).sort((a,b)=>a.left-b.left);for(let index=0;index<visible.length;index++){if(visible[index].left<result.toolbar.left-1||visible[index].right>result.toolbar.right+1)throw new Error(`${label}: toolbar control escapes its container (${JSON.stringify(result)}).`);if(index&&visible[index-1].right>visible[index].left+0.5)throw new Error(`${label}: toolbar controls overlap (${JSON.stringify(result)}).`);}if(result.nav.width<60||result.input.width<48||result.comment.width<30||result.clear.width<30||result.commentName!=='Commenting')throw new Error(`${label}: toolbar hit area/accessibility failed (${JSON.stringify(result)}).`);if(result.commentText!=='none'&&(result.commentLabel.left<result.comment.left||result.commentLabel.right>result.comment.right))throw new Error(`${label}: Commenting label overflows its button (${JSON.stringify(result)}).`);return result;}
let child;let fixtureServer;let appClient;let pageClient;
try{
  git(['init','--quiet','-b','main']);git(['config','user.name','Fixture User']);git(['config','user.email','fixture@example.invalid']);
  await writeFile(path.join(repo,'base.txt'),'base\n');git(['add','base.txt']);git(['commit','--quiet','-m','base commit']);
  git(['branch','feature']);git(['checkout','--quiet','feature']);await writeFile(path.join(repo,'feature.txt'),'feature\n');git(['add','feature.txt']);git(['commit','--quiet','-m','feature divergence']);
  git(['checkout','--quiet','main']);
  for(let index=0;index<105;index++){const name=`history-${String(index).padStart(3,'0')}.txt`;await writeFile(path.join(repo,name),`History fixture commit ${index}.\n`);git(['add',name]);git(['commit','--quiet','-m',`history pass ${String(index).padStart(3,'0')}`]);}
  git(['merge','--quiet','--no-ff','feature','-m','merge feature']);
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim();const refs=Array.from({length:205},(_,index)=>`update refs/heads/branch-${String(index).padStart(3,'0')} ${head}\n`).join('');execFileSync('git',['update-ref','--stdin'],{cwd:repo,input:refs,stdio:['pipe','ignore','ignore'],windowsHide:true});
  const linked=path.join(temp,'linked-worktree');git(['worktree','add','--quiet',linked,'feature']);
  const now=new Date().toISOString();
  const receipt={status:'complete',result:'Fixture integration receipt.',changes:[],acceptance:{met:[],unmet:[]},verification:[],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null};
  const tokenUsage=(threadId,totalTokens)=>({threadId,tokenStatus:'available',tokens:{totalTokens,inputTokens:totalTokens-10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:10,reasoningOutputTokens:0,modelContextWindow:null,source:'thread'},creditStatus:'unavailable',allowance:{fiveHourPercent:null,weeklyPercent:null}});
  const projectId='11111111-1111-4111-8111-111111111111';
  const project={id:projectId,name:path.basename(repo),projectRoot:repo,needsLocation:false,pinned:false,createdAt:now,updatedAt:now};
  const pass={id:'fixture-pass',index:1,createdAt:now,userInput:'Review fixture',userInputs:['Review fixture'],userMessageIds:['fixture-message'],phase:'accepted',resolution:'delegated',executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},receipt,correctionCount:0,processedTurns:[],orchestratorThreadId:'fixture-orchestrator',workerThreadId:'fixture-worker',usage:{orchestrator:tokenUsage('fixture-orchestrator',7649),worker:tokenUsage('fixture-worker',6900)},gitDiff:{status:'recorded',source:'codex-turn-diff',updatedAt:now,turns:[{threadId:'fixture-worker',turnId:'fixture-turn',role:'worker',capturedAt:now,diff:'diff --git a/fixture.txt b/fixture.txt\n+rendered pass diff fixture\n'}]}};
  const task={id:'fixture-browser-task',projectId,title:'Fixture review session',phase:'accepted',createdAt:now,updatedAt:now,userRoot:repo,currentPassId:pass.id,resolution:'delegated',receipt,orchestratorThreadId:'fixture-orchestrator',workerThreadId:'fixture-worker',userMessages:['Review a harmless local fixture page.'],messages:[{id:'fixture-message',role:'user',text:'Review fixture',createdAt:now,passId:pass.id}],passes:[pass],correctionCount:0,processedTurns:[]};
  await writeFile(path.join(data,'local-state','state.json'),JSON.stringify({version:5,revision:0,settings:{orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low',approvalPolicy:'on-request',executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},deepseekProvider:'opencode-go',deepseekModel:'deepseek-v4.1-flash',deepseekReasoningEffort:'max'},tasks:[task],activeTaskId:task.id,projects:[project],selectedProjectId:projectId,expandedProjectIds:[projectId,'unclassified']}));
  fixtureServer=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Local annotation fixture</title><main><h1 id="annotation-target">Fixture target heading</h1><p>Harmless local fixture text for annotation testing.</p><button id="fixture-button">Fixture click target</button></main><style>body{font:22px sans-serif;background:#fff;color:#111;margin:48px}main{max-width:820px;margin:auto;padding:24px;border:1px solid #aaa}button{padding:12px}</style>');});
  await new Promise((resolve,reject)=>{fixtureServer.once('error',reject);fixtureServer.listen(0,'127.0.0.1',resolve);});const fixtureUrl=`http://127.0.0.1:${fixtureServer.address().port}/page`;
  const portServer=net.createServer();await new Promise((resolve,reject)=>{portServer.once('error',reject);portServer.listen(0,'127.0.0.1',resolve);});const cdpPort=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const electronExecutable=path.join(root,'node_modules','electron','dist',process.platform==='win32'?'electron.exe':'electron');child=spawn(electronExecutable,[path.join(root,'desktop','main.cjs')],{cwd:root,env:{...process.env,OPNEX_ELECTRON_DATA_DIR:data,PSEUDOHARNESS_ELECTRON_DATA_DIR:data,OPNEX_INTERACTION_TEST:'1',PSEUDOHARNESS_INTERACTION_TEST:'1',OPNEX_CDP_PORT:String(cdpPort),PSEUDOHARNESS_CDP_PORT:String(cdpPort)},stdio:keepAppOpen?'ignore':'inherit',windowsHide:true});if(keepAppOpen)child.unref();
  const targets=async()=>{const response=await fetch(`http://127.0.0.1:${cdpPort}/json/list`);return response.ok?response.json():[];};
  const list=await waitFor(targets,value=>value.some(target=>target.type==='page'&&target.url.startsWith('http://127.0.0.1:')),'Electron DevTools page');
  const appTarget=list.find(target=>target.type==='page'&&!target.url.includes(`/page`));appClient=await cdp(appTarget);await appClient.send('Runtime.enable');await appClient.send('Page.bringToFront');
  await waitFor(()=>evalValue(appClient,'document.body.innerText'),text=>text.includes('Fixture review session'),'fixture task in Electron');
  await waitFor(()=>evalValue(appClient,"!!document.querySelector('.pass-panel')"),Boolean,'fixture pass panel');
  await evalValue(appClient,"[...document.querySelectorAll('.disclosure-head')].find(button=>button.textContent.includes('Run receipt')).click(); true");await waitFor(()=>evalValue(appClient,"!!document.querySelector('.receipt-git-toggle')"),Boolean,'pass-scoped Git diff receipt');
  await evalValue(appClient,"document.querySelector('.receipt-git-toggle').click(); true");await waitFor(()=>evalValue(appClient,"document.querySelector('.receipt-git-panel')?.innerText||''"),text=>text.includes('fixture.txt'),'rendered pass diff file');
  await evalValue(appClient,"document.querySelector('[aria-label=Browser]').click(); true");await sleep(700);
  await waitFor(()=>evalValue(appClient,"!!document.querySelector('.native-browser-address[role=search] [aria-label=\"Website address\"]')"),Boolean,'browser address bar');
  await resizeApp(appClient,1280,800);await checkBrowserToolbar(appClient,'1280px toolbar');await saveScreenshot(appClient,'electron-browser-toolbar-1280.png');
  await resizeApp(appClient,900,620);checkBrowserToolbar(appClient,'900px toolbar');await saveScreenshot(appClient,'electron-browser-toolbar-900.png');
  await resizeApp(appClient,1280,800);
  await evalValue(appClient,`(()=>{const input=document.querySelector('[aria-label="Website address"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,${JSON.stringify(fixtureUrl)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.closest('form').requestSubmit();return true})()`);
  const pageTargets=await waitFor(targets,value=>value.some(target=>target.type==='page'&&target.url.startsWith(fixtureUrl)),'fixture browser page');const pageTarget=pageTargets.find(target=>target.type==='page'&&target.url.startsWith(fixtureUrl));pageClient=await cdp(pageTarget);await pageClient.send('Runtime.enable');
  await waitFor(()=>evalValue(pageClient,'document.title'),title=>title==='Local annotation fixture','fixture page title');
  await saveScreenshot(pageClient,'electron-annotation-target.png');
  checkBrowserToolbar(appClient,'loaded 1280px toolbar');await saveScreenshot(appClient,'electron-browser-toolbar-1280.png');await resizeApp(appClient,900,620);checkBrowserToolbar(appClient,'loaded 900px toolbar');await saveScreenshot(appClient,'electron-browser-toolbar-900.png');await resizeApp(appClient,1280,800);
  await checkBrowserToolbar(appClient,'embedded browser after fixture navigation');await saveScreenshot(appClient,'electron-browser-toolbar-peer.png');
  if(emulatedViewport){await appClient.send('Emulation.clearDeviceMetricsOverride');emulatedViewport=false;}
  await evalValue(appClient,'window.pseudoharnessDesktop.interactionTest.resize({width:1440,height:960})');
  await waitFor(()=>evalValue(appClient,'({width:innerWidth,height:innerHeight})'),value=>value.width===1440&&Math.abs(value.height-960)<=3,'native 1440×960 browser-bounds viewport',5000);await sleep(250);
  if(emulatedViewport)throw new Error('Native BrowserView bounds must be checked without CDP viewport emulation.');
  const sidebarCollapsed=await evalValue(appClient,"document.querySelector('.app-shell').classList.contains('sidebar-collapsed')");if(sidebarCollapsed){await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");await waitFor(()=>evalValue(appClient,"document.querySelector('.app-shell').classList.contains('sidebar-collapsed')"),value=>value===false,'browser sidebar expanded');}
  const nativeBrowserBeforeSidebar=await measureNativeBrowser(appClient);
   const sidebarCollapseTrace=await captureSidebarTransition(appClient,fixtureUrl,'native browser sidebar collapse');
  const nativeBrowserCollapsed=await waitFor(()=>measureNativeBrowser(appClient),state=>{const item=state.browser.find(browser=>browser.url.startsWith(fixtureUrl));return state.sidebarCollapsed&&state.host.width>nativeBrowserBeforeSidebar.host.width+100&&item&&Math.abs(item.bounds.x-state.host.left)<3&&Math.abs(item.bounds.width-state.host.width)<3;},'native BrowserView bounds after sidebar collapse');
  const collapsedBrowserCheck=nativeBrowserCollapsed.browser.find(item=>item.url.startsWith(fixtureUrl));if(nativeBrowserCollapsed.host.width<=nativeBrowserBeforeSidebar.host.width+100||!collapsedBrowserCheck||Math.abs(collapsedBrowserCheck.bounds.x-nativeBrowserCollapsed.host.left)>3||Math.abs(collapsedBrowserCheck.bounds.width-nativeBrowserCollapsed.host.width)>3)throw new Error(`Native BrowserView bounds did not follow sidebar collapse (${JSON.stringify({nativeBrowserBeforeSidebar,nativeBrowserCollapsed})}).`);
  await saveScreenshot(appClient,'electron-browser-explorer-collapsed-native-1440.png');
   const sidebarExpandTrace=await captureSidebarTransition(appClient,fixtureUrl,'native browser sidebar reopen',true);
  const nativeBrowserExpanded=await waitFor(()=>measureNativeBrowser(appClient),state=>{const item=state.browser.find(browser=>browser.url.startsWith(fixtureUrl));return !state.sidebarCollapsed&&Math.abs(state.host.width-nativeBrowserBeforeSidebar.host.width)<2&&item&&Math.abs(item.bounds.x-state.host.left)<3&&Math.abs(item.bounds.width-state.host.width)<3;},'native BrowserView bounds after sidebar reopen');
  const expandedBrowser=nativeBrowserExpanded.browser.find(item=>item.url.startsWith(fixtureUrl)),collapsedBrowser=collapsedBrowserCheck;
  if(!nativeBrowserExpanded.host||!nativeBrowserCollapsed.host||!expandedBrowser||!collapsedBrowser||nativeBrowserCollapsed.host.width<=nativeBrowserExpanded.host.width+100||collapsedBrowser.bounds.width<=expandedBrowser.bounds.width+100)throw new Error(`Native Browser bounds did not expand with the closed explorer (${JSON.stringify({nativeBrowserExpanded,nativeBrowserCollapsed})}).`);
  if(Math.abs((collapsedBrowser.bounds.width-expandedBrowser.bounds.width)-(nativeBrowserCollapsed.host.width-nativeBrowserExpanded.host.width))>4)throw new Error(`Native BrowserView width did not track the reflowing host (${JSON.stringify({nativeBrowserExpanded,nativeBrowserCollapsed})}).`);
  if(Math.abs(nativeBrowserBeforeSidebar.host.width-nativeBrowserExpanded.host.width)>2||Math.abs(expandedBrowser.bounds.width-nativeBrowserExpanded.host.width)>3)throw new Error(`Native BrowserView did not return to its expanded-explorer width (${JSON.stringify({nativeBrowserBeforeSidebar,nativeBrowserExpanded})}).`);
   await appClient.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   const reducedSidebarDuration=await evalValue(appClient,"getComputedStyle(document.querySelector('.app-shell')).transitionDuration");
   if(reducedSidebarDuration.split(',').some(value=>parseFloat(value)>.001))throw new Error(`Reduced-motion preference left sidebar motion active (${reducedSidebarDuration}).`);
   await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");
   const reducedMotionCollapsed=await waitFor(()=>measureNativeBrowser(appClient),state=>{const item=state.browser.find(browser=>browser.url.startsWith(fixtureUrl));return state.sidebarCollapsed&&item&&Math.abs(item.bounds.x-state.host.left)<3&&Math.abs(item.bounds.width-state.host.width)<3;},'reduced-motion native browser sidebar collapse');
   await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");
   const reducedMotionExpanded=await waitFor(()=>measureNativeBrowser(appClient),state=>{const item=state.browser.find(browser=>browser.url.startsWith(fixtureUrl));return !state.sidebarCollapsed&&item&&Math.abs(item.bounds.x-state.host.left)<3&&Math.abs(item.bounds.width-state.host.width)<3;},'reduced-motion native browser sidebar reopen');
   await appClient.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   const sidebarDragTrace=await dragSidebar(appClient,fixtureUrl,64,'native sidebar resize');
  await evalValue(appClient,"document.querySelector('[aria-label=\"Commenting\"]').click(); true");
  await waitFor(()=>evalValue(appClient,"document.querySelector('[aria-label=\"Commenting\"]')?.getAttribute('aria-pressed')"),value=>value==='true','annotation mode');
  await evalValue(pageClient,"document.querySelector('#annotation-target').click(); true");
  await waitFor(()=>evalValue(appClient,"!!document.querySelector('.browser-annotation textarea')"),Boolean,'native annotation form');
  const geometry=await evalValue(appClient,"(()=>{const form=document.querySelector('.browser-annotation').getBoundingClientRect();const host=document.querySelector('.native-browser-page').getBoundingClientRect();return {form:{top:form.top,bottom:form.bottom,left:form.left,right:form.right},host:{top:host.top,bottom:host.bottom,left:host.left,right:host.right}}})()");
  const nativeState=await evalValue(appClient,'window.pseudoharnessDesktop.interactionTest.state()');const browserState=nativeState.find(item=>item.url.startsWith(fixtureUrl));if(!browserState?.annotationOverlay)throw new Error('Electron did not reserve browser space for the annotation form.');
  if(geometry.form.top<geometry.host.top+browserState.bounds.height-2)throw new Error(`Annotation form intersects the native browser surface: ${JSON.stringify({geometry,browserState})}`);
  await saveScreenshot(appClient,'electron-annotation.png');
  await evalValue(appClient,"document.querySelector('.browser-annotation textarea').focus(); true");await appClient.send('Input.insertText',{text:'Please inspect this exact heading.'});
  await evalValue(appClient,"document.querySelector('.browser-annotation button[type=submit]').click(); true");
  const draft=await waitFor(()=>evalValue(appClient,"document.querySelector('[aria-label=\"Task message\"]')?.innerText||document.querySelector('[aria-label=\"Task message\"]')?.textContent||''"),value=>value.includes('Please inspect this exact heading.'),'annotation in task composer');
  await waitFor(()=>evalValue(appClient,"document.querySelector('.tab-error')?.textContent||''"),text=>text.includes('Browser annotation added to this session draft.'),'annotation notice');
  await evalValue(appClient,"document.querySelector('.tab-error button[aria-label=\"Dismiss session error\"]')?.click(); true");
  await waitFor(()=>evalValue(appClient,"!document.querySelector('.tab-error')"),Boolean,'annotation notice dismissed');
  if(!draft.includes('Fixture target heading')||!draft.includes('User comment: Please inspect this exact heading.'))throw new Error(`Annotation was not routed into the unsent task draft: ${draft}`);
  const settings=await readFile(path.join(data,'local-state','state.json'),'utf8');if(settings.includes('Fixture target heading')||settings.includes('cookie'))throw new Error('Annotation or browser cookie data unexpectedly appeared in persisted task state.');
  await evalValue(appClient,"document.querySelector('[aria-label=Git]').click(); true");
  await waitFor(()=>evalValue(appClient,"document.querySelector('[aria-label=Git]')?.getAttribute('aria-current')==='page'"),Boolean,'Git workspace selected');await waitFor(()=>evalValue(appClient,"!!document.querySelector('.git-workspace')"),Boolean,'native Git overview');await waitFor(()=>evalValue(appClient,"document.querySelector('.git-view-tabs button[aria-current=page]')?.textContent.includes('Overview')"),Boolean,'overview selected');await sleep(500);await saveScreenshot(appClient,'electron-git-overview.png');
  await evalValue(appClient,"[...document.querySelectorAll('.git-view-tabs button')].find(button=>button.textContent.includes('Branches')).click(); true");await waitFor(()=>evalValue(appClient,"document.querySelector('.git-view-tabs button[aria-current=page]')?.textContent.includes('Branches')"),Boolean,'branches selected');await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-branch-row').length"),value=>value===100,'branch page');await saveScreenshot(appClient,'electron-git-branches.png');
  await evalValue(appClient,"[...document.querySelectorAll('.git-view-tabs button')].find(button=>button.textContent.includes('Worktrees')).click(); true");await waitFor(()=>evalValue(appClient,"document.querySelector('.git-view-tabs button[aria-current=page]')?.textContent.includes('Worktrees')"),Boolean,'worktrees selected');await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-worktree-row').length"),value=>value>=2,'worktree list');await saveScreenshot(appClient,'electron-git-worktrees.png');
  await evalValue(appClient,"[...document.querySelectorAll('.git-view-tabs button')].find(button=>button.textContent.includes('History')).click(); true");await waitFor(()=>evalValue(appClient,"document.querySelector('.git-view-tabs button[aria-current=page]')?.textContent.includes('History')"),Boolean,'history selected');await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-commit-row').length"),value=>value===100,'first history page');await sleep(250);await saveScreenshot(appClient,'electron-git-history.png');
  const firstGraph=await measureGitGraph(appClient,'first 100 commits');if(firstGraph.externalEdges<1||firstGraph.externalLabels<1||firstGraph.rowHeight!==50||firstGraph.animationName!=='none')throw new Error(`Initial graph topology, fixed row sizing, or restrained motion failed (${JSON.stringify({...firstGraph,rows:firstGraph.rows.slice(0,3)})}).`);assertGitConnectors(firstGraph,'wide history');
  const mergeTop=firstGraph.rows.find(row=>row.subject==='merge feature');if(!mergeTop)throw new Error(`Merge commit was not visible on the first page (${JSON.stringify(firstGraph.rows.slice(0,3))}).`);
  const mergeElement=await evalValue(appClient,"(()=>{const row=[...document.querySelectorAll('.git-commit-row')].find(item=>item.querySelector('.git-commit-copy strong')?.textContent==='merge feature'),node=row?.querySelector('.git-graph-space i');if(!row||!node)return null;const r=row.getBoundingClientRect(),n=node.getBoundingClientRect(),x=n.left+n.width/2,y=n.top+n.height/2;return {x,y,top:r.top,left:r.left,right:r.right,height:r.height,lane:node.style.left,hitTarget:document.elementFromPoint(x,y)?.tagName}})()");
  if(!mergeElement||mergeElement.hitTarget!=='I')throw new Error(`The graph dot did not receive the hover pointer (${JSON.stringify(mergeElement)}).`);
  await appClient.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:mergeElement.x,y:mergeElement.y});await sleep(180);
  const hoveredGraph=await measureGitGraph(appClient,'hovered merge dot');assertGitConnectors(hoveredGraph,'hovered history');const baselineDot=firstGraph.rows[0],hoveredDot=hoveredGraph.rows[0];if(Math.abs(hoveredDot.top-mergeElement.top)>0.5||Math.abs(hoveredDot.left-mergeElement.left)>0.5||Math.abs(hoveredDot.right-mergeElement.right)>0.5||hoveredDot.laneLeft!==mergeElement.lane||hoveredDot.height!==50||JSON.stringify(hoveredDot.node)!==JSON.stringify(baselineDot.node)||JSON.stringify(hoveredGraph.edgePaths)!==JSON.stringify(firstGraph.edgePaths)||hoveredGraph.connectors[0].d!==firstGraph.connectors[0].d)throw new Error(`Dot hover moved the node or changed its branch paths/connector (${JSON.stringify({mergeElement,baselineDot,hoveredDot,edgesUnchanged:JSON.stringify(hoveredGraph.edgePaths)===JSON.stringify(firstGraph.edgePaths)})}).`);
  await saveScreenshot(appClient,'electron-git-history-dot-hover.png');
  await evalValue(appClient,"(()=>{const input=document.querySelector('.git-history-view .git-filter input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'history pass 100');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-commit-row').length"),value=>value===1,'filtered history row');
  const filteredGraph=await measureGitGraph(appClient,'filtered history');const filteredCommit=filteredGraph.rows[0],originalCommit=firstGraph.rows.find(row=>row.hash===filteredCommit.hash);
  const originalIndex=firstGraph.rows.findIndex(row=>row.hash===filteredCommit.hash);assertGitConnectors(filteredGraph,'filtered history');if(!originalCommit||filteredCommit.laneLeft!==originalCommit.laneLeft||filteredGraph.connectors[0].startX!==firstGraph.connectors[originalIndex]?.startX||filteredGraph.externalEdges<1)throw new Error(`Filtering shifted a node/connector lane or did not mark its hidden parent as external (${JSON.stringify({filteredGraph,originalCommit})}).`);
  await saveScreenshot(appClient,'electron-git-history-filtered.png');
  await evalValue(appClient,"(()=>{const input=document.querySelector('.git-history-view .git-filter input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-commit-row').length"),value=>value===100,'history filter cleared');
  await evalValue(appClient,"[...document.querySelectorAll('.git-load-more')].find(button=>button.textContent.includes('Load next 100 commits')).click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.git-commit-row').length"),value=>value===108,'older commits loaded');
  const loadedGraph=await measureGitGraph(appClient,'loaded older history');
  if(loadedGraph.externalEdges!==0||loadedGraph.mergeEdges<1)throw new Error(`Loading older history did not resolve external parent edges (${JSON.stringify({...loadedGraph,rows:loadedGraph.rows.slice(0,3)})}).`);
  assertGitConnectors(loadedGraph,'loaded older history');for(let index=0;index<firstGraph.rows.length;index++){const row=firstGraph.rows[index],loadedIndex=loadedGraph.rows.findIndex(item=>item.hash===row.hash),loaded=loadedGraph.rows[loadedIndex];if(!loaded||loaded.laneLeft!==row.laneLeft||loaded.top!==row.top||loaded.height!==50||loadedGraph.connectors[loadedIndex]?.startX!==firstGraph.connectors[index]?.startX)throw new Error(`History paging moved or resized a previously visible commit or connector (${JSON.stringify({row,loaded})}).`);}
  await saveScreenshot(appClient,'electron-git-history-paged.png');
  await resizeApp(appClient,900,620);
  const narrowGraph=await measureGitGraph(appClient,'900px history');
  assertGitConnectors(narrowGraph,'900px narrow history');if(narrowGraph.rows.some(row=>row.height!==50)||Math.abs(narrowGraph.graphHeight-narrowGraph.count*50)>1)throw new Error(`Narrow history rows no longer align with the SVG graph grid (${JSON.stringify({graphHeight:narrowGraph.graphHeight,rowHeight:narrowGraph.rowHeight,firstRows:narrowGraph.rows.slice(0,3)})}).`);
  await saveScreenshot(appClient,'electron-git-history-narrow.png');
  await resizeApp(appClient,720,620);
  const compactGraph=await measureGitGraph(appClient,'720px compact history');assertGitConnectors(compactGraph,'720px compact history');
  if(compactGraph.viewportWidth>720||compactGraph.rows.some(row=>row.height!==50)||Math.abs(compactGraph.graphHeight-compactGraph.count*50)>1)throw new Error(`Compact history rows or connectors no longer align with the SVG graph grid (${JSON.stringify({viewportWidth:compactGraph.viewportWidth,graphHeight:compactGraph.graphHeight,rowHeight:compactGraph.rowHeight,firstRows:compactGraph.rows.slice(0,3)})}).`);
  await saveScreenshot(appClient,'electron-git-history-720.png');
  await appClient.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});const reducedMotion=await evalValue(appClient,"getComputedStyle(document.querySelector('.git-commit-row')).animationDuration");if(reducedMotion!=='0s')throw new Error(`Reduced-motion preference did not disable Git row animation: ${reducedMotion}`);await appClient.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evalValue(appClient,"document.querySelector('[aria-label=Sessions]').click();true");
  const sessionTabsBefore=await evalValue(appClient,"document.querySelectorAll('.document-tab').length");
  await evalValue(appClient,"document.querySelector('.document-tabs .new-tab').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.document-tab').length"),value=>value>sessionTabsBefore,'new session tab');
  await evalValue(appClient,"(()=>{const source=document.querySelector('[data-session-tab=fixture-browser-task]'),target=document.querySelector('.workspace-content'),dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX:target.getBoundingClientRect().right-4}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:target.getBoundingClientRect().right-4}));return true})()");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.pane-grid-group').length"),value=>value===2,'split session pane');
  const sessionLayouts=[];
  for(const [width,height] of [[2048,1106],[1440,960],[1024,760],[900,760]]){
    await resizeApp(appClient,width,height);
    let current=await measureSessionLayout(appClient,`${width}px before sidebar close`);
    if(current.sidebarCollapsed){await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");await sleep(260);}
    const expanded=await measureSessionLayout(appClient,`${width}px sidebar expanded`);assertSessionLayout(expanded);
    if(width===900)await checkPassUsageTooltip(appClient,'900px sidebar expanded');
    await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");
    const collapsed=await waitForSessionLayout(appClient,`${width}px sidebar collapsed`,layout=>layout.sidebarCollapsed&&layout.shell.animations.length===0&&layout.workspace.width>expanded.workspace.width+100);assertSessionLayout(collapsed);
    if(width===2048||width===900)await saveScreenshot(appClient,`electron-session-reflow-${width}-collapsed.png`);
    if(collapsed.workspace.width<expanded.workspace.width+100)throw new Error(`${width}px sidebar close did not release workspace width (${JSON.stringify({expanded,collapsed})}).`);
    await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");
    const reopened=await waitForSessionLayout(appClient,`${width}px sidebar reopened`,layout=>!layout.sidebarCollapsed&&layout.shell.animations.length===0&&Math.abs(layout.workspace.width-expanded.workspace.width)<2);assertSessionLayout(reopened);
    if(Math.abs(reopened.workspace.width-expanded.workspace.width)>2)throw new Error(`${width}px explorer reopen did not restore the layout (${JSON.stringify({expanded:expanded.workspace,reopened:reopened.workspace})}).`);
    sessionLayouts.push({requestedWindowWidth:width,viewport:reopened.viewport,emulated:emulatedViewport,expanded:expanded.workspace.width,collapsed:collapsed.workspace.width,reopened:reopened.workspace.width,panes:collapsed.panes.map(pane=>({tab:pane.tab,width:pane.rect.width,composerCenterError:pane.composerCenterError,newTabCenterError:pane.newTabCenterError}))});
  }
  await resizeApp(appClient,2048,1106);
  await evalValue(appClient,"document.querySelector('[data-workspace-tab=fixture-browser-task] .heads-up-toggle').click();true");
  await waitFor(()=>evalValue(appClient,"(()=>{const panel=document.querySelector('[data-heads-up-panel]');return panel?.getAttribute('aria-hidden')==='false'&&panel.classList.contains('is-visible')&&panel.getBoundingClientRect().width>300})()"),Boolean,'normal-width Heads-up panel entrance');await sleep(220);
   const headsUpNormal=await measureHeadsUp(appClient,'2048px Heads-up panel');
   await evalValue(appClient,"(()=>{const button=[...document.querySelectorAll('[data-heads-up-panel] .heads-up-disclosure-trigger')].find(item=>item.textContent.trim().startsWith('Current sessions'));if(!button)throw new Error('Current sessions disclosure missing');if(button.getAttribute('aria-expanded')!=='true')button.click();return true})()");
   await waitFor(()=>evalValue(appClient,"[...document.querySelectorAll('[data-heads-up-panel] .heads-up-disclosure-trigger')].find(item=>item.textContent.trim().startsWith('Current sessions'))?.getAttribute('aria-expanded')"),value=>value==='true','wide Heads-up current sessions disclosure');
   await hoverFixtureSessionActions(appClient,'wide expanded explorer');
   const wideIconGeometry=await measureIconCenters(appClient,'wide expanded explorer and Heads-up panel');await saveScreenshot(appClient,'electron-heads-up-normal-2048.png');
  await evalValue(appClient,"document.querySelector('[data-heads-up-panel] .heads-up-close').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelector('[data-heads-up-panel]')?.getAttribute('aria-hidden')==='true'"),Boolean,'Heads-up closed');
  await resizeApp(appClient,1440,960);
  const rootTabsBefore=await evalValue(appClient,"document.querySelectorAll('.pane-grid-group')[0]?.querySelectorAll('.document-tab').length||0");
  await evalValue(appClient,"(()=>{const root=document.querySelectorAll('.pane-grid-group')[0];root.querySelector('.new-tab').click();return true})()");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.pane-grid-group')[0]?.querySelectorAll('.document-tab').length"),value=>value>rootTabsBefore,'second root draft tab');
  await evalValue(appClient,"(()=>{const groups=document.querySelectorAll('.pane-grid-group'),source=groups[0].querySelector('.document-tab[data-session-tab^=\"new:\"]'),target=groups[1].querySelector('.pane-body'),dataTransfer=new DataTransfer(),rect=target.getBoundingClientRect();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:rect.left+rect.width*.75,clientY:rect.top+100}));return true})()");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.pane-grid-group').length"),value=>value===3,'three session pane layout');
  const narrowPanes=await measureSessionLayout(appClient,'1440px three-pane layout');assertSessionLayout(narrowPanes);
  const narrowTaskPane=narrowPanes.panes.find(pane=>pane.tab==='fixture-browser-task');if(!narrowTaskPane||narrowTaskPane.rect.width>300)throw new Error(`The narrow session pane was not constrained as expected (${JSON.stringify(narrowPanes.panes)}).`);
  await evalValue(appClient,"document.querySelector('[data-workspace-tab=fixture-browser-task] .heads-up-toggle').click();true");
  await waitFor(()=>evalValue(appClient,"(()=>{const panel=document.querySelector('[data-heads-up-panel]');return panel?.getAttribute('aria-hidden')==='false'&&panel.classList.contains('is-visible')&&panel.getBoundingClientRect().width>100})()"),Boolean,'narrow Heads-up panel entrance');await sleep(220);
   const headsUpNarrow=await measureHeadsUp(appClient,'three-pane Heads-up panel');if(headsUpNarrow.section.width>260||headsUpNarrow.columns!==1)throw new Error(`Narrow Heads-up layout did not use one aligned token column (${JSON.stringify(headsUpNarrow)}).`);
   await evalValue(appClient,"(()=>{const button=[...document.querySelectorAll('[data-heads-up-panel] .heads-up-disclosure-trigger')].find(item=>item.textContent.trim().startsWith('Current sessions'));if(!button)throw new Error('Current sessions disclosure missing');if(button.getAttribute('aria-expanded')!=='true')button.click();return true})()");
   await waitFor(()=>evalValue(appClient,"[...document.querySelectorAll('[data-heads-up-panel] .heads-up-disclosure-trigger')].find(item=>item.textContent.trim().startsWith('Current sessions'))?.getAttribute('aria-expanded')"),value=>value==='true','narrow Heads-up current sessions disclosure');
   await hoverFixtureSessionActions(appClient,'narrow expanded explorer');
   const narrowIconGeometry=await measureIconCenters(appClient,'narrow expanded explorer and Heads-up panel');await saveScreenshot(appClient,'electron-heads-up-narrow.png');
  await evalValue(appClient,"document.querySelector('[data-heads-up-panel] .heads-up-close').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelector('[data-heads-up-panel]')?.getAttribute('aria-hidden')==='true'"),Boolean,'narrow Heads-up closed');
  const narrowSideWidth=narrowTaskPane.rect.width;
  await evalValue(appClient,"document.querySelectorAll('.pane-grid-group')[2].querySelector('.tab-close').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.pane-grid-group').length"),value=>value===2,'empty split removed');
  const twoPaneAfterRemoval=await measureSessionLayout(appClient,'after removing the narrow empty pane');assertSessionLayout(twoPaneAfterRemoval);
  const widerTaskPane=twoPaneAfterRemoval.panes.find(pane=>pane.tab==='fixture-browser-task');
  if(!widerTaskPane||widerTaskPane.rect.width<narrowSideWidth+60)throw new Error(`Removing a split did not release the remaining session pane width (${JSON.stringify({narrowSideWidth,widerTaskPane})}).`);
  await evalValue(appClient,"document.querySelector('[data-workspace-tab=fixture-browser-task] .tab-close').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelectorAll('.pane-grid-group').length"),value=>value===1,'final side session tab closed');
  const singlePane=await measureSessionLayout(appClient,'after closing the final side pane');assertSessionLayout(singlePane);
  if(singlePane.panes.length!==1||singlePane.panes[0].rect.width<1000)throw new Error(`The remaining session did not fill the workspace (${JSON.stringify(singlePane)}).`);
  await resizeApp(appClient,900,620);
  await evalValue(appClient,"document.querySelector('[aria-label=Settings]').click();true");
  await waitFor(()=>evalValue(appClient,"!!document.querySelector('[role=dialog][aria-labelledby=settings-title]')"),Boolean,'settings dialog');
  const settingsLayout=await evalValue(appClient,"(()=>{const dialog=document.querySelector('[role=dialog][aria-labelledby=settings-title]'),box=dialog.getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},dialog:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height,clientWidth:dialog.clientWidth,scrollWidth:dialog.scrollWidth,scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight}}})()");
  if(settingsLayout.dialog.left<0||settingsLayout.dialog.right>settingsLayout.viewport.width||settingsLayout.dialog.top<0||settingsLayout.dialog.bottom>settingsLayout.viewport.height||settingsLayout.dialog.scrollWidth>settingsLayout.dialog.clientWidth+1)throw new Error(`Settings dialog escaped the narrow viewport (${JSON.stringify(settingsLayout)}).`);
  await saveScreenshot(appClient,'electron-settings-900x620.png');
  await evalValue(appClient,"document.querySelector('[aria-label=\"Close settings\"]').click();true");
  await waitFor(()=>evalValue(appClient,"document.querySelector('.dialog-backdrop[data-open=false]')?.getAttribute('aria-hidden')==='true'"),Boolean,'settings closed');
  if(emulatedViewport){await appClient.send('Emulation.clearDeviceMetricsOverride');emulatedViewport=false;}
  await evalValue(appClient,'window.pseudoharnessDesktop.interactionTest.resize({width:1440,height:960})');
  await waitFor(()=>evalValue(appClient,'innerWidth'),value=>Math.abs(value-1426)<3,'native 1440×960 inspection window',5000);
  await sleep(500);
  await evalValue(appClient,"[...document.querySelectorAll('.session-row .task-nav')].find(button=>button.textContent.includes('Fixture review session'))?.click();true");
  await waitFor(()=>evalValue(appClient,"!!document.querySelector('[data-workspace-tab=fixture-browser-task]:not([hidden]) .conversation')"),Boolean,'final fixture session selected');
  await evalValue(appClient,"document.querySelector('.rail-toggle').click();true");await sleep(350);
  const finalSessionLayout=await measureSessionLayout(appClient,'final isolated inspection state');assertSessionLayout(finalSessionLayout);await saveScreenshot(appClient,'electron-final-session-sidebar-closed-native-1440.png');
  const actualTitle=await evalValue(appClient,'document.title');const currentSettings=JSON.parse(await readFile(path.join(data,'local-state','state.json'),'utf8')).settings;
  if(currentSettings.orchestratorModel!=='gpt-6.1-sol'||currentSettings.orchestratorEffort!=='low')throw new Error(`The isolated native check used unexpected orchestrator settings: ${JSON.stringify(currentSettings)}.`);
  console.log(`Electron interaction verified. Session reflow and collapse/reopen geometry: ${JSON.stringify(sessionLayouts)}; token HUD ${headsUpNormal.section.width}px/two columns at wide and ${headsUpNarrow.section.width}px/one column in a narrow split; sidebar motion ${JSON.stringify([sidebarCollapseTrace,sidebarExpandTrace].map(({label,transitionDuration,frames,minWidth,maxWidth,maxBoundsError})=>({label,transitionDuration,samples:frames.length,minWidth,maxWidth,maxBoundsError})))}; reduced-motion duration ${reducedSidebarDuration}, native widths ${reducedMotionCollapsed.host.width}px/${reducedMotionExpanded.host.width}px; direct resize ${JSON.stringify(sidebarDragTrace)}; icon boxes ${JSON.stringify({wide:wideIconGeometry.icons,narrow:narrowIconGeometry.icons})}; settings fit at 900×620. BrowserView host/bounds close and reopen at native ${nativeBrowserBeforeSidebar.viewport.width}×${nativeBrowserBeforeSidebar.viewport.height}; merge/filter/history pagination and row stability checked. Screenshots: ${output}.`);
  console.log(`Inspection state: title=${actualTitle}; pid=${child.pid}; rendererUrl=${appTarget.url}; CDP=127.0.0.1:${cdpPort}; appData=${data}; browserProfile=${path.join(data,'browser-profile')}; fixtureWorkspace=${repo}; settings=${currentSettings.orchestratorModel}/${currentSettings.orchestratorEffort}; appKeptOpen=${keepAppOpen}; emulatedViewport=${emulatedViewport}; innerWidth=${finalSessionLayout.viewport.width}; innerHeight=${finalSessionLayout.viewport.height}.`);
}catch(error){console.error(error);process.exitCode=1;}finally{
  pageClient?.close();appClient?.close();if(child&&!child.killed&&!keepAppOpen){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}if(fixtureServer)await new Promise(resolve=>fixtureServer.close(resolve));if(!keepAppOpen)await rm(temp,{recursive:true,force:true});
}
