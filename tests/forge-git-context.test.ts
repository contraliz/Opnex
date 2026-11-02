import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeAttempt, ForgeTicket } from '../server/forge-contracts.js';
import {
  forgeAttemptRoot,
  forgeAttemptWorkerId,
  forgeBranchName,
  resolveLocalForgeTargetBranch,
  restoreForgeWorkerWorktrees,
} from '../server/forge-git-context.js';
import { prepareForgeWorktrees } from '../server/forge-git.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
const ticketId = '11111111-1111-4111-8111-111111111111';
const testBase = path.join(os.tmpdir(), 'opx');

async function repository() {
  await mkdir(testBase, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(testBase, 'r-')));
  roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Forge Test');
  await git(root, 'config', 'user.email', 'forge-test@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'test\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-m', 'base');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Forge F2 Git context recovery', () => {
  it('uses the actual local main ref and deterministic attempt namespaces', async () => {
    const root = await repository();
    const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await resolveLocalForgeTargetBranch(root)).toBe('main');
    expect(forgeAttemptWorkerId(attemptId)).toBe('w-aaaaaaaaaaaa4aaa8aaaaaaaaaaa');
    expect(forgeBranchName(ticketId, attemptId, 'integration')).toBe(
      `codex/forge/${ticketId}/${attemptId}/integration/head`
    );
    const stateRoot = path.join(testBase, 'app-state');
    expect(forgeAttemptRoot(stateRoot, ticketId, attemptId)).toBe(
      path.join(stateRoot, 'forge-worktrees', ticketId, attemptId)
    );
  });

  it('blocks when no local default/main branch can be resolved', async () => {
    const root = await repository();
    await git(root, 'checkout', '-b', 'feature/only');
    await git(root, 'branch', '-D', 'main');
    await expect(resolveLocalForgeTargetBranch(root)).rejects.toThrow(/local main branch/i);
  });

  it('reconstructs worker ownership only when the persisted attempt matches the F2 manifest', async () => {
    const root = await repository();
    const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const workerId = forgeAttemptWorkerId(attemptId);
    const stateRoot = `${root}-app-state`;
    roots.push(stateRoot);
    const taskRoot = forgeAttemptRoot(stateRoot, ticketId, attemptId);
    await mkdir(path.dirname(taskRoot), { recursive: true });
    const base = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: root,
      taskRoot,
      baseRef: 'main',
      ticketId,
      attemptId,
      workerIds: [workerId],
    });
    const ticket = {
      id: ticketId,
      workspaceRoot: root,
      workitems: [{ id: 'task-a' }],
    } as unknown as ForgeTicket;
    const attempt = {
      id: attemptId,
      taskId: 'task-a',
      claim: { ownerId: workerId },
      branch: prepared.workers[0].branch,
      worktreeRoot: prepared.workers[0].worktreeRoot,
      sourceBaselineSha: base,
    } as ForgeAttempt;

    await expect(restoreForgeWorkerWorktrees(ticket, attempt)).resolves.toMatchObject({
      attemptId,
      canonicalRoot: root,
      taskRoot,
    });
    await expect(
      restoreForgeWorkerWorktrees(ticket, {
        ...attempt,
        worktreeRoot: path.join(taskRoot, 'worker-forged'),
      })
    ).rejects.toThrow(/generated attempt root/i);
  });
});
