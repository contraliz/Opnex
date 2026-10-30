import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWorkspaceRepository, inspectWorkspaceRepository } from '../server/workspace-git-init.js';
import type { GitWorkspaceCommand } from '../server/git-workspace.js';

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) {
    await rm(temporary, { recursive: true, force: true });
    temporary = undefined;
  }
});

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const canRunGit = await gitAvailable();

describe('workspace repository initialization', () => {
  it.runIf(canRunGit)('reports an empty workspace as missing a repository', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-')));

    await expect(inspectWorkspaceRepository(temporary)).resolves.toEqual({
      status: 'missing',
      workspaceRoot: temporary,
    });
  });

  it.runIf(canRunGit)('finds the owning parent repository for a nested workspace', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-parent-')));
    git(['init', '--quiet'], temporary);
    const nested = path.join(temporary, 'nested', 'workspace');
    await mkdir(nested, { recursive: true });

    await expect(inspectWorkspaceRepository(await realpath(nested))).resolves.toEqual({
      status: 'repository',
      workspaceRoot: nested,
      repositoryRoot: temporary,
    });
  });
  it.runIf(canRunGit)('recognizes a linked Git worktree from a nested workspace', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-worktree-')));
    const source = path.join(temporary, 'source');
    const linked = path.join(temporary, 'linked');
    await mkdir(source);
    git(['init', '--quiet'], source);
    git(['config', 'user.name', 'Workspace Git Test'], source);
    git(['config', 'user.email', 'workspace-git-test@example.invalid'], source);
    await writeFile(path.join(source, 'tracked.txt'), 'preserve me');
    git(['add', 'tracked.txt'], source);
    git(['commit', '--quiet', '-m', 'fixture'], source);
    git(['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], source);
    const nested = path.join(linked, 'nested');
    await mkdir(nested);

    await expect(inspectWorkspaceRepository(await realpath(nested))).resolves.toEqual({
      status: 'repository',
      workspaceRoot: nested,
      repositoryRoot: linked,
    });
  });
  it.runIf(canRunGit)('initializes exactly the selected workspace and preserves its files', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-init-')));
    await writeFile(path.join(temporary, 'notes.txt'), 'keep this file');

    await expect(ensureWorkspaceRepository(temporary)).resolves.toEqual({
      created: true,
      workspaceRoot: temporary,
      repositoryRoot: temporary,
    });
    await expect(readFile(path.join(temporary, 'notes.txt'), 'utf8')).resolves.toBe('keep this file');
    await expect(inspectWorkspaceRepository(temporary)).resolves.toMatchObject({ status: 'repository', repositoryRoot: temporary });
  });
  it.runIf(canRunGit)('rechecks agent authorization immediately before creating a missing repository', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-authorization-')));
    let initCalls = 0, authorizationCalls = 0;
    const runner: GitWorkspaceCommand = async (_executable, args) => {
      if (args[0] === 'init') { initCalls++; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    };

    await expect(ensureWorkspaceRepository(temporary, runner, () => { authorizationCalls++; return false; }))
      .rejects.toThrow('no longer authorized');
    expect(authorizationCalls).toBe(1);
    expect(initCalls).toBe(0);
    await expect(lstat(path.join(temporary, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.runIf(canRunGit)('does not create a nested repository inside an existing parent repository', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-parent-init-')));
    git(['init', '--quiet'], temporary);
    const nested = path.join(temporary, 'nested');
    await mkdir(nested);

    await expect(ensureWorkspaceRepository(await realpath(nested))).resolves.toEqual({
      created: false,
      workspaceRoot: nested,
      repositoryRoot: temporary,
    });
    await expect(lstat(path.join(nested, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.runIf(canRunGit)('serializes concurrent repository creation for the same workspace', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-concurrent-')));
    const workspace = path.join(temporary, 'workspace with spaces');
    await mkdir(workspace);
    let initCalls = 0;
    const runner: GitWorkspaceCommand = async (executable, args, cwd) => {
      if (args[0] === 'init') {
        initCalls++;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      try {
        return { code: 0, stdout: execFileSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), stderr: '' };
      } catch (error) {
        const result = error as NodeJS.ErrnoException & { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        return { code: result.status ?? 128, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
      }
    };

    const results = await Promise.all([
      ensureWorkspaceRepository(await realpath(workspace), runner),
      ensureWorkspaceRepository(await realpath(workspace), runner),
    ]);

    expect(results.map(result => result.created)).toEqual([true, false]);
    expect(results.map(result => result.repositoryRoot)).toEqual([workspace, workspace]);
    expect(initCalls).toBe(1);
    await expect(ensureWorkspaceRepository(await realpath(workspace), runner)).resolves.toMatchObject({ created: false, repositoryRoot: workspace });
  });
  it('rejects relative, missing, and control-character workspace paths before invoking Git', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-invalid-root-')));
    let calls = 0;
    const runner: GitWorkspaceCommand = async () => {
      calls++;
      return { code: 0, stdout: '', stderr: '' };
    };

    await expect(inspectWorkspaceRepository('relative', runner)).rejects.toMatchObject({ code: 'invalid-root' });
    await expect(inspectWorkspaceRepository(path.join(temporary, 'missing'), runner)).rejects.toMatchObject({ code: 'invalid-root' });
    const filePath = path.join(temporary, 'file.txt');
    await writeFile(filePath, 'not a directory');
    await expect(inspectWorkspaceRepository(filePath, runner)).rejects.toMatchObject({ code: 'invalid-root' });
    await expect(inspectWorkspaceRepository(`${temporary}\n`, runner)).rejects.toMatchObject({ code: 'invalid-root' });
    expect(calls).toBe(0);
  });

  it('distinguishes an unavailable Git executable from a missing repository', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-missing-exe-')));
    const commands: string[] = [];
    const runner: GitWorkspaceCommand = async (_executable, args) => {
      commands.push(args[0]);
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };

    await expect(inspectWorkspaceRepository(temporary, runner)).rejects.toMatchObject({
      code: 'git-unavailable',
      message: expect.stringContaining('not available on PATH'),
    });
    await expect(ensureWorkspaceRepository(temporary, runner)).rejects.toMatchObject({ code: 'git-unavailable' });
    expect(commands).toEqual(['rev-parse', 'rev-parse']);
  });

  it('does not treat unsafe-directory, permission, or unexpected Git failures as no repository', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-failure-')));
    const cases: Array<{ stderr: string; code: string; message: RegExp }> = [
      { stderr: 'fatal: detected dubious ownership in repository at private-path', code: 'unsafe-repository', message: /ownership|safe\.directory/i },
      { stderr: 'fatal: cannot access folder: Permission denied', code: 'permission-denied', message: /permissions/i },
      { stderr: 'fatal: an unexpected Git failure', code: 'inspection-failed', message: /could not inspect/i },
    ];

    for (const failure of cases) {
      const runner: GitWorkspaceCommand = async () => ({ code: 128, stdout: '', stderr: failure.stderr });
      await expect(inspectWorkspaceRepository(temporary, runner)).rejects.toMatchObject({
        code: failure.code,
        message: expect.stringMatching(failure.message),
      });
    }
  });
  it('returns a repository discovered during initialization checks without creating a nested one', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-race-')));
    const workspace = path.join(temporary, 'workspace');
    await mkdir(workspace);
    let inspections = 0;
    let initCalls = 0;
    const runner: GitWorkspaceCommand = async (_executable, args) => {
      if (args[0] === 'init') {
        initCalls++;
        return { code: 0, stdout: '', stderr: '' };
      }
      inspections++;
      if (inspections === 1) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      return { code: 0, stdout: `${temporary}\n`, stderr: '' };
    };

    await expect(ensureWorkspaceRepository(await realpath(workspace), runner)).resolves.toEqual({
      created: false,
      workspaceRoot: workspace,
      repositoryRoot: temporary,
    });
    expect(initCalls).toBe(0);
  });
  it.runIf(process.platform === 'win32')('rejects a workspace path that traverses a Windows junction', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-junction-')));
    const target = path.join(temporary, 'target');
    const junction = path.join(temporary, 'junction');
    await mkdir(target);
    try {
      await symlink(target, junction, 'junction');
    } catch {
      return;
    }

    await expect(inspectWorkspaceRepository(junction)).rejects.toMatchObject({
      code: 'invalid-root',
      message: expect.stringMatching(/canonical|reparse/i),
    });
  });
  it('reports a workspace removed during Git inspection as an invalid root', async () => {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-workspace-git-disappears-')));
    const workspace = path.join(temporary, 'workspace');
    await mkdir(workspace);
    const runner: GitWorkspaceCommand = async () => {
      await rm(workspace, { recursive: true });
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };

    await expect(inspectWorkspaceRepository(await realpath(workspace), runner)).rejects.toMatchObject({ code: 'invalid-root' });
  });
});
