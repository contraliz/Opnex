const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pseudoharnessDesktop',Object.freeze({
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
    setBounds:bounds=>ipcRenderer.invoke('pseudoharness:browser-bounds',bounds),
    hide:()=>ipcRenderer.invoke('pseudoharness:browser-hide'),
    clearData:()=>ipcRenderer.invoke('pseudoharness:browser-clear-data'),
    onEvent:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('pseudoharness:browser-event',listener);return()=>ipcRenderer.removeListener('pseudoharness:browser-event',listener);},
  },
}));
