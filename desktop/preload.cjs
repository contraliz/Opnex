const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(`opnex:${channel}`, ...args);
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  const eventName = `opnex:${channel}`;
  ipcRenderer.on(eventName, listener);
  return () => ipcRenderer.removeListener(eventName, listener);
}

const bridge = {
  platform: process.platform,
  quit: () => invoke('app-quit'),
  windowControls: process.platform === 'win32' ? {
    minimize: () => invoke('window-minimize'),
    toggleMaximize: () => invoke('window-toggle-maximize'),
    close: () => invoke('window-close'),
    onState: callback => subscribe('window-state', maximized => callback(maximized === true)),
  } : undefined,
  openCodexThread: threadId => invoke('open-codex-thread', threadId),
  browser: {
    list: () => invoke('browser-list'),
    open: (url, pane = 'main') => invoke('browser-open', { url, pane }),
    select: (id, pane = 'main') => invoke('browser-select', { id, pane }),
    openSide: id => invoke('browser-side', id),
    openMain: id => invoke('browser-main', id),
    openChat: id => invoke('browser-chat', id),
    undock: id => invoke('browser-undock', id),
    close: id => invoke('browser-close', id),
    navigate: (id, action) => invoke('browser-navigate', { id, action }),
    setCommenting: (id, enabled) => invoke('browser-commenting', { id, enabled }),
    annotationOverlay: (id, visible) => invoke('browser-annotation-overlay', { id, visible }),
    setBounds: bounds => invoke('browser-bounds', bounds),
    hide: () => invoke('browser-hide'),
    clearData: () => invoke('browser-clear-data'),
    workspaceGet: workspaceId => invoke('browser-workspace-get', { workspaceId }),
    workspaceOpen: (workspaceId, url) => invoke('browser-workspace-open', { workspaceId, url }),
    workspaceRelease: workspaceId => invoke('browser-workspace-release', { workspaceId }),
    workspaceSetBounds: (workspaceId, bounds, active) => invoke('browser-workspace-bounds', { workspaceId, bounds, active }),
    workspaceNavigate: (workspaceId, navigation) => invoke('browser-workspace-navigate', { workspaceId, navigation }),
    workspaceSetCommenting: (workspaceId, enabled) => invoke('browser-workspace-commenting', { workspaceId, enabled }),
    workspaceAnnotationOverlay: (workspaceId, visible) => invoke('browser-workspace-annotation-overlay', { workspaceId, visible }),
    onEvent: callback => subscribe('browser-event', callback),
  },
};

if (process.env.OPNEX_INTERACTION_TEST === '1' || process.env.PSEUDOHARNESS_INTERACTION_TEST === '1') {
  bridge.interactionTest = {
    state: () => invoke('interaction-state'),
    resize: size => invoke('interaction-resize', size),
    focus: () => invoke('interaction-focus'),
  };
}

const frozenBridge = Object.freeze(bridge);
contextBridge.exposeInMainWorld('opnexDesktop', frozenBridge);
// Keep the old global name available to local integrations during the rename.
contextBridge.exposeInMainWorld('pseudoharnessDesktop', frozenBridge);
