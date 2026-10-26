import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mergeRecruitmentCommits,
  prepareRecruitmentWorktrees,
  readRecruitmentBranchHead,
  removeRecruitmentWorktree,
  validateRecruitmentBranch,
  validateRecruitmentRoot,
} from '../server/recruitment-git';

describe('bounded recruitment Git worktrees', () => {
  let fixture: string;
  let repo: string;
  let worktrees: string;
  let baseCommit: string;

  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-recruitment-git-'));
    repo = path.join(fixture, 'repo');
    worktrees = path.join(fixture, 'managed-worktrees');
    await mkdir(repo);
    await mkdir(worktrees);
    run(repo, 'init', '-b', 'main');
    run(repo, 'config', 'user.name', 'Recruitment test');
    run(repo, 'config', 'user.email', 'recruitment@example.invalid');
    await writeFile(path.join(repo, 'shared.txt'), 'base\n');
    run(repo, 'add', 'shared.txt');
    run(repo, 'commit', '-m', 'base');
    baseCommit = run(repo, 'rev-parse', 'HEAD');
  });

  afterEach(async () => {
    // The fixture owns this entire temporary directory; production cleanup is tested separately.
    await rm(fixture, { recursive: true, force: true });
  });

  async function prepare(taskId: string, workerIds = ['alpha', 'beta']) {
    const taskRoot = path.join(worktrees, taskId);
    return prepareRecruitmentWorktrees({
      canonicalRoot: repo,
      taskRoot,
      baseRef: 'main',
      integrationBranch: `recruitment/${taskId}/integration`,
      workers: workerIds.map((workerId) => ({ workerId, branch: `recruitment/${taskId}/worker-${workerId}` })),
    });
  }

  it('validates a Git root and selected commit ref, with clear non-Git and missing-root errors', async () => {
    const validated = await validateRecruitmentRoot(repo, 'main');
    expect(validated.canonicalRoot).toBe(repo);
    expect(validated.baseCommit).toBe(baseCommit);
    await expect(validateRecruitmentRoot(fixture, 'main')).rejects.toThrow(/not a Git worktree/i);
    await expect(validateRecruitmentRoot(path.join(fixture, 'missing'), 'main')).rejects.toThrow(/does not exist/i);
    await expect(validateRecruitmentRoot(repo, 'missing-ref')).rejects.toThrow();
  });

  it('rejects traversal and option-like branch names', () => {
    for (const branch of ['../outside', 'foo/../../bar', '-option', 'worker name', 'x//y', 'x@{1}']) {
      expect(() => validateRecruitmentBranch(branch)).toThrow();
    }
  });

  it('rejects malicious worker IDs before creating a task directory', async () => {
    const taskRoot = path.join(worktrees, 'unsafe');
    await expect(prepareRecruitmentWorktrees({
      canonicalRoot: repo,
      taskRoot,
      baseRef: 'main',
      integrationBranch: 'recruitment/unsafe/integration',
      workers: [{ workerId: '../outside', branch: 'recruitment/unsafe/worker-outside' }],
    })).rejects.toThrow(/Worker ID/);
    await expect(access(taskRoot)).rejects.toThrow();
  });

  it('creates distinct worker and integration worktrees at the selected base and reads branch heads', async () => {
    const state = await prepare('task-01');
    expect(state.baseCommit).toBe(baseCommit);
    expect(state.workers).toHaveLength(2);
    expect(new Set([state.integration.worktreeRoot, ...state.workers.map((worker) => worker.worktreeRoot)]).size).toBe(3);
    expect(state.workers.map((worker) => worker.headCommit)).toEqual([baseCommit, baseCommit]);
    expect(await readRecruitmentBranchHead(repo, state.workers[0].branch)).toBe(baseCommit);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(baseCommit);
    expect(run(repo, 'remote')).toBe('');
  });

  it('refuses existing task roots, worktree destinations, and branches', async () => {
    await mkdir(path.join(worktrees, 'collision'));
    await expect(prepare('collision', ['alpha'])).rejects.toThrow(/already exists/i);
    run(repo, 'branch', 'recruitment/task-02/worker-alpha');
    await expect(prepare('task-02', ['alpha'])).rejects.toThrow(/branch already exists/i);
  });

  it('merges only the caller-confirmed worker commit and leaves the canonical checkout untouched', async () => {
    const state = await prepare('merge-ok', ['alpha']);
    await writeFile(path.join(state.workers[0].worktreeRoot, 'worker.txt'), 'from worker\n');
    run(state.workers[0].worktreeRoot, 'add', 'worker.txt');
    run(state.workers[0].worktreeRoot, 'commit', '-m', 'worker change');
    const headCommit = run(state.workers[0].worktreeRoot, 'rev-parse', 'HEAD');
    const result = await mergeRecruitmentCommits({
      canonicalRoot: repo,
      integrationRoot: state.integration.worktreeRoot,
      workers: [{ workerId: 'alpha', branch: state.workers[0].branch, headCommit }],
    });
    expect(result.status).toBe('ready');
    expect(result.merged).toEqual([{ workerId: 'alpha', headCommit }]);
    expect((await readFile(path.join(state.integration.worktreeRoot, 'worker.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('from worker\n');
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(baseCommit);
    await expect(mergeRecruitmentCommits({
      canonicalRoot: repo,
      integrationRoot: state.integration.worktreeRoot,
      workers: [{ workerId: 'alpha', branch: state.workers[0].branch, headCommit: baseCommit }],
    })).rejects.toThrow(/HEAD changed/i);
  });

  it('reports merge conflicts and preserves both worktrees for resolution', async () => {
    const state = await prepare('merge-conflict', ['alpha']);
    await writeFile(path.join(state.workers[0].worktreeRoot, 'shared.txt'), 'worker version\n');
    run(state.workers[0].worktreeRoot, 'add', 'shared.txt');
    run(state.workers[0].worktreeRoot, 'commit', '-m', 'worker edit');
    const headCommit = run(state.workers[0].worktreeRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(state.integration.worktreeRoot, 'shared.txt'), 'integration version\n');
    run(state.integration.worktreeRoot, 'add', 'shared.txt');
    run(state.integration.worktreeRoot, 'commit', '-m', 'integration edit');
    const result = await mergeRecruitmentCommits({
      canonicalRoot: repo,
      integrationRoot: state.integration.worktreeRoot,
      workers: [{ workerId: 'alpha', branch: state.workers[0].branch, headCommit }],
    });
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toEqual([{ workerId: 'alpha', files: ['shared.txt'] }]);
    expect((await readFile(path.join(state.workers[0].worktreeRoot, 'shared.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('worker version\n');
    expect(run(state.integration.worktreeRoot, 'status', '--short')).toContain('UU shared.txt');
  });

  it('refuses cleanup outside its task root and removes only a verified managed worktree', async () => {
    const state = await prepare('cleanup', ['alpha']);
    const worker = state.workers[0];
    await expect(removeRecruitmentWorktree({
      canonicalRoot: repo,
      taskRoot: state.taskRoot,
      worktreeRoot: path.join(fixture, 'repo'),
      branch: worker.branch,
    })).rejects.toThrow(/escapes/i);
    await removeRecruitmentWorktree({
      canonicalRoot: repo,
      taskRoot: state.taskRoot,
      worktreeRoot: worker.worktreeRoot,
      branch: worker.branch,
    });
    await expect(readFile(path.join(worker.worktreeRoot, 'shared.txt'), 'utf8')).rejects.toThrow();
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });
});
