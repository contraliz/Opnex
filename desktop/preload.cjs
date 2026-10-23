const { contextBridge, ipcRenderer } = require('electron');

const bridge={
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
    onEvent:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('pseudoharness:browser-event',listener);return()=>ipcRenderer.removeListener('pseudoharness:browser-event',listener);},
  },
};
if(process.env.PSEUDOHARNESS_INTERACTION_TEST==='1')bridge.interactionTest={state:()=>ipcRenderer.invoke('pseudoharness:interaction-state'),resize:size=>ipcRenderer.invoke('pseudoharness:interaction-resize',size)};
contextBridge.exposeInMainWorld('pseudoharnessDesktop',Object.freeze(bridge));
