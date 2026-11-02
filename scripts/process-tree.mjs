import { spawn } from 'node:child_process';

export async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function forceStopChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === 'win32') {
    if (!child.pid) return false;
    const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForChildExit(taskkill, 5000);
    if (await waitForChildExit(child, 5000)) return true;
    child.kill('SIGKILL');
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
  return waitForChildExit(child, 5000);
}

export async function stopChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === 'win32') return forceStopChildTree(child);

  child.kill();
  if (await waitForChildExit(child, 3000)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    return true;
  }
  return forceStopChildTree(child);
}
