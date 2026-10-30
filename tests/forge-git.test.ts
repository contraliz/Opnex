import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createForgeIntegrationCandidate, finalizeForgeMerge, prepareForgeWorktrees, validateForgeWorkerCommit } from '../server/forge-git';
import { forgeGitWritableRoots } from '../server/recruitment-git';

describe('Forge Git operations', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  let fixture: string;
  let repo: string;
  let worktrees: string;

  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), 'opnex-forge-git-'));
    repo = path.join(fixture, 'repo');
    worktrees = path.join(fixture, 'managed-worktrees');
    await mkdir(repo);
    await mkdir(worktrees);
    run(repo, 'init', '-b', 'main');
    run(repo, 'config', 'user.name', 'Forge test');
    run(repo, 'config', 'user.email', 'forge@example.invalid');
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src', 'base.ts'), 'export const base = true;\n');
    run(repo, 'add', 'src/base.ts');
    run(repo, 'commit', '-m', 'base');
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  async function makeCandidate(ticketId: string) {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, ticketId),
      baseRef: 'main',
      ticketId,
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    await writeFile(path.join(worker.worktreeRoot, 'src', 'feature.ts'), 'export const feature = true;\n');
    run(worker.worktreeRoot, 'add', 'src/feature.ts');
    run(worker.worktreeRoot, 'commit', '-m', 'worker feature');
    const workerInput = {
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: run(worker.worktreeRoot, 'rev-parse', 'HEAD'),
      writeScope: [path.join(repo, 'src')],
    };
    const result = await createForgeIntegrationCandidate({ prepared, targetBranch: 'main', workers: [workerInput] });
    if (result.status !== 'ready') throw new Error(`Expected a ready candidate, received ${result.status}`);
    return { prepared, workerInput, candidate: result.candidate };
  }

  it('prepares ticket and attempt worktrees and accepts a committed in-scope worker change', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-1-attempt-1'),
      baseRef: 'main',
      ticketId: 'ticket-1',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    expect(worker.branch).toMatch(/^codex\/forge\/ticket-1\/attempt-1\//);
    expect(prepared.integration.branch).toMatch(/^codex\/forge\/ticket-1\/attempt-1\//);
    expect(new Set([worker.branch, prepared.integration.branch]).size).toBe(2);

    await writeFile(path.join(worker.worktreeRoot, 'src', 'feature.ts'), 'export const feature = true;\n');
    run(worker.worktreeRoot, 'add', 'src/feature.ts');
    run(worker.worktreeRoot, 'commit', '-m', 'worker feature');
    const commit = run(worker.worktreeRoot, 'rev-parse', 'HEAD');

    const result = await validateForgeWorkerCommit({
      prepared,
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: commit,
      writeScope: [path.join(repo, 'src')],
    });
    expect(result.status).toBe('accepted');
    expect(result.commit).toBe(commit);
    expect(result.changedPaths).toEqual(['src/feature.ts']);
  });

  it('refuses repeated ticket-attempt branch names without disturbing the original worktrees', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-collision-a'),
      baseRef: 'main',
      ticketId: 'ticket-collision',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    await expect(prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-collision-b'),
      baseRef: 'main',
      ticketId: 'ticket-collision',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    })).rejects.toThrow(/branch already exists/i);
    expect(run(repo, 'rev-parse', `refs/heads/${prepared.workers[0].branch}`)).toBe(prepared.baseCommit);
    expect(run(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree '))).toHaveLength(3);
  });

  it('grants only the exact worker or integration attempt Git-ref namespace', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-roots'),
      baseRef: 'main',
      ticketId: 'ticket-roots',
      attemptId: 'claim-7',
      workerIds: ['worker-a', 'worker-b'],
    });
    const rootsA = await forgeGitWritableRoots({
      canonicalRoot: repo,
      taskRoot: prepared.taskRoot,
      ticketId: prepared.ticketId,
      attemptId: prepared.attemptId,
      role: 'worker',
      workerId: 'worker-a',
      worktreeRoot: prepared.workers[0].worktreeRoot,
    });
    const rootsB = await forgeGitWritableRoots({
      canonicalRoot: repo,
      taskRoot: prepared.taskRoot,
      ticketId: prepared.ticketId,
      attemptId: prepared.attemptId,
      role: 'worker',
      workerId: 'worker-b',
      worktreeRoot: prepared.workers[1].worktreeRoot,
    });
    const integrationRoots = await forgeGitWritableRoots({
      canonicalRoot: repo,
      taskRoot: prepared.taskRoot,
      ticketId: prepared.ticketId,
      attemptId: prepared.attemptId,
      role: 'integration',
      worktreeRoot: prepared.integration.worktreeRoot,
    });

    expect(rootsA[0]).toBe(prepared.workers[0].worktreeRoot);
    expect(rootsA[1]).toContain(path.join('.git', 'worktrees'));
    expect(rootsA[2]).toContain(path.join('refs', 'heads', 'codex', 'forge', 'ticket-roots', 'claim-7', 'worker', 'worker-a'));
    expect(rootsA[3]).toContain(path.join('logs', 'refs', 'heads', 'codex', 'forge', 'ticket-roots', 'claim-7', 'worker', 'worker-a'));
    expect(rootsA[2]).not.toContain(path.join('worker', 'worker-b'));
    expect(rootsA[2]).not.toContain(path.join('refs', 'heads', 'main'));
    expect(rootsA[2]).not.toContain(path.join('ticket-other', 'claim-7'));
    expect(rootsA[2]).not.toContain(path.join('ticket-roots', 'successor-claim'));
    expect(rootsA[2]).not.toBe(path.join(repo, '.git', 'refs', 'heads', 'codex', 'forge'));
    expect(rootsA[3]).not.toContain(path.join('ticket-roots', 'successor-claim'));
    expect(rootsB[2]).not.toBe(rootsA[2]);
    expect(integrationRoots[2]).toContain(path.join('refs', 'heads', 'codex', 'forge', 'ticket-roots', 'claim-7', 'integration'));
    expect(integrationRoots[2]).not.toContain(path.join('worker', 'worker-a'));
    await expect(forgeGitWritableRoots({
      canonicalRoot: repo,
      taskRoot: prepared.taskRoot,
      ticketId: prepared.ticketId,
      attemptId: 'successor-claim',
      role: 'worker',
      workerId: 'worker-a',
      worktreeRoot: prepared.workers[0].worktreeRoot,
    })).rejects.toThrow(/ownership manifest/i);
  });

  it('rejects renames whose destination leaves the assigned write scope', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-rename'),
      baseRef: 'main',
      ticketId: 'ticket-rename',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    await mkdir(path.join(worker.worktreeRoot, 'docs'));
    run(worker.worktreeRoot, 'mv', 'src/base.ts', 'docs/base.ts');
    run(worker.worktreeRoot, 'commit', '-am', 'move file outside scope');
    const commit = run(worker.worktreeRoot, 'rev-parse', 'HEAD');

    const result = await validateForgeWorkerCommit({
      prepared,
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: commit,
      writeScope: [path.join(repo, 'src')],
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('out-of-scope');
    expect(result.changedPaths).toEqual(expect.arrayContaining(['src/base.ts', 'docs/base.ts']));
    expect(result.outOfScopePaths).toContain('docs/base.ts');
  });

  it('rejects a committed outcome when the worker worktree still has uncommitted or untracked files', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-dirty'),
      baseRef: 'main',
      ticketId: 'ticket-dirty',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    await writeFile(path.join(worker.worktreeRoot, 'src', 'feature.ts'), 'export const feature = true;\n');
    run(worker.worktreeRoot, 'add', 'src/feature.ts');
    run(worker.worktreeRoot, 'commit', '-m', 'worker feature');
    const commit = run(worker.worktreeRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(worker.worktreeRoot, 'src', 'leftover.ts'), 'uncommitted\n');

    const result = await validateForgeWorkerCommit({
      prepared,
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: commit,
      writeScope: [path.join(repo, 'src')],
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('dirty-worktree');
    expect(result.dirtyPaths).toContain('src/leftover.ts');
  });

  it('rejects a worktree whose ownership manifest points to a different Git common directory', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-wrong-root'),
      baseRef: 'main',
      ticketId: 'ticket-wrong-root',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const otherRepo = path.join(fixture, 'other-repo');
    await mkdir(otherRepo);
    run(otherRepo, 'init', '-b', 'main');
    run(otherRepo, 'config', 'user.name', 'Forge test');
    run(otherRepo, 'config', 'user.email', 'forge@example.invalid');
    await writeFile(path.join(otherRepo, 'other.txt'), 'other root\n');
    run(otherRepo, 'add', 'other.txt');
    run(otherRepo, 'commit', '-m', 'other root');
    const manifestPath = path.join(prepared.taskRoot, '.pseudoharness-recruitment.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { canonicalRoot: string };
    manifest.canonicalRoot = otherRepo;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateForgeWorkerCommit({
      prepared: { ...prepared, canonicalRoot: otherRepo },
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: prepared.baseCommit,
      writeScope: [path.join(otherRepo, 'src')],
    })).rejects.toThrow(/different Git repository|not a worktree belonging/i);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(prepared.baseCommit);
  });

  it('rejects stale prepared branch records and worktrees checked out on another branch', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-branch-mismatch'),
      baseRef: 'main',
      ticketId: 'ticket-branch-mismatch',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    await expect(validateForgeWorkerCommit({
      prepared: { ...prepared, workers: [{ ...worker, branch: 'main' }] },
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: prepared.baseCommit,
      writeScope: [path.join(repo, 'src')],
    })).rejects.toThrow(/branch does not match/i);

    run(worker.worktreeRoot, 'switch', '-c', 'foreign-branch');
    await expect(validateForgeWorkerCommit({
      prepared,
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: prepared.baseCommit,
      writeScope: [path.join(repo, 'src')],
    })).rejects.toThrow(/branch mismatch/i);
  });

  it('rejects an unborn main branch during worktree preparation', async () => {
    const emptyRepo = path.join(fixture, 'empty-repo');
    await mkdir(emptyRepo);
    run(emptyRepo, 'init', '-b', 'main');
    await expect(prepareForgeWorktrees({
      canonicalRoot: emptyRepo,
      taskRoot: path.join(worktrees, 'ticket-unborn'),
      baseRef: 'main',
      ticketId: 'ticket-unborn',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    })).rejects.toThrow();
    await expect(access(path.join(worktrees, 'ticket-unborn'))).rejects.toThrow();
  });

  it('builds the candidate from the latest main commit and the accepted worker commit', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-candidate'),
      baseRef: 'main',
      ticketId: 'ticket-candidate',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const main = path.join(repo, 'main.txt');
    await writeFile(main, 'latest main\n');
    run(repo, 'add', 'main.txt');
    run(repo, 'commit', '-m', 'advance main');
    const targetMainCommit = run(repo, 'rev-parse', 'HEAD');

    const worker = prepared.workers[0];
    await writeFile(path.join(worker.worktreeRoot, 'src', 'feature.ts'), 'export const feature = true;\n');
    run(worker.worktreeRoot, 'add', 'src/feature.ts');
    run(worker.worktreeRoot, 'commit', '-m', 'worker feature');
    const workerCommit = run(worker.worktreeRoot, 'rev-parse', 'HEAD');
    const result = await createForgeIntegrationCandidate({
      prepared,
      targetBranch: 'main',
      workers: [{ workerId: 'worker-a', baselineCommit: prepared.baseCommit, reportedCommit: workerCommit, writeScope: [path.join(repo, 'src')] }],
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.candidate.targetMainCommit).toBe(targetMainCommit);
    expect(result.candidate.candidateBranch).toBe(prepared.integration.branch);
    expect(result.candidate.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.candidate.workerCommits).toEqual([{ workerId: 'worker-a', commit: workerCommit }]);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(targetMainCommit);
    expect((await readFile(path.join(result.candidate.candidateRoot, 'main.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('latest main\n');
    expect((await readFile(path.join(result.candidate.candidateRoot, 'src', 'feature.ts'), 'utf8')).replace(/\r\n/g, '\n')).toBe('export const feature = true;\n');
  });

  it('returns merge conflicts as actionable evidence and preserves the isolated candidate', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-conflict'),
      baseRef: 'main',
      ticketId: 'ticket-conflict',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    const worker = prepared.workers[0];
    await writeFile(path.join(worker.worktreeRoot, 'src', 'base.ts'), 'worker version\n');
    run(worker.worktreeRoot, 'add', 'src/base.ts');
    run(worker.worktreeRoot, 'commit', '-m', 'worker edit');
    const workerInput = {
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: run(worker.worktreeRoot, 'rev-parse', 'HEAD'),
      writeScope: [path.join(repo, 'src')],
    };
    await writeFile(path.join(repo, 'src', 'base.ts'), 'main version\n');
    run(repo, 'add', 'src/base.ts');
    run(repo, 'commit', '-m', 'main edit');
    const mainCommit = run(repo, 'rev-parse', 'HEAD');

    const result = await createForgeIntegrationCandidate({ prepared, targetBranch: 'main', workers: [workerInput] });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.stage).toBe('worker');
    expect(result.targetMainCommit).toBe(mainCommit);
    expect(result.conflicts.map((item) => item.path)).toContain('src/base.ts');
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(mainCommit);
    expect(await readFile(path.join(prepared.integration.worktreeRoot, 'src', 'base.ts'), 'utf8')).toContain('<<<<<<<');
    expect(await readFile(path.join(worker.worktreeRoot, 'src', 'base.ts'), 'utf8')).toContain('worker version');
  });

  it('fast-forwards a clean checked-out main and reads back the real candidate commit', async () => {
    const { prepared, workerInput, candidate } = await makeCandidate('ticket-merge');
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-1',
        acceptedCandidateCommit: candidate.candidateCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') return;
    expect(result.strategy).toBe('fast-forward');
    expect(result.commit).toBe(candidate.candidateCommit);
    expect(run(repo, 'rev-parse', 'refs/heads/main')).toBe(candidate.candidateCommit);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(candidate.candidateCommit);
    expect(await readFile(path.join(repo, 'src', 'feature.ts'), 'utf8')).toContain('feature');
  });

  it('rejects final merge when main moved after the accepted candidate was verified', async () => {
    const { prepared, workerInput, candidate } = await makeCandidate('ticket-stale');
    await writeFile(path.join(repo, 'later.txt'), 'later main change\n');
    run(repo, 'add', 'later.txt');
    run(repo, 'commit', '-m', 'move main after verification');
    const movedMain = run(repo, 'rev-parse', 'HEAD');
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-stale',
        acceptedCandidateCommit: candidate.candidateCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('stale-target');
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(movedMain);
    expect(run(repo, 'rev-parse', 'refs/heads/main')).toBe(movedMain);
    expect(await readFile(path.join(prepared.integration.worktreeRoot, 'src', 'feature.ts'), 'utf8')).toContain('feature');
  });

  it('requires the recorded external decision to attest to both exact SHAs', async () => {
    const { prepared, workerInput, candidate } = await makeCandidate('ticket-authorization');
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-authorization',
        acceptedCandidateCommit: candidate.targetMainCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('externally recorded decision');
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(candidate.targetMainCommit);
  });

  it('refuses a dirty main checkout and preserves both user files and the candidate', async () => {
    const { prepared, workerInput, candidate } = await makeCandidate('ticket-dirty-main');
    const userFile = path.join(repo, 'user.txt');
    await writeFile(userFile, 'keep this file\n');
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-dirty',
        acceptedCandidateCommit: candidate.candidateCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toMatch(/dirty or untracked/);
    expect(await readFile(userFile, 'utf8')).toBe('keep this file\n');
    expect(run(repo, 'rev-parse', 'refs/heads/main')).toBe(candidate.targetMainCommit);
    expect(run(prepared.integration.worktreeRoot, 'rev-parse', 'HEAD')).toBe(candidate.candidateCommit);
  });

  it('uses compare-and-swap when main is not checked out in any worktree', async () => {
    const { prepared, workerInput, candidate } = await makeCandidate('ticket-cas');
    run(repo, 'checkout', '--detach');
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-cas',
        acceptedCandidateCommit: candidate.candidateCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') return;
    expect(result.strategy).toBe('compare-and-swap');
    expect(result.commit).toBe(candidate.candidateCommit);
    expect(run(repo, 'rev-parse', 'refs/heads/main')).toBe(candidate.candidateCommit);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(candidate.targetMainCommit);
  });

  it('rejects an ignored file collision before moving main', async () => {
    const prepared = await prepareForgeWorktrees({
      canonicalRoot: repo,
      taskRoot: path.join(worktrees, 'ticket-ignored'),
      baseRef: 'main',
      ticketId: 'ticket-ignored',
      attemptId: 'attempt-1',
      workerIds: ['worker-a'],
    });
    await writeFile(path.join(repo, '.gitignore'), '*.generated\n');
    run(repo, 'add', '.gitignore');
    run(repo, 'commit', '-m', 'ignore generated files');
    await writeFile(path.join(repo, 'src', 'feature.generated'), 'user-owned ignored file\n');
    const worker = prepared.workers[0];
    await writeFile(path.join(worker.worktreeRoot, 'src', 'feature.generated'), 'worker generated file\n');
    run(worker.worktreeRoot, 'add', 'src/feature.generated');
    run(worker.worktreeRoot, 'commit', '-m', 'worker generated file');
    const workerInput = {
      workerId: 'worker-a',
      baselineCommit: prepared.baseCommit,
      reportedCommit: run(worker.worktreeRoot, 'rev-parse', 'HEAD'),
      writeScope: [path.join(repo, 'src')],
    };
    const preparedCandidate = await createForgeIntegrationCandidate({ prepared, targetBranch: 'main', workers: [workerInput] });
    expect(preparedCandidate.status).toBe('ready');
    if (preparedCandidate.status !== 'ready') return;
    const candidate = preparedCandidate.candidate;
    const result = await finalizeForgeMerge({
      prepared,
      candidate,
      workers: [workerInput],
      authorization: {
        decisionId: 'forge-decision-ignored',
        acceptedCandidateCommit: candidate.candidateCommit,
        acceptedTargetMainCommit: candidate.targetMainCommit,
      },
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('collides with an unexpected');
    expect(run(repo, 'rev-parse', 'refs/heads/main')).not.toBe(candidate.candidateCommit);
    expect(await readFile(path.join(repo, 'src', 'feature.generated'), 'utf8')).toBe('user-owned ignored file\n');
  });
});
