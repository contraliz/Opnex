const { contextBridge, ipcRenderer } = require('electron');

const bridge={
  platform:process.platform,
  quit:()=>ipcRenderer.invoke('pseudoharness:app-quit'),
  windowControls:process.platform==='win32'?{
    minimize:()=>ipcRenderer.invoke('pseudoharness:window-minimize'),
    toggleMaximize:()=>ipcRenderer.invoke('pseudoharness:window-toggle-maximize'),
    close:()=>ipcRenderer.invoke('pseudoharness:window-close'),
    onState:callback=>{const listener=(_event,maximized)=>callback(maximized===true);ipcRenderer.on('pseudoharness:window-state',listener);return()=>ipcRenderer.removeListener('pseudoharness:window-state',listener);},
  }:undefined,
  openCodexThread:threadId=>ipcRenderer.invoke('pseudoharness:open-codex-thread',threadId),
  browser:{
    list:()=>ipcRenderer.invoke('pseudoharness:browser-list'),
    open:(url,pane='main')=>ipcRenderer.invoke('pseudoharness:browser-open',{url,pane}),
    select:(id,pane='main')=>ipcRenderer.invoke('pseudoharness:browser-select',{id,pane}),
    openSide:id=>ipcRenderer.invoke('pseudoharness:browser-side',id),
    openMain:id=>ipcRenderer.invoke('pseudoharness:browser-main',id),
    openChat:id=>ipcRenderer.invoke('pseudoharness:browser-chat',id),
    undock:id=>ipcRenderer.invoke('pseudoharness:browser-undock',id),
    close:id=>ipcRenderer.invoke('pseudoharness:browser-close',id),
    navigate:(id,action)=>ipcRenderer.invoke('pseudoharness:browser-navigate',{id,action}),
    setCommenting:(id,enabled)=>ipcRenderer.invoke('pseudoharness:browser-commenting',{id,enabled}),
    annotationOverlay:(id,visible)=>ipcRenderer.invoke('pseudoharness:browser-annotation-overlay',{id,visible}),
    setBounds:bounds=>ipcRenderer.invoke('pseudoharness:browser-bounds',bounds),
    hide:()=>ipcRenderer.invoke('pseudoharness:browser-hide'),
    clearData:()=>ipcRenderer.invoke('pseudoharness:browser-clear-data'),
    workspaceGet:workspaceId=>ipcRenderer.invoke('pseudoharness:browser-workspace-get',{workspaceId}),
    workspaceOpen:(workspaceId,url)=>ipcRenderer.invoke('pseudoharness:browser-workspace-open',{workspaceId,url}),
    workspaceRelease:workspaceId=>ipcRenderer.invoke('pseudoharness:browser-workspace-release',{workspaceId}),
    workspaceSetBounds:(workspaceId,bounds,active)=>ipcRenderer.invoke('pseudoharness:browser-workspace-bounds',{workspaceId,bounds,active}),
    workspaceNavigate:(workspaceId,navigation)=>ipcRenderer.invoke('pseudoharness:browser-workspace-navigate',{workspaceId,navigation}),
    workspaceSetCommenting:(workspaceId,enabled)=>ipcRenderer.invoke('pseudoharness:browser-workspace-commenting',{workspaceId,enabled}),
    workspaceAnnotationOverlay:(workspaceId,visible)=>ipcRenderer.invoke('pseudoharness:browser-workspace-annotation-overlay',{workspaceId,visible}),
    onEvent:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('pseudoharness:browser-event',listener);return()=>ipcRenderer.removeListener('pseudoharness:browser-event',listener);},
  },
};
if(process.env.OPNEX_INTERACTION_TEST==='1'||process.env.PSEUDOHARNESS_INTERACTION_TEST==='1')bridge.interactionTest={state:()=>ipcRenderer.invoke('pseudoharness:interaction-state'),resize:size=>ipcRenderer.invoke('pseudoharness:interaction-resize',size)};
// Preserve the prior bridge name for existing local clients and expose the current product name for new code.
const frozenBridge=Object.freeze(bridge);
contextBridge.exposeInMainWorld('opnexDesktop',frozenBridge);
contextBridge.exposeInMainWorld('pseudoharnessDesktop',frozenBridge);
