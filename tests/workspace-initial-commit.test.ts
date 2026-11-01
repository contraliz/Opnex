import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialCommit, previewInitialCommit, type InitialCommitRunner } from '../server/workspace-initial-commit.js';

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) {
    await rm(temporary, { recursive: true, force: true });
    temporary = undefined;
  }
});

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function unbornRepository() {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'opnex-initial-commit-'));
  temporary = await realpath(temporary);
  git(['init', '--quiet', '-b', 'main'], temporary);
  git(['config', 'user.name', 'Opnex Test'], temporary);
  git(['config', 'user.email', 'opnex-test@example.invalid'], temporary);
  return temporary;
}

describe('initial commit preview and confirmation', () => {
  it('previews ignored and staged files, preserves staged content, then creates the first commit', async () => {
    const root = await unbornRepository();
    await writeFile(path.join(root, '.gitignore'), 'ignored.tmp\n');
    await writeFile(path.join(root, 'staged.txt'), 'staged version');
    git(['add', 'staged.txt'], root);
    await writeFile(path.join(root, 'staged.txt'), 'later working copy');
    await writeFile(path.join(root, 'new file.txt'), 'new file');
    await writeFile(path.join(root, 'ignored.tmp'), 'ignored');

    const preview = await previewInitialCommit(root);
    expect(preview).toMatchObject({ status: 'unborn', eligible: true, empty: false });
    expect(preview.files.map(file => file.path)).toEqual(expect.arrayContaining(['.gitignore', 'staged.txt', 'new file.txt']));
    expect(preview.files.some(file => file.path === 'ignored.tmp')).toBe(false);
    expect(preview.files.find(file => file.path === 'staged.txt')?.status).toBe('staged and modified');

    const result = await createInitialCommit({ workspaceRoot: root, previewToken: preview.previewToken!, message: 'Initial project baseline' });
    expect(git(['rev-parse', 'HEAD'], root)).toBe(result.commit);
    expect(git(['show', 'HEAD:staged.txt'], root)).toBe('staged version');
    expect(git(['show', 'HEAD:new file.txt'], root)).toBe('new file');
    expect(git(['show', 'HEAD:.gitignore'], root)).toBe('ignored.tmp');
    expect(git(['status', '--short'], root)).toContain('staged.txt');
    await expect(readFile(path.join(root, 'staged.txt'), 'utf8')).resolves.toBe('later working copy');
  });

  it('allows an explicitly confirmed empty initial commit', async () => {
    const root = await unbornRepository();
    const preview = await previewInitialCommit(root);
    expect(preview).toMatchObject({ status: 'unborn', eligible: true, empty: true, totalFiles: 0 });
    const result = await createInitialCommit({ workspaceRoot: root, previewToken: preview.previewToken!, message: 'Empty baseline' });
    expect(git(['rev-parse', 'HEAD'], root)).toBe(result.commit);
    expect(git(['show', '--format=%P', '--no-patch', 'HEAD'], root)).toBe('');
  });

  it('rejects a stale preview and does not create a commit', async () => {
    const root = await unbornRepository();
    const preview = await previewInitialCommit(root);
    await writeFile(path.join(root, 'arrived-later.txt'), 'not in the preview');
    await expect(createInitialCommit({ workspaceRoot: root, previewToken: preview.previewToken!, message: 'Initial baseline' })).rejects.toMatchObject({ code: 'stale-preview' });
    expect(() => git(['rev-parse', '--verify', 'HEAD^{commit}'], root)).toThrow();
  });

  it('does not offer an initial commit for a committed or nested workspace', async () => {
    const root = await unbornRepository();
    await writeFile(path.join(root, 'file.txt'), 'file');
    git(['add', 'file.txt'], root);
    git(['commit', '--quiet', '-m', 'existing'], root);
    expect(await previewInitialCommit(root)).toMatchObject({ status: 'committed', eligible: false });

    const nested = path.join(root, 'nested');
    await mkdir(nested);
    expect(await previewInitialCommit(nested)).toMatchObject({ status: 'unavailable', eligible: false, reason: 'project-not-repository-root' });
  });

  it('requires an existing repository author identity', async () => {
    const root = await unbornRepository();
    await writeFile(path.join(root, 'file.txt'), 'file');
    const preview = await previewInitialCommit(root);
    const runner: InitialCommitRunner = async (executable, args, cwd, maxStdoutBytes, input, timeoutMs) => {
      if (args[0] === 'var' && args[1] === 'GIT_AUTHOR_IDENT') return { code: 128, stdout: '', stderr: 'identity unavailable' };
      return await (await import('../server/workspace-initial-commit.js')).runInitialCommitGit(executable, args, cwd, maxStdoutBytes, input, timeoutMs);
    };
    await expect(createInitialCommit({ workspaceRoot: root, previewToken: preview.previewToken!, message: 'Initial baseline' }, runner)).rejects.toMatchObject({ code: 'missing-author' });
    expect(() => git(['rev-parse', '--verify', 'HEAD^{commit}'], root)).toThrow();
  });

  it('rejects a nonempty message check and preserves existing history', async () => {
    const root = await unbornRepository();
    await writeFile(path.join(root, 'file.txt'), 'file');
    const preview = await previewInitialCommit(root);
    await expect(createInitialCommit({ workspaceRoot: root, previewToken: preview.previewToken!, message: '  ' })).rejects.toMatchObject({ code: 'invalid-message' });
    expect(() => git(['rev-parse', '--verify', 'HEAD^{commit}'], root)).toThrow();
  });
});
