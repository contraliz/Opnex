import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { findPackagedLauncher } = require('../desktop/packaged-launcher.cjs') as {
  findPackagedLauncher(directory: string, options?: { platform?: string; arch?: string }): { executable: string; args: string[] } | null;
};

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function executableAt(relativePath: string) {
  const executable = path.join(root, relativePath);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '');
  return executable;
}

describe('packaged desktop smoke launcher', () => {
  it('selects the native Mac app bundle for the runner architecture', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'opnex-packaged-launcher-'));
    const intel = await executableAt(path.join('mac', 'Opnex.app', 'Contents', 'MacOS', 'Opnex'));
    const appleSilicon = await executableAt(path.join('mac-arm64', 'Opnex.app', 'Contents', 'MacOS', 'Opnex'));

    expect(findPackagedLauncher(root, { platform: 'darwin', arch: 'arm64' })).toEqual({ executable: appleSilicon, args: [] });
    expect(findPackagedLauncher(root, { platform: 'darwin', arch: 'x64' })).toEqual({ executable: intel, args: [] });
  });

  it('keeps the Windows unpacked-app lookup recursive', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'opnex-packaged-launcher-'));
    const executable = await executableAt(path.join('win-unpacked', 'Opnex.exe'));

    expect(findPackagedLauncher(root, { platform: 'win32', arch: 'x64' })).toEqual({ executable, args: [] });
  });
});
