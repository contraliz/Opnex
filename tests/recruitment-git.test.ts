import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupPreparedRecruitmentWorktrees,
  mergeRecruitmentCommits,
  prepareRecruitmentWorktrees,
  readRecruitmentBranchHead,
  recruitmentGitWritableRoots,
  recruitmentWorkspaceRoot,
  removeRecruitmentWorktree,
  validateRecruitmentBranch,
  validateRecruitmentRoot,
  verifyRecruitmentIntegration,
} from '../server/recruitment-git';

describe('bounded recruitment Git worktrees', () => {
  // Git worktree creation, merge, and cleanup are filesystem-heavy on hosted
  // Windows runners when Vitest starts many file workers concurrently.
  // Keep these integration checks bounded without racing teardown against Git.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    expect(validated.canonicalRoot).toBe(await realpath(repo));
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

  it('keeps Windows worktree paths short under a deeply nested isolated state directory', async () => {
    const stateRoot = path.join(fixture, `isolated-state-${'x'.repeat(36)}`);
    const taskRoot = recruitmentWorkspaceRoot(stateRoot, '12345678-1234-4234-8234-123456789abc', 'abcdefab-cdef-4abc-8def-abcdefabcdef');
    await mkdir(path.dirname(taskRoot), { recursive: true });
    const prepared = await prepareRecruitmentWorktrees({
      canonicalRoot: repo,
      taskRoot,
      baseRef: 'main',
      integrationBranch: 'recruitment/path-limit/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/integration',
      workers: [
        { workerId: '7b1bae95-7a4e-4a5f-9eba-2dd77d463fcc', branch: 'recruitment/path-limit/7b1bae95-7a4e-4a5f-9eba-2dd77d463fcc/worker-alpha' },
        { workerId: '3fc00557-6960-4c5b-b9d2-7c40d35922d5', branch: 'recruitment/path-limit/3fc00557-6960-4c5b-b9d2-7c40d35922d5/worker-beta' },
      ],
    });
    const paths = [prepared.integration.worktreeRoot, ...prepared.workers.map((worker) => worker.worktreeRoot)];
    expect(paths).toHaveLength(3);
    expect(Math.max(...paths.map((value) => value.length))).toBeLessThan(260);
    for (const worktree of paths) await access(path.join(worktree, '.git'));
    const alphaRoots = await recruitmentGitWritableRoots(repo, prepared.workers[0].worktreeRoot, prepared.workers[0].branch);
    const betaRoots = await recruitmentGitWritableRoots(repo, prepared.workers[1].worktreeRoot, prepared.workers[1].branch);
    expect(alphaRoots[1]).not.toBe(betaRoots[1]);
    expect(alphaRoots[2]).not.toBe(betaRoots[2]);
    expect(alphaRoots[3]).not.toBe(betaRoots[3]);
    expect(alphaRoots[2]).toContain(path.join('refs', 'heads', 'recruitment', 'path-limit', '7b1bae95-7a4e-4a5f-9eba-2dd77d463fcc'));
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

  it('verifies the recorded integration branch contains its baseline and every worker commit', async () => {
    const state = await prepare('verify-integration', ['alpha','beta']);
    const commits = [] as Array<{ workerId: string; branch: string; headCommit: string }>;
    for (const [index, worker] of state.workers.entries()) {
      await writeFile(path.join(worker.worktreeRoot, `worker-${index}.txt`), `worker ${index}\n`);
      run(worker.worktreeRoot, 'add', `worker-${index}.txt`);
      run(worker.worktreeRoot, 'commit', '-m', `worker ${index}`);
      commits.push({ workerId: worker.workerId, branch: worker.branch, headCommit: run(worker.worktreeRoot, 'rev-parse', 'HEAD') });
    }
    await mergeRecruitmentCommits({ canonicalRoot: repo, integrationRoot: state.integration.worktreeRoot, workers: [commits[0]] });
    await expect(verifyRecruitmentIntegration({
      canonicalRoot: repo,
      integrationRoot: state.integration.worktreeRoot,
      integrationBranch: state.integration.branch,
      integrationBaseCommit: baseCommit,
      workerCommits: commits.map(row => ({ workerId: row.workerId, commit: row.headCommit })),
    })).rejects.toThrow(/not integrated/i);
    const merged = await mergeRecruitmentCommits({ canonicalRoot: repo, integrationRoot: state.integration.worktreeRoot, workers: [commits[1]] });
    const verified = await verifyRecruitmentIntegration({
      canonicalRoot: repo,
      integrationRoot: state.integration.worktreeRoot,
      integrationBranch: state.integration.branch,
      integrationBaseCommit: merged.integrationHead,
      workerCommits: commits.map(row => ({ workerId: row.workerId, commit: row.headCommit })),
    });
    expect(verified.headCommit).toBe(merged.integrationHead);
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

  it('removes an unchanged unsealed recruitment, its generated refs, and manifest-only task root', async () => {
    const prepared=await prepare('stale-cleanup',['alpha','beta']);
    expect(await cleanupPreparedRecruitmentWorktrees(prepared,worktrees)).toEqual([]);
    const branches=[prepared.integration.branch,...prepared.workers.map(worker=>worker.branch)];
    const remaining=run(repo,'for-each-ref','--format=%(refname:short)','refs/heads/recruitment');
    expect(remaining.split(/\r?\n/).filter(Boolean)).toEqual([]);
    expect(run(repo,'worktree','list','--porcelain').split(/\r?\n/).filter(line=>line.startsWith('worktree '))).toHaveLength(1);
    for(const branch of branches)await expect(readRecruitmentBranchHead(repo,branch)).rejects.toThrow();
    await expect(realpath(prepared.taskRoot)).rejects.toThrow();
  });

  it('retires successfully created worktrees and the initial ref left by a failed later add', async () => {
    const taskRoot=path.join(worktrees,'partial-cleanup'),workerBranch='recruitment/partial-cleanup/worker-alpha',hook=path.join(repo,'.git','hooks','post-checkout');
    await writeFile(hook,`#!/bin/sh\ngit update-ref refs/heads/${workerBranch} "$2"\n`);await chmod(hook,0o755);
    await expect(prepareRecruitmentWorktrees({canonicalRoot:repo,taskRoot,baseRef:baseCommit,integrationBranch:'recruitment/partial-cleanup/integration',workers:[{workerId:'alpha',branch:workerBranch}]})).rejects.toThrow(/Worktree preparation failed.*retired/);
    expect(run(repo,'for-each-ref','--format=%(refname:short)','refs/heads/recruitment')).toBe('');expect(run(repo,'worktree','list','--porcelain').split(/\r?\n/).filter(line=>line.startsWith('worktree '))).toHaveLength(1);await expect(realpath(taskRoot)).rejects.toThrow();await expect(readRecruitmentBranchHead(repo,workerBranch)).rejects.toThrow();
  });

  it('preserves a changed branch ref and reports incomplete cleanup after a later add fails', async () => {
    await writeFile(path.join(repo,'foreign.txt'),'foreign branch tip\n');run(repo,'add','foreign.txt');run(repo,'commit','-m','foreign branch tip');const foreignHead=run(repo,'rev-parse','HEAD');
    const taskRoot=path.join(worktrees,'partial-changed'),workerBranch='recruitment/partial-changed/worker-alpha',hook=path.join(repo,'.git','hooks','post-checkout');
    await writeFile(hook,`#!/bin/sh\ngit update-ref refs/heads/${workerBranch} ${foreignHead}\n`);await chmod(hook,0o755);
    await expect(prepareRecruitmentWorktrees({canonicalRoot:repo,taskRoot,baseRef:baseCommit,integrationBranch:'recruitment/partial-changed/integration',workers:[{workerId:'alpha',branch:workerBranch}]})).rejects.toThrow(/Worktree preparation failed.*branch recruitment\/partial-changed\/worker-alpha no longer points at its initial commit/);
    expect(await readRecruitmentBranchHead(repo,workerBranch)).toBe(foreignHead);expect(run(repo,'worktree','list','--porcelain').split(/\r?\n/).filter(line=>line.startsWith('worktree '))).toHaveLength(2);await expect(readFile(path.join(taskRoot,'.pseudoharness-recruitment.json'),'utf8')).resolves.toContain(workerBranch);
  });

  it('preserves all prepared resources when a generated branch ref no longer has its initial tip', async () => {
    const prepared=await prepare('stale-modified',['alpha']);const worker=prepared.workers[0];
    await writeFile(path.join(repo,'later.txt'),'a different committed tip\n');run(repo,'add','later.txt');run(repo,'commit','-m','different tip');const changedTip=run(repo,'rev-parse','HEAD');
    run(repo,'update-ref',`refs/heads/${worker.branch}`,changedTip);
    const errors=await cleanupPreparedRecruitmentWorktrees(prepared,worktrees);
    expect(errors.join(' ')).toContain('no longer points at its initial commit');
    expect(await readRecruitmentBranchHead(repo,worker.branch)).toBe(changedTip);
    expect((await readFile(path.join(worker.worktreeRoot,'shared.txt'),'utf8')).replace(/\r\n/g,'\n')).toBe('base\n');
    await expect(readFile(path.join(prepared.taskRoot,'.pseudoharness-recruitment.json'),'utf8')).resolves.toContain(worker.branch);
    expect(run(repo,'worktree','list','--porcelain').split(/\r?\n/).filter(line=>line.startsWith('worktree '))).toHaveLength(3);
  });
});
