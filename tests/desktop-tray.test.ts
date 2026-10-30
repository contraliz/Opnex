import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createTrayController } = require('../desktop/tray-controller.cjs') as {
  createTrayController: (options: any) => { start: () => any; open: () => void; destroy: () => void; getTray: () => any; getMenu: () => any };
};
const { stopOwnedKernel } = require('../desktop/kernel-shutdown.cjs') as { stopOwnedKernel: (options: any) => Promise<void> };

function trayHarness() {
  class FakeTray {
    events = new Map<string, () => void>();
    tooltip = '';
    menu: any;
    destroyed = false;
    constructor(readonly image: unknown) {}
    setToolTip(value: string) { this.tooltip = value; }
    setContextMenu(value: unknown) { this.menu = value; }
    on(name: string, callback: () => void) { this.events.set(name, callback); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const openWindow = vi.fn();
  const quitApp = vi.fn(async () => {});
  const controller = createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items: any[]) => items },
    image: 'brand-mark',
    openWindow,
    quitApp,
  });
  return { controller, openWindow, quitApp };
}

describe('desktop system tray', () => {
  it('creates one branded tray with Open and Quit actions', () => {
    const { controller } = trayHarness();
    const tray = controller.start();
    expect(controller.start()).toBe(tray);
    expect(tray.tooltip).toBe('Opnex');
    expect(tray.image).toBe('brand-mark');
    expect(controller.getMenu().map((item: any) => item.label ?? item.type)).toEqual(['Open Opnex', 'separator', 'Quit']);
  });

  it('routes tray clicks and Open to the same window restore callback', () => {
    const { controller, openWindow } = trayHarness();
    const tray = controller.start();
    tray.events.get('click')();
    tray.events.get('double-click')();
    tray.menu[0].click();
    controller.open();
    expect(openWindow).toHaveBeenCalledTimes(4);
  });

  it('routes Quit to the shell lifecycle and destroys the tray once', async () => {
    const { controller, quitApp } = trayHarness();
    const tray = controller.start();
    tray.menu[2].click();
    await Promise.resolve();
    expect(quitApp).toHaveBeenCalledTimes(1);
    controller.destroy();
    controller.destroy();
    expect(tray.destroyed).toBe(true);
  });
});

describe('managed kernel shutdown', () => {
  function response(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it('does not contact an independently attached kernel', async () => {
    const fetchImpl = vi.fn();
    const waitForBackendExit = vi.fn();
    await stopOwnedKernel({ ownsKernel: false, origin: 'http://127.0.0.1:4174', fetchImpl, state: {}, isBackendExited: () => false, waitForBackendExit });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(waitForBackendExit).not.toHaveBeenCalled();
  });

  it('uses the versioned snapshot token and explicit shutdown request, then waits for exit', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { csrf: 'opaque-test-token' }))
      .mockResolvedValueOnce(response(202, { status: 'stopping' }));
    const state = { shutdownAccepted: false };
    const waitForBackendExit = vi.fn(async () => true);
    await stopOwnedKernel({ ownsKernel: true, origin: 'http://127.0.0.1:4174', fetchImpl, state, isBackendExited: () => false, waitForBackendExit });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'x-pseudoharness-protocol-version': '1' });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: { 'x-pseudoharness-protocol-version': '1', 'x-pseudoharness-token': 'opaque-test-token' },
      body: '{"confirm":"stop-kernel"}',
    });
    expect(state.shutdownAccepted).toBe(true);
    expect(waitForBackendExit).toHaveBeenCalledWith(15_000);
  });

  it('keeps the managed kernel running when its shutdown request is rejected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { csrf: 'opaque-test-token' }))
      .mockResolvedValueOnce(response(409, { code: 'SHUTDOWN_REJECTED', error: 'Shutdown is temporarily unavailable.' }));
    const state = { shutdownAccepted: false };
    const waitForBackendExit = vi.fn();
    await expect(stopOwnedKernel({ ownsKernel: true, origin: 'http://127.0.0.1:4174', fetchImpl, state, isBackendExited: () => false, waitForBackendExit })).rejects.toThrow('Shutdown is temporarily unavailable.');
    expect(state.shutdownAccepted).toBe(false);
    expect(waitForBackendExit).not.toHaveBeenCalled();
  });

  it('allows retrying exit wait after the API already accepted shutdown', async () => {
    const fetchImpl = vi.fn();
    const state = { shutdownAccepted: true };
    await expect(stopOwnedKernel({ ownsKernel: true, origin: 'http://127.0.0.1:4174', fetchImpl, state, isBackendExited: () => false, waitForBackendExit: async () => false, timeoutMs: 1 })).rejects.toMatchObject({ code: 'KERNEL_EXIT_TIMEOUT' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
