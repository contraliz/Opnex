import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { forceStopChildTree, stopChildTree } from '../scripts/process-tree.mjs';

let processTree: ChildProcess | undefined;

afterEach(async () => {
  if (processTree) await forceStopChildTree(processTree);
  processTree = undefined;
});

describe('smoke process cleanup', () => {
  it('stops a child and its descendant', async () => {
    const { child, grandchildPid } = await spawnProcessTree();
    processTree = child;

    await expect(forceStopChildTree(child)).resolves.toBe(true);
    await expect(waitForProcessExit(grandchildPid)).resolves.toBe(true);
  });

  it('stops descendants after graceful parent exit', async () => {
    const { child, grandchildPid } = await spawnProcessTree();
    processTree = child;

    await expect(stopChildTree(child)).resolves.toBe(true);
    await expect(waitForProcessExit(grandchildPid)).resolves.toBe(true);
  });
});

async function spawnProcessTree() {
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(child.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', source], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', (chunk) => {
      const pid = Number(String(chunk).trim());
      if (Number.isSafeInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error('The child process did not report its descendant PID.'));
    });
  });
  return { child, grandchildPid };
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
