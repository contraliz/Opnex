function createTrayController({ Tray, Menu, image, openWindow, quitApp }) {
  let tray;
  let menu;

  function open() {
    return openWindow();
  }

  function start() {
    if (tray && !tray.isDestroyed()) return tray;

    tray = new Tray(image);
    tray.setToolTip('Pseudoharness');
    menu = Menu.buildFromTemplate([
      { label: 'Open Pseudoharness', click: open },
      { type: 'separator' },
      { label: 'Quit', click: () => { void quitApp(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', open);
    tray.on('double-click', open);
    return tray;
  }

  function destroy() {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = undefined;
  }

  return { start, open, destroy, getTray: () => tray, getMenu: () => menu };
}

module.exports = { createTrayController };
