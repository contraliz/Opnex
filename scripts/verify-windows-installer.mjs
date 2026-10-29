import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PE from 'pe-library';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.argv[2] ?? process.env.OPNEX_PACKAGED_DIR ?? process.env.PSEUDOHARNESS_PACKAGED_DIR ?? path.join(repoRoot, 'desktop-release'));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const setupPath = path.join(outputDir, `Opnex Setup ${packageJson.version}.exe`);
const appPath = path.join(outputDir, 'win-unpacked', 'Opnex.exe');

function readManifest(executablePath) {
  const executable = PE.NtExecutable.from(fs.readFileSync(executablePath), { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(executable);
  const entries = resources.entries.filter((entry) => entry.type === 24);
  if (entries.length !== 1) {
    throw new Error(`Expected one Windows manifest in ${executablePath}; found ${entries.length}.`);
  }
  return Buffer.from(entries[0].bin).toString('utf8');
}

const setupManifest = readManifest(setupPath);
if (!/<requestedExecutionLevel\b[^>]*\blevel=["']requireAdministrator["']/.test(setupManifest)) {
  throw new Error('The Windows setup executable does not request administrator permissions.');
}

const appManifest = readManifest(appPath);
if (!/<requestedExecutionLevel\b[^>]*\blevel=["']asInvoker["']/.test(appManifest)) {
  throw new Error('The installed Opnex app must run as the signed-in user.');
}

console.log('Windows setup requests administrator permission; Opnex itself runs as the signed-in user.');
