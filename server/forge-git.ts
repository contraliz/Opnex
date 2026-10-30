import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assignmentWriteRoots } from './policy.js';
import {
  mergeRecruitmentCommits,
  prepareRecruitmentWorktrees,
  forgeGitWritableRoots,
  validateRecruitmentBranch,
  validateRecruitmentRoot,
  verifyRecruitmentIntegration,
} from './recruitment-git.js';

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export class ForgeGitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ForgeGitError';
  }
}

export type ForgeWorkerWorktree = { workerId: string; branch: string; worktreeRoot: string; baselineCommit: string };
export type PreparedForgeWorktrees = {
  canonicalRoot: string;
  taskRoot: string;
  ticketId: string;
  attemptId: string;
  baseCommit: string;
  integration: { branch: string; worktreeRoot: string };
  workers: ForgeWorkerWorktree[];
};

export type ForgeWorkerCommitInput = {
  workerId: string;
  baselineCommit: string;
  reportedCommit: string;
  writeScope: readonly string[];
};

export type ForgeWorkerCommitCheck = {
  status: 'accepted' | 'rejected';
  workerId: string;
  branch: string;
  worktreeRoot: string;
  baselineCommit: string;
  commit: string;
  changedPaths: string[];
  dirtyPaths: string[];
  outOfScopePaths: string[];
  reason?: 'commit-mismatch' | 'unrelated-baseline' | 'unrelated-history' | 'dirty-worktree' | 'invalid-write-scope' | 'out-of-scope';
};

export type ForgeCandidateEvidence = {
  ticketId: string;
  attemptId: string;
  targetBranch: string;
  targetMainCommit: string;
  candidateBranch: string;
  candidateRoot: string;
  candidateCommit: string;
  workerCommits: Array<{ workerId: string; commit: string }>;
};

export type ForgeCandidateResult =
  | { status: 'ready'; candidate: ForgeCandidateEvidence; workerChecks: ForgeWorkerCommitCheck[] }
  | {
      status: 'conflict'; stage: 'main' | 'worker'; targetMainCommit: string; targetBranch: string;
      candidateBranch: string; candidateRoot: string; candidateCommit: string;
      conflicts: Array<{ workerId?: string; path: string }>; mergedWorkerIds: string[];
    }
  | { status: 'stale-target'; targetBranch: string; expectedMainCommit: string; observedMainCommit: string; candidateRoot: string; candidateBranch: string; candidateCommit: string }
  | { status: 'rejected'; reason: string; workerChecks: ForgeWorkerCommitCheck[] };

export type ForgeMergeAuthorization = {
  decisionId: string;
  acceptedCandidateCommit: string;
  acceptedTargetMainCommit: string;
};

export type ForgeFinalMergeResult =
  | { status: 'merged'; branch: string; mainRoot?: string; commit: string; targetMainCommit: string; candidateCommit: string; strategy: 'fast-forward' | 'compare-and-swap' }
  | { status: 'stale-target'; branch: string; expectedMainCommit: string; observedMainCommit: string }
  | { status: 'rejected'; reason: string; branch: string; observedMainCommit?: string; mainRoot?: string };

type GitResult = { stdout: string; stderr: string };

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'buffer',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout: string;
    try {
      stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout));
    } catch (error) {
      throw new ForgeGitError('Git returned an unrepresentable UTF-8 path; refusing to accept incomplete scope evidence.', { cause: error });
    }
    const stderr = (Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr).trim();
    return { stdout: stdout.trim(), stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    const detail = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8').trim() : failure.stderr?.trim();
    const message = failure.code === 'ENOENT'
      ? 'Git is unavailable. Install Git or make it available on PATH.'
      : detail || failure.message || 'Git command failed.';
    throw new ForgeGitError(message, { cause: error });
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function overlaps(left: string, right: string): boolean {
  return samePath(left, right) || isWithin(left, right) || isWithin(right, left);
}

function branchSegment(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.endsWith('.') || value.endsWith('.lock')) {
    throw new ForgeGitError(`${label} must be a simple 1-64 character Git branch segment.`);
  }
  return value;
}

function forgeBranch(ticketId: string, attemptId: string, role: 'integration' | 'worker', workerId?: string): string {
  const ticket = branchSegment(ticketId, 'Ticket ID');
  const attempt = branchSegment(attemptId, 'Attempt ID');
  const branch = role === 'integration'
    ? `codex/forge/${ticket}/${attempt}/integration/head`
    : `codex/forge/${ticket}/${attempt}/worker/${branchSegment(workerId || '', 'Worker ID')}/head`;
  return validateRecruitmentBranch(branch);
}

async function directory(input: string, label: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new ForgeGitError(`${label} must be an absolute path.`);
  const info = await lstat(input).catch((error) => { throw new ForgeGitError(`${label} does not exist or cannot be inspected: ${input}`, { cause: error }); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ForgeGitError(`${label} must be a regular directory without a reparse-point link: ${input}`);
  return realpath(input).catch((error) => { throw new ForgeGitError(`${label} cannot be resolved: ${input}`, { cause: error }); });
}

async function commitAt(root: string): Promise<string> {
  const commit = (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])).stdout;
  if (!FULL_SHA.test(commit)) throw new ForgeGitError(`Worktree has no readable commit at HEAD: ${root}`);
  return commit;
}

async function branchCommit(root: string, branch: string): Promise<string> {
  const commit = (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`])).stdout;
  if (!FULL_SHA.test(commit)) throw new ForgeGitError(`Branch does not resolve to a commit: ${branch}`);
  return commit;
}

async function commonDirectory(root: string): Promise<string> {
  const value = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout;
  return realpath(value);
}

async function assertAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    const cause = error instanceof ForgeGitError ? error.cause as { code?: string | number } | undefined : undefined;
    if (cause?.code === 1) return false;
    throw error;
  }
}

function statusPaths(output: string): string[] {
  return output.split('\0').filter(Boolean).map((record) => record.slice(3)).filter(Boolean);
}

async function dirtyPaths(root: string): Promise<string[]> {
  const status = await git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return statusPaths(status.stdout);
}

async function changedPaths(root: string, from: string, to: string): Promise<string[]> {
  const output = (await git(root, ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', '--find-renames', from, to, '--'])).stdout;
  const records = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (/^[RC]/.test(status)) {
      const oldPath = records[index++];
      const newPath = records[index++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      const name = records[index++];
      if (name) paths.push(name);
    }
  }
  return [...new Set(paths)];
}

function pathsOutsideScope(root: string, changed: string[], allowed: string[]): string[] {
  return changed.filter((name) => {
    const parts = name.split('/');
    if (!name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.some((part) => !part || part === '.' || part === '..')) return true;
    const candidate = path.resolve(root, ...parts);
    return !allowed.some((scope) => samePath(scope, candidate) || isWithin(scope, candidate));
  });
}

async function assertOwnedWorktree(prepared: PreparedForgeWorktrees, workerId?: string): Promise<{ root: string; branch: string; baselineCommit: string }> {
  const worker = workerId === undefined ? undefined : prepared.workers.find((row) => row.workerId === workerId);
  if (workerId !== undefined && !worker) throw new ForgeGitError(`Worker is not recorded for this Forge attempt: ${workerId}`);
  const branch = worker?.branch || prepared.integration.branch;
  const expectedBranch = worker
    ? forgeBranch(prepared.ticketId, prepared.attemptId, 'worker', worker.workerId)
    : forgeBranch(prepared.ticketId, prepared.attemptId, 'integration');
  if (branch !== expectedBranch) throw new ForgeGitError('Forge worktree branch does not match its ticket and attempt identity.');
  const requestedRoot = worker?.worktreeRoot || prepared.integration.worktreeRoot;
  const roots = await forgeGitWritableRoots({
    canonicalRoot: prepared.canonicalRoot,
    taskRoot: prepared.taskRoot,
    ticketId: prepared.ticketId,
    attemptId: prepared.attemptId,
    role: worker ? 'worker' : 'integration',
    ...(worker ? { workerId: worker.workerId } : {}),
    worktreeRoot: requestedRoot,
  });
  const root = roots[0];
  if (!root || !branch) throw new ForgeGitError('Forge worktree ownership could not be established.');
  return { root, branch, baselineCommit: worker?.baselineCommit || prepared.baseCommit };
}

export async function prepareForgeWorktrees(options: {
  canonicalRoot: string;
  taskRoot: string;
  baseRef: string;
  ticketId: string;
  attemptId: string;
  workerIds: string[];
}): Promise<PreparedForgeWorktrees> {
  branchSegment(options.ticketId, 'Ticket ID');
  branchSegment(options.attemptId, 'Attempt ID');
  if (!Array.isArray(options.workerIds) || options.workerIds.length < 1 || options.workerIds.length > 16) throw new ForgeGitError('Provide between 1 and 16 Forge worker IDs.');
  const workerIds = options.workerIds.map((workerId) => branchSegment(workerId, 'Worker ID'));
  if (new Set(workerIds).size !== workerIds.length) throw new ForgeGitError('Forge worker IDs must be unique within an attempt.');
  if (!path.isAbsolute(options.taskRoot)) throw new ForgeGitError('Forge task root must be an absolute path.');
  const root = await validateRecruitmentRoot(options.canonicalRoot, options.baseRef);
  const taskParent = await realpath(path.dirname(path.resolve(options.taskRoot))).catch((error) => { throw new ForgeGitError('Forge task root parent does not exist or cannot be accessed.', { cause: error }); });
  if (overlaps(root.canonicalRoot, taskParent)) throw new ForgeGitError('Forge task worktrees must be stored outside the canonical project.');
  const integrationBranch = forgeBranch(options.ticketId, options.attemptId, 'integration');
  const prepared = await prepareRecruitmentWorktrees({
    canonicalRoot: root.canonicalRoot,
    taskRoot: options.taskRoot,
    baseRef: root.baseCommit,
    integrationBranch,
    workers: workerIds.map((workerId) => ({ workerId, branch: forgeBranch(options.ticketId, options.attemptId, 'worker', workerId) })),
  });
  return {
    canonicalRoot: prepared.canonicalRoot,
    taskRoot: prepared.taskRoot,
    ticketId: options.ticketId,
    attemptId: options.attemptId,
    baseCommit: prepared.baseCommit,
    integration: prepared.integration,
    workers: prepared.workers.map((worker) => ({ ...worker, baselineCommit: worker.headCommit })),
  };
}

export async function validateForgeWorkerCommit(options: {
  prepared: PreparedForgeWorktrees;
  workerId: string;
  baselineCommit: string;
  reportedCommit: string;
  writeScope: readonly string[];
}): Promise<ForgeWorkerCommitCheck> {
  const worktree = await assertOwnedWorktree(options.prepared, options.workerId);
  if (!FULL_SHA.test(options.baselineCommit) || !FULL_SHA.test(options.reportedCommit)) throw new ForgeGitError('Worker baseline and reported commit must be full commit SHAs.');
  const canonicalRoot = (await validateRecruitmentRoot(options.prepared.canonicalRoot, 'HEAD')).canonicalRoot;
  let writeRoots: string[] = [];
  let invalidScope = false;
  try {
    writeRoots = assignmentWriteRoots({ write_scope: [...options.writeScope] }, canonicalRoot);
  } catch {
    invalidScope = true;
  }
  const observedCommit = await commitAt(worktree.root);
  await git(worktree.root, ['cat-file', '-e', `${options.baselineCommit}^{commit}`]);
  const changed = await changedPaths(worktree.root, options.baselineCommit, options.reportedCommit);
  const dirty = await dirtyPaths(worktree.root);
  const outOfScope = pathsOutsideScope(canonicalRoot, changed, writeRoots);
  const result = (status: ForgeWorkerCommitCheck['status'], reason?: ForgeWorkerCommitCheck['reason']): ForgeWorkerCommitCheck => ({
    status,
    workerId: options.workerId,
    branch: worktree.branch,
    worktreeRoot: worktree.root,
    baselineCommit: options.baselineCommit,
    commit: options.reportedCommit,
    changedPaths: changed,
    dirtyPaths: dirty,
    outOfScopePaths: outOfScope,
    ...(reason ? { reason } : {}),
  });
  if (observedCommit.toLowerCase() !== options.reportedCommit.toLowerCase()) return result('rejected', 'commit-mismatch');
  if (invalidScope) return result('rejected', 'invalid-write-scope');
  if (!(await assertAncestor(worktree.root, worktree.baselineCommit, options.baselineCommit))) return result('rejected', 'unrelated-baseline');
  if (!(await assertAncestor(worktree.root, options.baselineCommit, options.reportedCommit))) return result('rejected', 'unrelated-baseline');
  const ancestry = (await git(worktree.root, ['rev-list', '--parents', `${options.baselineCommit}..${options.reportedCommit}`])).stdout;
  const commits = ancestry.split(/\r?\n/).filter(Boolean).map((line) => line.split(' '));
  const descendants = new Set(commits.map((row) => row[0]));
  if (commits.some((row) => row.slice(1).some((parent) => parent.toLowerCase() !== options.baselineCommit.toLowerCase() && !descendants.has(parent)))) {
    return result('rejected', 'unrelated-history');
  }
  if (dirty.length) return result('rejected', 'dirty-worktree');
  if (outOfScope.length) return result('rejected', 'out-of-scope');
  return result('accepted');
}

async function conflictPaths(root: string): Promise<string[]> {
  const output = (await git(root, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '-z', '--'])).stdout;
  return [...new Set(output.split('\0').filter(Boolean))];
}

type WorktreeRecord = { root: string; branch?: string };

function worktreeRecords(output: string): WorktreeRecord[] {
  const rows: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) rows.push(current);
      current = { root: path.resolve(line.slice('worktree '.length)) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current) rows.push(current);
  return rows;
}

async function listedWorktrees(root: string): Promise<WorktreeRecord[]> {
  return worktreeRecords((await git(root, ['worktree', 'list', '--porcelain'])).stdout);
}

async function operationInProgress(root: string): Promise<boolean> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_LOG']) {
    const marker = (await git(root, ['rev-parse', '--git-path', name])).stdout;
    try {
      await lstat(path.resolve(root, marker));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function trackedPaths(root: string, relative: string): Promise<string[]> {
  const output = (await git(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative])).stdout;
  return output.split('\0').filter(Boolean).map((row) => row.slice(row.indexOf('\t') + 1));
}

async function ignoredPathCollision(root: string, relative: string): Promise<boolean> {
  const parts = relative.split('/');
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || parts.some((part) => !part || part === '.' || part === '..')) return true;
  let current = root;
  const indexedPaths = await trackedPaths(root, relative);
  const tracked = indexedPaths.includes(relative);
  if (!tracked && indexedPaths.some((name) => name.toLowerCase() === relative.toLowerCase())) return true;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new ForgeGitError(`Could not inspect candidate destination ${relative}.`, { cause: error });
    }
    if ((info.isSymbolicLink() && (index < parts.length - 1 || !tracked)) || (index < parts.length - 1 && !info.isDirectory())) return true;
    if (index === parts.length - 1 && !tracked) return true;
  }
  return false;
}

async function mainWorktree(root: string, branch: string): Promise<WorktreeRecord | undefined> {
  const matches = (await listedWorktrees(root)).filter((row) => row.branch === `refs/heads/${branch}`);
  if (matches.length > 1) throw new ForgeGitError(`Git reports more than one worktree for ${branch}.`);
  return matches[0];
}

async function cleanMainWorktree(root: string, canonicalRoot: string, branch: string, expectedCommit: string): Promise<string | undefined> {
  const main = await directory(root, 'Current main worktree');
  const top = await realpath((await git(main, ['rev-parse', '--show-toplevel'])).stdout);
  if (!samePath(main, top)) throw new ForgeGitError('Current main worktree path is not its exact Git root.');
  if (!samePath(await commonDirectory(main), await commonDirectory(canonicalRoot))) throw new ForgeGitError('Current main worktree belongs to a different Git repository.');
  const branchName = (await git(main, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  if (branchName !== branch) throw new ForgeGitError(`Current main worktree is on ${branchName || 'detached HEAD'}, not ${branch}.`);
  if ((await commitAt(main)).toLowerCase() !== expectedCommit.toLowerCase()) throw new ForgeGitError('Current main worktree HEAD does not match the current main branch ref.');
  const dirty = await dirtyPaths(main);
  if (dirty.length) return `Current main worktree contains dirty or untracked paths: ${dirty.join(', ')}`;
  if (await operationInProgress(main)) return 'Current main worktree has an unfinished Git operation.';
  return undefined;
}

async function candidateMatches(prepared: PreparedForgeWorktrees, candidate: ForgeCandidateEvidence, workers: ForgeWorkerCommitInput[]): Promise<{ root: string; outOfScope: string[] } | ForgeFinalMergeResult> {
  if (candidate.ticketId !== prepared.ticketId || candidate.attemptId !== prepared.attemptId
    || candidate.candidateBranch !== prepared.integration.branch || !samePath(candidate.candidateRoot, prepared.integration.worktreeRoot)
    || candidate.candidateBranch !== forgeBranch(prepared.ticketId, prepared.attemptId, 'integration')
    || !FULL_SHA.test(candidate.targetMainCommit) || !FULL_SHA.test(candidate.candidateCommit)) {
    return { status: 'rejected', reason: 'Candidate identity or commit evidence does not match the prepared Forge attempt.', branch: candidate.targetBranch };
  }
  checkedWorkers(prepared, workers);
  const expectedCommits = workers.map((worker) => `${worker.workerId}\0${worker.reportedCommit.toLowerCase()}`).sort();
  const recordedCommits = Array.isArray(candidate.workerCommits)
    ? candidate.workerCommits.map((worker) => `${worker.workerId}\0${worker.commit.toLowerCase()}`).sort()
    : [];
  if (expectedCommits.length !== recordedCommits.length || expectedCommits.some((commit, index) => commit !== recordedCommits[index])) {
    return { status: 'rejected', reason: 'Candidate worker commit set does not match the final verification set.', branch: candidate.targetBranch };
  }
  const worktree = await assertOwnedWorktree(prepared);
  if (!samePath(worktree.root, candidate.candidateRoot) || worktree.branch !== candidate.candidateBranch) {
    return { status: 'rejected', reason: 'Candidate worktree is not the recorded Forge integration branch.', branch: candidate.targetBranch };
  }
  const candidateHead = await commitAt(worktree.root);
  if (candidateHead.toLowerCase() !== candidate.candidateCommit.toLowerCase()
    || (await branchCommit(prepared.canonicalRoot, candidate.candidateBranch)).toLowerCase() !== candidate.candidateCommit.toLowerCase()) {
    return { status: 'rejected', reason: 'Candidate branch or worktree moved after verification.', branch: candidate.targetBranch };
  }
  const dirty = await dirtyPaths(worktree.root);
  if (dirty.length || await operationInProgress(worktree.root)) return { status: 'rejected', reason: 'Candidate worktree is dirty or has an unfinished Git operation.', branch: candidate.targetBranch };
  const checks = await Promise.all(workers.map((worker) => validateForgeWorkerCommit({ prepared, ...worker })));
  const failed = checks.find((check) => check.status !== 'accepted');
  if (failed) return { status: 'rejected', reason: `Worker ${failed.workerId} commit failed final scope validation (${failed.reason || 'unknown'}).`, branch: candidate.targetBranch };
  try {
    await verifyRecruitmentIntegration({
      canonicalRoot: prepared.canonicalRoot,
      integrationRoot: worktree.root,
      integrationBranch: worktree.branch,
      integrationBaseCommit: candidate.targetMainCommit,
      workerCommits: workers.map((worker) => ({ workerId: worker.workerId, commit: worker.reportedCommit })),
    });
  } catch (error) {
    return { status: 'rejected', reason: error instanceof Error ? error.message : 'Candidate ancestry validation failed.', branch: candidate.targetBranch };
  }
  const roots = [...new Set(workers.flatMap((worker) => assignmentWriteRoots({ write_scope: [...worker.writeScope] }, prepared.canonicalRoot)))];
  const actualChanges = await changedPaths(worktree.root, candidate.targetMainCommit, candidate.candidateCommit);
  return { root: worktree.root, outOfScope: pathsOutsideScope(prepared.canonicalRoot, actualChanges, roots) };
}

export async function finalizeForgeMerge(options: {
  prepared: PreparedForgeWorktrees;
  candidate: ForgeCandidateEvidence;
  workers: ForgeWorkerCommitInput[];
  authorization: ForgeMergeAuthorization;
}): Promise<ForgeFinalMergeResult> {
  const { candidate, prepared } = options;
  const branch = validateRecruitmentBranch(candidate.targetBranch);
  if (typeof options.authorization?.decisionId !== 'string' || !options.authorization.decisionId.trim()
    || options.authorization.acceptedCandidateCommit?.toLowerCase() !== candidate.candidateCommit.toLowerCase()
    || options.authorization.acceptedTargetMainCommit?.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
    return { status: 'rejected', reason: 'An externally recorded decision must attest to this exact candidate and target-main commit.', branch };
  }
  let currentMain: string;
  try {
    currentMain = (await validateRecruitmentRoot(prepared.canonicalRoot, branch)).baseCommit;
  } catch (error) {
    return { status: 'rejected', reason: error instanceof Error ? error.message : 'Current target branch is unavailable.', branch };
  }
  if (currentMain.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
    return { status: 'stale-target', branch, expectedMainCommit: candidate.targetMainCommit, observedMainCommit: currentMain };
  }
  const validatedCandidate = await candidateMatches(prepared, candidate, options.workers);
  if ('status' in validatedCandidate) return validatedCandidate;
  if (validatedCandidate.outOfScope.length) return { status: 'rejected', reason: `Candidate includes changes outside accepted scopes: ${validatedCandidate.outOfScope.join(', ')}`, branch };
  if (!(await assertAncestor(prepared.canonicalRoot, candidate.targetMainCommit, candidate.candidateCommit))) {
    return { status: 'rejected', reason: 'Candidate is not based on the accepted target-main commit.', branch };
  }
  const candidateChanges = await changedPaths(prepared.canonicalRoot, candidate.targetMainCommit, candidate.candidateCommit);
  const checkedOut = await mainWorktree(prepared.canonicalRoot, branch);
  if (checkedOut) {
    const unsafe = await cleanMainWorktree(checkedOut.root, prepared.canonicalRoot, branch, candidate.targetMainCommit);
    if (unsafe) return { status: 'rejected', reason: unsafe, branch, mainRoot: checkedOut.root };
    for (const relative of candidateChanges) {
      if (await ignoredPathCollision(checkedOut.root, relative)) {
        return { status: 'rejected', reason: `Candidate path collides with an unexpected main-worktree file: ${relative}`, branch, mainRoot: checkedOut.root };
      }
    }
    const beforeMerge = (await validateRecruitmentRoot(prepared.canonicalRoot, branch)).baseCommit;
    if (beforeMerge.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
      return { status: 'stale-target', branch, expectedMainCommit: candidate.targetMainCommit, observedMainCommit: beforeMerge };
    }
    try {
      await git(checkedOut.root, ['merge', '--ff-only', candidate.candidateCommit]);
    } catch (error) {
      const observed = await validateRecruitmentRoot(prepared.canonicalRoot, branch).then((result) => result.baseCommit).catch(() => '');
      if (observed && observed.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
        return { status: 'stale-target', branch, expectedMainCommit: candidate.targetMainCommit, observedMainCommit: observed };
      }
      return { status: 'rejected', reason: error instanceof Error ? error.message : 'Safe fast-forward failed.', branch, mainRoot: checkedOut.root, ...(observed ? { observedMainCommit: observed } : {}) };
    }
    const actual = (await validateRecruitmentRoot(prepared.canonicalRoot, branch)).baseCommit;
    if (actual.toLowerCase() !== candidate.candidateCommit.toLowerCase() || (await commitAt(checkedOut.root)).toLowerCase() !== candidate.candidateCommit.toLowerCase()) {
      return { status: 'rejected', reason: 'Main merge did not read back as the accepted candidate commit.', branch, observedMainCommit: actual, mainRoot: checkedOut.root };
    }
    const dirty = await dirtyPaths(checkedOut.root);
    if (dirty.length) return { status: 'rejected', reason: `Main worktree is not clean after the fast-forward: ${dirty.join(', ')}`, branch, observedMainCommit: actual, mainRoot: checkedOut.root };
    return { status: 'merged', branch, mainRoot: checkedOut.root, commit: actual, targetMainCommit: candidate.targetMainCommit, candidateCommit: candidate.candidateCommit, strategy: 'fast-forward' };
  }

  const beforeUpdate = (await validateRecruitmentRoot(prepared.canonicalRoot, branch)).baseCommit;
  if (beforeUpdate.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
    return { status: 'stale-target', branch, expectedMainCommit: candidate.targetMainCommit, observedMainCommit: beforeUpdate };
  }
  try {
    await git(prepared.canonicalRoot, ['update-ref', `refs/heads/${branch}`, candidate.candidateCommit, candidate.targetMainCommit]);
  } catch (error) {
    const observed = await validateRecruitmentRoot(prepared.canonicalRoot, branch).then((result) => result.baseCommit).catch(() => '');
    if (observed && observed.toLowerCase() !== candidate.targetMainCommit.toLowerCase()) {
      return { status: 'stale-target', branch, expectedMainCommit: candidate.targetMainCommit, observedMainCommit: observed };
    }
    return { status: 'rejected', reason: error instanceof Error ? error.message : 'Compare-and-swap on the target ref failed.', branch, ...(observed ? { observedMainCommit: observed } : {}) };
  }
  const actual = (await validateRecruitmentRoot(prepared.canonicalRoot, branch)).baseCommit;
  if (actual.toLowerCase() !== candidate.candidateCommit.toLowerCase()) {
    return { status: 'rejected', reason: 'Target ref did not read back as the accepted candidate commit.', branch, observedMainCommit: actual };
  }
  const appeared = await mainWorktree(prepared.canonicalRoot, branch);
  if (appeared) {
    const checkoutHead = await commitAt(appeared.root).catch(() => '');
    const checkoutDirty = await dirtyPaths(appeared.root).catch(() => ['unknown']);
    if (checkoutHead.toLowerCase() !== candidate.candidateCommit.toLowerCase() || checkoutDirty.length) {
      return { status: 'rejected', reason: 'The main branch was checked out concurrently with the compare-and-swap; inspect this worktree before completing the ticket.', branch, observedMainCommit: actual, mainRoot: appeared.root };
    }
  }
  return { status: 'merged', branch, ...(appeared ? { mainRoot: appeared.root } : {}), commit: actual, targetMainCommit: candidate.targetMainCommit, candidateCommit: candidate.candidateCommit, strategy: 'compare-and-swap' };
}

function checkedWorkers(prepared: PreparedForgeWorktrees, workers: ForgeWorkerCommitInput[]): void {
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > 16) throw new ForgeGitError('Provide between 1 and 16 committed Forge workers.');
  const ids = new Set<string>();
  for (const worker of workers) {
    if (ids.has(worker.workerId)) throw new ForgeGitError(`Worker appears more than once in Forge integration: ${worker.workerId}`);
    ids.add(worker.workerId);
    if (!prepared.workers.some((row) => row.workerId === worker.workerId)) throw new ForgeGitError(`Worker is not recorded for this Forge attempt: ${worker.workerId}`);
  }
}

export async function createForgeIntegrationCandidate(options: {
  prepared: PreparedForgeWorktrees;
  targetBranch: string;
  workers: ForgeWorkerCommitInput[];
}): Promise<ForgeCandidateResult> {
  checkedWorkers(options.prepared, options.workers);
  const targetBranch = validateRecruitmentBranch(options.targetBranch);
  const integration = await assertOwnedWorktree(options.prepared);
  const integrationHead = await commitAt(integration.root);
  if ((await branchCommit(options.prepared.canonicalRoot, integration.branch)).toLowerCase() !== integrationHead.toLowerCase()) {
    throw new ForgeGitError('Forge integration branch ref and worktree HEAD do not match.');
  }
  const target = await validateRecruitmentRoot(options.prepared.canonicalRoot, targetBranch);
  const targetMainCommit = target.baseCommit;
  const checks = await Promise.all(options.workers.map((worker) => validateForgeWorkerCommit({ prepared: options.prepared, ...worker })));
  if (checks.some((check) => check.status !== 'accepted')) {
    return { status: 'rejected', reason: 'One or more worker commits failed saved-commit or write-scope validation.', workerChecks: checks };
  }
  const initialConflicts = await conflictPaths(integration.root);
  if (initialConflicts.length) {
    return {
      status: 'conflict', stage: 'worker', targetMainCommit, targetBranch, candidateBranch: integration.branch,
      candidateRoot: integration.root, candidateCommit: integrationHead,
      conflicts: initialConflicts.map((file) => ({ path: file })), mergedWorkerIds: [],
    };
  }
  const dirty = await dirtyPaths(integration.root);
  if (dirty.length) return { status: 'rejected', reason: 'Forge integration worktree contains uncommitted or untracked files.', workerChecks: checks };

  if (!(await assertAncestor(integration.root, targetMainCommit, integrationHead))) {
    try {
      await git(integration.root, ['merge', '--no-ff', '--no-edit', targetMainCommit]);
    } catch (error) {
      const conflicts = await conflictPaths(integration.root);
      if (!conflicts.length) throw error;
      return {
        status: 'conflict', stage: 'main', targetMainCommit, targetBranch, candidateBranch: integration.branch,
        candidateRoot: integration.root, candidateCommit: await commitAt(integration.root),
        conflicts: conflicts.map((file) => ({ path: file })), mergedWorkerIds: [],
      };
    }
  }

  const merged = await mergeRecruitmentCommits({
    canonicalRoot: options.prepared.canonicalRoot,
    integrationRoot: integration.root,
    workers: options.workers.map((worker) => ({
      workerId: worker.workerId,
      branch: options.prepared.workers.find((row) => row.workerId === worker.workerId)!.branch,
      headCommit: worker.reportedCommit,
    })),
  });
  if (merged.status === 'conflict') {
    return {
      status: 'conflict', stage: 'worker', targetMainCommit, targetBranch, candidateBranch: integration.branch,
      candidateRoot: integration.root, candidateCommit: merged.integrationHead,
      conflicts: merged.conflicts.flatMap((entry) => entry.files.map((file) => ({ workerId: entry.workerId, path: file }))),
      mergedWorkerIds: merged.merged.map((entry) => entry.workerId),
    };
  }
  const workerCommits = options.workers.map((worker) => ({ workerId: worker.workerId, commit: worker.reportedCommit }));
  await verifyRecruitmentIntegration({
    canonicalRoot: options.prepared.canonicalRoot,
    integrationRoot: integration.root,
    integrationBranch: integration.branch,
    integrationBaseCommit: targetMainCommit,
    workerCommits: workerCommits.map((worker) => ({ workerId: worker.workerId, commit: worker.commit })),
  });
  const candidateCommit = await commitAt(integration.root);
  const allowedPaths = [...new Set(options.workers.flatMap((worker) => {
    const roots = assignmentWriteRoots({ write_scope: [...worker.writeScope] }, target.canonicalRoot);
    return roots;
  }))];
  const candidateChanges = await changedPaths(integration.root, targetMainCommit, candidateCommit);
  const outOfScope = pathsOutsideScope(target.canonicalRoot, candidateChanges, allowedPaths);
  if (outOfScope.length) return { status: 'rejected', reason: `Composed candidate has changes outside accepted worker scopes: ${outOfScope.join(', ')}`, workerChecks: checks };
  const observedMain = (await validateRecruitmentRoot(options.prepared.canonicalRoot, targetBranch)).baseCommit;
  if (observedMain.toLowerCase() !== targetMainCommit.toLowerCase()) {
    return {
      status: 'stale-target', targetBranch, expectedMainCommit: targetMainCommit, observedMainCommit: observedMain,
      candidateRoot: integration.root, candidateBranch: integration.branch, candidateCommit,
    };
  }
  return {
    status: 'ready',
    candidate: {
      ticketId: options.prepared.ticketId,
      attemptId: options.prepared.attemptId,
      targetBranch,
      targetMainCommit,
      candidateBranch: integration.branch,
      candidateRoot: integration.root,
      candidateCommit,
      workerCommits,
    },
    workerChecks: checks,
  };
}
