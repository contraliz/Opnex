import { spawn } from 'node:child_process';
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
      PSEUDOHARNESS_SMOKE_URL: url,
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
  console.log(`Desktop startup and persistent browser profile smoke checks passed (${launchers.map(({ label }) => label).join(', ')}).`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  testServer.close();
  await rm(tempDirectory, { recursive: true, force: true });
}
