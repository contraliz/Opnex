import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packagedLauncher from '../desktop/packaged-launcher.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-desktop-smoke-'));
const profileDirectory = path.join(tempDirectory, 'source-profile');
const packagedProfileDirectory = path.join(tempDirectory, 'packaged-profile');
await Promise.all([mkdir(profileDirectory), mkdir(packagedProfileDirectory)]);
const electronCli = path.join(projectRoot, 'node_modules', 'electron', 'cli.js');
const appEntry = path.join(projectRoot, 'desktop', 'main.cjs');
const { findPackagedLauncher } = packagedLauncher;
let verifiedCookie = false;
const observedRequests = [];
const testServer = createServer((request, response) => {
  observedRequests.push({ url: request.url, cookie: request.headers.cookie ?? '' });
  if (request.url === '/seed') response.setHeader('Set-Cookie', 'pseudoharness-smoke=session-restored; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/');
  if (request.url === '/verify') verifiedCookie = /(?:^|;\s*)pseudoharness-smoke=session-restored(?:;|$)/.test(request.headers.cookie ?? '');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Browser session smoke</title><p>Profile persistence check</p>');
});

async function launchSmoke(url, profile, launcher) {
  const child = spawn(launcher.executable, launcher.args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      PSEUDOHARNESS_ELECTRON_DATA_DIR: profile,
      PSEUDOHARNESS_SMOKE_TEST: '1',
      ...(url ? { PSEUDOHARNESS_SMOKE_URL: url } : {}),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    console.error('Desktop smoke test timed out.');
    child.kill();
  }, 45_000);

  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => {
        if (signal) reject(new Error(`Electron smoke test exited from ${signal}.`));
        else resolve(exitCode ?? 1);
      });
    });
    if (code !== 0) throw new Error(`Electron smoke test exited with code ${code}.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate an isolated kernel port.');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function waitForKernelHealth(origin, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The isolated external Pseudoharness kernel did not become healthy.');
}

async function stopExternalKernel(origin, child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const versionHeaders = { 'x-pseudoharness-protocol-version': '1' };
  const snapshotResponse = await fetch(`${origin}/api/v1/snapshot`, { headers: versionHeaders, signal: AbortSignal.timeout(1500) });
  if (!snapshotResponse.ok) throw new Error(`External kernel snapshot failed with HTTP ${snapshotResponse.status}.`);
  const snapshot = await snapshotResponse.json();
  if (typeof snapshot.csrf !== 'string' || !snapshot.csrf) throw new Error('External kernel snapshot omitted its shutdown token.');
  const shutdown = await fetch(`${origin}/api/v1/kernel/shutdown`, {
    method: 'POST',
    headers: { ...versionHeaders, 'content-type': 'application/json', 'x-pseudoharness-token': snapshot.csrf },
    body: JSON.stringify({ confirm: 'stop-kernel' }),
    signal: AbortSignal.timeout(5000),
  });
  if (shutdown.status !== 202) {
    const result = await shutdown.json().catch(() => ({}));
    if (shutdown.status !== 409 || result.code !== 'KERNEL_SHUTTING_DOWN') throw new Error(`External kernel shutdown failed: ${result.error || shutdown.status}.`);
  }
  if (!await waitForChildExit(child, 20_000)) throw new Error('The external kernel did not exit after accepting its explicit shutdown request.');
}

async function verifyAttachedKernelQuit(profile) {
  const dataDirectory = path.join(profile, 'local-state');
  await mkdir(dataDirectory, { recursive: true });
  const port = await unusedLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const externalKernel = spawn(process.execPath, [path.join(projectRoot, 'bin', 'pseudoharness.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      PSEUDOHARNESS_DATA_DIR: dataDirectory,
      PSEUDOHARNESS_DESKTOP: '1',
      PSEUDOHARNESS_STARTUP_SECRET: randomBytes(32).toString('hex'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  let preserveProfile = false;
  try {
    const before = await waitForKernelHealth(origin, externalKernel);
    await launchSmoke(undefined, profile, { executable: process.execPath, args: [electronCli, appEntry] });
    const after = await waitForKernelHealth(origin, externalKernel, 5000);
    if (after.kernelInstanceId !== before.kernelInstanceId) throw new Error('The attached shell replaced the external kernel instance.');
    console.log(`Attached-kernel Quit smoke passed: the shell left external kernel ${before.kernelInstanceId} healthy.`);
    await stopExternalKernel(origin, externalKernel);
  } catch (error) {
    if (externalKernel.exitCode === null && externalKernel.signalCode === null) {
      try { await stopExternalKernel(origin, externalKernel); }
      catch (cleanupError) {
        preserveProfile = true;
        console.error(`Could not stop the disposable external kernel cleanly; its data was preserved at ${dataDirectory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    throw error;
  } finally {
    if (preserveProfile) process.exitCode = 1;
  }
}

try {
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });
  const address = testServer.address();
  const smokeOrigin = `http://127.0.0.1:${address.port}`;
  const launchers = [{ label: 'source', executable: process.execPath, args: [electronCli, appEntry], profile: profileDirectory }];
  if (process.argv.includes('--packaged')) {
    const packagedDir = path.resolve(process.env.PSEUDOHARNESS_PACKAGED_DIR ?? path.join(projectRoot, 'desktop-release'));
    const packaged = findPackagedLauncher(packagedDir);
    if (!packaged) throw new Error(`Packaged Electron application for ${process.platform}/${process.arch} was not found in ${packagedDir}.`);
    launchers.push({ label: 'packaged', ...packaged, profile: packagedProfileDirectory });
  }
  for (const launcher of launchers) {
    verifiedCookie = false;
    await launchSmoke(`${smokeOrigin}/seed`, launcher.profile, launcher);
    await launchSmoke(`${smokeOrigin}/verify`, launcher.profile, launcher);
    if (!verifiedCookie) throw new Error(`${launcher.label} browser cookie was not restored after an Electron restart: ${JSON.stringify(observedRequests)}`);
  }
  await verifyAttachedKernelQuit(path.join(tempDirectory, 'attached-profile'));
  console.log(`Desktop startup and persistent browser profile smoke checks passed (${launchers.map(({ label }) => label).join(', ')}).`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  testServer.close();
  if (process.exitCode !== 1) await rm(tempDirectory, { recursive: true, force: true });
}
