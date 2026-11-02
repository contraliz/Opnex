import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathIdentity, samePath } from './path-identity.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;

export type GitResult = { stdout: string; stderr: string };

export class RecruitmentGitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecruitmentGitError';
  }
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    const detail = failure.stderr?.trim();
    const message =
      failure.code === 'ENOENT'
        ? 'Git is unavailable. Install Git or make it available on PATH.'
        : detail || failure.message || 'Git command failed.';
    throw new RecruitmentGitError(message, { cause: error });
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..') {
    throw new RecruitmentGitError(
      `${label} must be a simple 1-64 character identifier using letters, numbers, dot, underscore, or hyphen.`
    );
  }
  return value;
}

export function recruitmentWorkspaceRoot(
  stateRoot: string,
  taskId: string,
  passId: string,
  teamId?: string
): string {
  const task = safeSegment(taskId, 'Task ID').replaceAll('-', '');
  const pass = safeSegment(passId, 'Pass ID').replaceAll('-', '');
  const team = teamId ? safeSegment(teamId, 'Team ID').replaceAll('-', '') : '';
  const key = createHash('sha256')
    .update(`${task}\0${pass}${team ? `\0${team}` : ''}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(stateRoot, 'rw', key);
}

export async function recruitmentGitWritableRoots(
  canonicalRoot: string,
  worktreeRoot: string,
  branch: string
): Promise<string[]> {
  const { projectRoot } = await validateRecruitmentProject(canonicalRoot, 'HEAD');
  const branchParts = validateRecruitmentBranch(branch).split('/');
  if (branchParts.length !== 4 || branchParts[0] !== 'recruitment') {
    throw new RecruitmentGitError(
      'Worker branches must use the task and worker namespace required for scoped Git writes.'
    );
  }
  const worktree = await canonicalDirectory(worktreeRoot, 'Worker worktree');
  const topLevel = await realpath((await git(worktree, ['rev-parse', '--show-toplevel'])).stdout);
  if (!samePath(topLevel, worktree))
    throw new RecruitmentGitError('Worker write roots require the exact worktree root.');
  const commonDirectory = await realpath(
    (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout
  );
  const canonicalCommonDirectory = await realpath(
    (await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout
  );
  if (!samePath(commonDirectory, canonicalCommonDirectory))
    throw new RecruitmentGitError('Worker worktree belongs to a different Git repository.');
  const adminDirectory = await realpath(
    (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'])).stdout
  );
  const adminParent = path.join(commonDirectory, 'worktrees');
  if (!isWithin(adminParent, adminDirectory))
    throw new RecruitmentGitError(
      'Worker Git metadata is not isolated under this repository’s worktree administration directory.'
    );
  const refNamespace = path.join(commonDirectory, 'refs', 'heads', ...branchParts.slice(0, 3));
  const logNamespace = path.join(
    commonDirectory,
    'logs',
    'refs',
    'heads',
    ...branchParts.slice(0, 3)
  );
  for (const root of [refNamespace, logNamespace]) {
    const resolved = path.resolve(root);
    if (!isWithin(commonDirectory, resolved))
      throw new RecruitmentGitError(
        'Worker Git ref write root escaped the shared repository metadata directory.'
      );
  }
  return [worktree, adminDirectory, refNamespace, logNamespace];
}

export type ForgeGitWorktreeRole = 'integration' | 'worker';

function forgeBranchPart(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    throw new RecruitmentGitError(`${label} must be a simple 1-64 character Forge branch segment.`);
  }
  return value;
}

function forgeOwnedBranch(
  ticketId: string,
  attemptId: string,
  role: ForgeGitWorktreeRole,
  workerId?: string
): string {
  const ticket = forgeBranchPart(ticketId, 'Ticket ID');
  const attempt = forgeBranchPart(attemptId, 'Attempt ID');
  const branch =
    role === 'integration'
      ? `codex/forge/${ticket}/${attempt}/integration/head`
      : `codex/forge/${ticket}/${attempt}/worker/${forgeBranchPart(workerId || '', 'Worker ID')}/head`;
  return validateRecruitmentBranch(branch);
}

async function assertSafeDirectoryTree(
  parent: string,
  target: string,
  label: string,
  allowMissingTail = false
): Promise<void> {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedParent, resolvedTarget);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RecruitmentGitError(`${label} escaped its canonical parent.`);
  }
  let current = resolvedParent;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new RecruitmentGitError(`${label} is missing or cannot be inspected: ${current}`, {
        cause: error,
      });
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new RecruitmentGitError(
        `${label} contains an unsafe reparse point or non-directory: ${current}`
      );
    const canonical = await realpath(current);
    if (!samePath(current, canonical))
      throw new RecruitmentGitError(`${label} is not on a canonical path: ${current}`);
  }
}

/** Returns only the filesystem roots needed for this exact Forge worktree and its attempt-scoped Git refs. */
export async function forgeGitWritableRoots(options: {
  canonicalRoot: string;
  taskRoot: string;
  ticketId: string;
  attemptId: string;
  role: ForgeGitWorktreeRole;
  workerId?: string;
  worktreeRoot: string;
}): Promise<string[]> {
  const project = await validateRecruitmentProject(options.canonicalRoot, 'HEAD');
  if (options.role !== 'integration' && options.role !== 'worker')
    throw new RecruitmentGitError('Forge worktree role is invalid.');
  if (!path.isAbsolute(options.taskRoot) || !path.isAbsolute(options.worktreeRoot))
    throw new RecruitmentGitError('Forge task and worktree roots must be absolute paths.');
  const taskInput = path.resolve(options.taskRoot);
  const taskInfo = await lstat(taskInput).catch((error) => {
    throw new RecruitmentGitError('Forge task root is missing or inaccessible.', { cause: error });
  });
  if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink())
    throw new RecruitmentGitError(
      'Forge task root must be a regular directory without a reparse-point link.'
    );
  const taskRoot = await realpath(taskInput);
  if (!samePath(taskRoot, taskInput))
    throw new RecruitmentGitError('Forge task root must use its canonical non-reparse path.');
  if (
    samePath(taskRoot, project.projectRoot) ||
    isWithin(project.projectRoot, taskRoot) ||
    isWithin(taskRoot, project.projectRoot)
  ) {
    throw new RecruitmentGitError(
      'Forge task root must be outside and disjoint from the canonical project.'
    );
  }
  const ticketId = forgeBranchPart(options.ticketId, 'Ticket ID');
  const attemptId = forgeBranchPart(options.attemptId, 'Attempt ID');
  const integrationBranch = forgeOwnedBranch(ticketId, attemptId, 'integration');
  const manifestPath = path.join(taskRoot, TASK_MANIFEST);
  const manifestInfo = await lstat(manifestPath).catch((error) => {
    throw new RecruitmentGitError('Forge ownership manifest is missing or inaccessible.', {
      cause: error,
    });
  });
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new RecruitmentGitError('Forge ownership manifest must be a regular file.');
  const manifest = await readTaskManifest(project.projectRoot, taskRoot);
  if (
    manifest.integration.branch !== integrationBranch ||
    !samePath(manifest.integration.worktreeRoot, path.join(taskRoot, 'integration'))
  ) {
    throw new RecruitmentGitError(
      'Forge integration worktree does not match its ticket/attempt ownership manifest.'
    );
  }
  const workerIds = new Set<string>();
  const workerBranches = new Set<string>();
  for (const worker of manifest.workers) {
    const workerId = forgeBranchPart(worker.workerId, 'Worker ID');
    const expectedBranch = forgeOwnedBranch(ticketId, attemptId, 'worker', workerId);
    if (
      workerIds.has(workerId) ||
      workerBranches.has(expectedBranch) ||
      worker.branch !== expectedBranch ||
      !samePath(worker.worktreeRoot, path.join(taskRoot, `worker-${workerId}`))
    ) {
      throw new RecruitmentGitError(
        'Forge worker entries do not match their ticket/attempt ownership manifest.'
      );
    }
    workerIds.add(workerId);
    workerBranches.add(expectedBranch);
  }

  const branch =
    options.role === 'integration'
      ? integrationBranch
      : forgeOwnedBranch(ticketId, attemptId, 'worker', options.workerId);
  if (options.role === 'worker' && !workerIds.has(options.workerId || ''))
    throw new RecruitmentGitError('Forge worker is not recorded in this ticket/attempt manifest.');
  const expectedWorktree =
    options.role === 'integration'
      ? path.join(taskRoot, 'integration')
      : path.join(taskRoot, `worker-${options.workerId}`);
  if (!samePath(options.worktreeRoot, expectedWorktree))
    throw new RecruitmentGitError(
      'Forge worktree root does not match its generated task-owned location.'
    );
  const worktreeInput = path.resolve(options.worktreeRoot);
  const worktreeInfo = await lstat(worktreeInput).catch((error) => {
    throw new RecruitmentGitError('Forge worktree is missing or inaccessible.', { cause: error });
  });
  if (!worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink())
    throw new RecruitmentGitError(
      'Forge worktree must be a regular directory without a reparse-point link.'
    );
  const worktree = await realpath(worktreeInput);
  if (!samePath(worktree, expectedWorktree) || !isWithin(taskRoot, worktree))
    throw new RecruitmentGitError('Forge worktree resolved outside its exact task-owned location.');
  const validatedWorktree = await validateOwnedLocation(
    project.projectRoot,
    taskRoot,
    worktree,
    branch
  );
  const topLevel = await realpath(
    (await git(validatedWorktree, ['rev-parse', '--show-toplevel'])).stdout
  );
  if (!samePath(topLevel, worktree))
    throw new RecruitmentGitError('Forge writable roots require the exact Git worktree root.');
  const worktreeHead = await commitAt(validatedWorktree);
  const branchHead = (
    await git(project.projectRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}^{commit}`,
    ])
  ).stdout;
  if (
    !/^[0-9a-f]{40,64}$/i.test(branchHead) ||
    worktreeHead.toLowerCase() !== branchHead.toLowerCase()
  ) {
    throw new RecruitmentGitError(
      'Forge worktree HEAD no longer matches its attempt-owned branch ref.'
    );
  }
  const commonDirectory = await realpath(
    (await git(validatedWorktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      .stdout
  );
  const canonicalCommonDirectory = await realpath(
    (await git(project.projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      .stdout
  );
  if (!samePath(commonDirectory, canonicalCommonDirectory))
    throw new RecruitmentGitError('Forge worktree belongs to a different Git repository.');
  const adminPath = (
    await git(validatedWorktree, ['rev-parse', '--path-format=absolute', '--git-dir'])
  ).stdout;
  const adminDirectory = await realpath(adminPath);
  const adminParent = path.join(commonDirectory, 'worktrees');
  if (!isWithin(adminParent, adminDirectory))
    throw new RecruitmentGitError(
      'Forge worktree Git metadata is not isolated under this repository’s worktree administration directory.'
    );
  await assertSafeDirectoryTree(commonDirectory, adminDirectory, 'Forge worktree Git metadata');
  const namespace =
    options.role === 'integration' ? ['integration'] : ['worker', options.workerId || ''];
  const refNamespace = path.resolve(
    commonDirectory,
    'refs',
    'heads',
    'codex',
    'forge',
    ticketId,
    attemptId,
    ...namespace
  );
  const logNamespace = path.resolve(
    commonDirectory,
    'logs',
    'refs',
    'heads',
    'codex',
    'forge',
    ticketId,
    attemptId,
    ...namespace
  );
  for (const root of [refNamespace, logNamespace]) {
    if (!isWithin(commonDirectory, root))
      throw new RecruitmentGitError(
        'Forge Git ref write root escaped the repository metadata directory.'
      );
  }
  await assertSafeDirectoryTree(commonDirectory, refNamespace, 'Forge ref namespace', true);
  await assertSafeDirectoryTree(commonDirectory, logNamespace, 'Forge reflog namespace', true);
  return [worktree, adminDirectory, refNamespace, logNamespace];
}

export function validateRecruitmentBranch(branch: string): string {
  if (
    typeof branch !== 'string' ||
    branch.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
  ) {
    throw new RecruitmentGitError('Branch name contains unsupported characters or is too long.');
  }
  if (
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('@{')
  ) {
    throw new RecruitmentGitError('Branch name contains a Git path or ref traversal pattern.');
  }
  if (
    branch
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.lock') || part === '@')
  ) {
    throw new RecruitmentGitError('Branch name contains an invalid Git ref component.');
  }
  return branch;
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input))
    throw new RecruitmentGitError(`${label} must be an absolute path.`);
  try {
    const resolved = await realpath(input);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new RecruitmentGitError(`${label} is not a directory: ${input}`);
    return resolved;
  } catch (error) {
    if (error instanceof RecruitmentGitError) throw error;
    throw new RecruitmentGitError(`${label} does not exist or cannot be accessed: ${input}`, {
      cause: error,
    });
  }
}

export async function validateRecruitmentProject(
  projectRoot: string,
  baseRef: string
): Promise<{ projectRoot: string; baseRef: string; baseCommit: string }> {
  const root = await canonicalDirectory(projectRoot, 'Project root');
  let topLevel: string;
  try {
    topLevel = (await git(root, ['rev-parse', '--show-toplevel'])).stdout;
  } catch (error) {
    throw new RecruitmentGitError(`Project root is not a Git worktree: ${root}`, { cause: error });
  }
  const canonicalTop = await realpath(topLevel);
  if (!samePath(canonicalTop, root)) {
    throw new RecruitmentGitError(
      `Project root must be the Git worktree root, not a subdirectory: ${root}`
    );
  }
  if (
    typeof baseRef !== 'string' ||
    !baseRef.trim() ||
    baseRef.startsWith('-') ||
    baseRef.length > 255
  ) {
    throw new RecruitmentGitError('Selected base ref is missing or invalid.');
  }
  let commit: GitResult;
  try {
    commit = await git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${baseRef}^{commit}`,
    ]);
  } catch (error) {
    throw new RecruitmentGitError(
      `Selected base ref could not be resolved to a commit: ${baseRef}`,
      { cause: error }
    );
  }
  if (!/^[0-9a-f]{40,64}$/i.test(commit.stdout))
    throw new RecruitmentGitError(`Selected base ref does not resolve to a commit: ${baseRef}`);
  return { projectRoot: root, baseRef, baseCommit: commit.stdout };
}

async function assertBranchAvailable(projectRoot: string, branch: string): Promise<void> {
  validateRecruitmentBranch(branch);
  const result = await git(projectRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).catch((error: unknown) => {
    if (
      error instanceof RecruitmentGitError &&
      (error.cause as { code?: string | number } | undefined)?.code === 1
    )
      return null;
    throw error;
  });
  if (result) throw new RecruitmentGitError(`Branch already exists: ${branch}`);
}

export async function validateRecruitmentRoot(
  canonicalRoot: string,
  baseRef: string
): Promise<{ canonicalRoot: string; baseCommit: string }> {
  const validated = await validateRecruitmentProject(canonicalRoot, baseRef);
  return { canonicalRoot: validated.projectRoot, baseCommit: validated.baseCommit };
}

export async function validateRecruitmentWorkspaceRoot(
  projectRoot: string
): Promise<{ canonicalRoot: string }> {
  return { canonicalRoot: await canonicalDirectory(projectRoot, 'Project root') };
}

export async function readRecruitmentBranchHead(
  canonicalRoot: string,
  branch: string
): Promise<string> {
  const { projectRoot } = await validateRecruitmentProject(canonicalRoot, 'HEAD');
  validateRecruitmentBranch(branch);
  const result = await git(projectRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `refs/heads/${branch}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40,64}$/i.test(result.stdout))
    throw new RecruitmentGitError(`Branch does not resolve to a commit: ${branch}`);
  return result.stdout;
}

export type PreparedRecruitmentWorker = {
  workerId: string;
  branch: string;
  worktreeRoot: string;
  headCommit: string;
};
export type PreparedRecruitmentWorktrees = {
  canonicalRoot: string;
  taskRoot: string;
  baseCommit: string;
  integration: { branch: string; worktreeRoot: string };
  workers: PreparedRecruitmentWorker[];
};

type TaskManifest = {
  version: 1;
  canonicalRoot: string;
  integration: { branch: string; worktreeRoot: string };
  workers: Array<{ workerId: string; branch: string; worktreeRoot: string }>;
};

const TASK_MANIFEST = '.opnex-recruitment.json';
const LEGACY_TASK_MANIFEST = '.pseudoharness-recruitment.json';

export async function prepareRecruitmentWorktrees(options: {
  canonicalRoot: string;
  taskRoot: string;
  baseRef: string;
  workers: Array<{ workerId: string; branch: string }>;
  integrationBranch: string;
}): Promise<PreparedRecruitmentWorktrees> {
  const validated = await validateRecruitmentProject(options.canonicalRoot, options.baseRef);
  if (
    !Array.isArray(options.workers) ||
    options.workers.length === 0 ||
    options.workers.length > 16
  ) {
    throw new RecruitmentGitError('Provide between 1 and 16 workers.');
  }
  const integrationBranch = validateRecruitmentBranch(options.integrationBranch);
  const workers = options.workers.map((worker) => ({
    workerId: safeSegment(worker.workerId, 'Worker ID'),
    branch: validateRecruitmentBranch(worker.branch),
  }));
  const allBranches = [integrationBranch, ...workers.map((worker) => worker.branch)];
  if (new Set(allBranches).size !== allBranches.length)
    throw new RecruitmentGitError('Every worker and integration branch must be unique.');
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length)
    throw new RecruitmentGitError('Worker IDs must be unique.');
  if (!path.isAbsolute(options.taskRoot))
    throw new RecruitmentGitError('Task root must be an absolute path.');
  const requestedTaskRoot = path.resolve(options.taskRoot);
  // Canonicalize the existing parent before checking containment. macOS commonly
  // exposes /tmp through /private/tmp, and Windows can return a different spelling
  // (for example a short name) from realpath. Those aliases are the same directory.
  const parent = await canonicalDirectory(path.dirname(requestedTaskRoot), 'Task root parent');
  const taskRoot = path.join(parent, path.basename(requestedTaskRoot));
  if (!isWithin(parent, taskRoot)) {
    throw new RecruitmentGitError(
      'Task root must be a direct child of an existing task-owned parent directory.'
    );
  }
  await assertPathAbsent(taskRoot);
  const plans = [
    {
      workerId: 'integration',
      branch: integrationBranch,
      worktreeRoot: path.join(taskRoot, 'integration'),
    },
    ...workers.map((worker) => ({
      ...worker,
      worktreeRoot: path.join(taskRoot, `worker-${worker.workerId}`),
    })),
  ];
  for (const plan of plans) {
    await assertBranchAvailable(validated.projectRoot, plan.branch);
    await assertPathAbsent(plan.worktreeRoot);
  }
  await mkdir(taskRoot);
  const manifest: TaskManifest = {
    version: 1,
    canonicalRoot: validated.projectRoot,
    integration: { branch: integrationBranch, worktreeRoot: path.join(taskRoot, 'integration') },
    workers: workers.map((worker) => ({
      ...worker,
      worktreeRoot: path.join(taskRoot, `worker-${worker.workerId}`),
    })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(taskRoot, TASK_MANIFEST), manifestText, { flag: 'wx' });
  let integrationCreated = false;
  const created: PreparedRecruitmentWorker[] = [];
  const attempted: Array<{ branch: string; worktreeRoot: string }> = [];
  try {
    for (const plan of plans) {
      attempted.push({ branch: plan.branch, worktreeRoot: plan.worktreeRoot });
      await git(validated.projectRoot, [
        'worktree',
        'add',
        '-b',
        plan.branch,
        plan.worktreeRoot,
        validated.baseCommit,
      ]);
      if (plan.workerId === 'integration') integrationCreated = true;
      else created.push({ ...plan, headCommit: await commitAt(plan.worktreeRoot) });
    }
  } catch (error) {
    const partial: PreparedRecruitmentWorktrees = {
      canonicalRoot: validated.projectRoot,
      taskRoot,
      baseCommit: validated.baseCommit,
      integration: manifest.integration,
      workers: manifest.workers.map((worker) => ({ ...worker, headCommit: validated.baseCommit })),
    };
    let cleanupErrors: string[] = [];
    try {
      cleanupErrors = await cleanupPreparedRecruitmentWorktrees(partial, parent, attempted);
    } catch (cleanupError) {
      cleanupErrors = [
        `Automatic partial-worktree cleanup failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
      ];
    }
    const cleanupSummary = cleanupErrors.length
      ? ` Cleanup was incomplete: ${cleanupErrors.join('; ')}`
      : ' The unchanged task-owned worktrees and refs were retired.';
    throw new RecruitmentGitError(
      `Worktree preparation failed for task root ${taskRoot}.${cleanupSummary}`,
      { cause: error }
    );
  }
  if (!integrationCreated) throw new RecruitmentGitError('Integration worktree was not created.');
  return {
    canonicalRoot: validated.projectRoot,
    taskRoot,
    baseCommit: validated.baseCommit,
    integration: { branch: integrationBranch, worktreeRoot: path.join(taskRoot, 'integration') },
    workers: created,
  };
}

export async function mergeRecruitmentWorkerDependencies(options: {
  canonicalRoot: string;
  taskRoot: string;
  workerId: string;
  branch: string;
  worktreeRoot: string;
  dependencies: Array<{
    workerId: string;
    branch: string;
    worktreeRoot: string;
    headCommit: string;
  }>;
}): Promise<string[]> {
  const { projectRoot } = await validateRecruitmentProject(options.canonicalRoot, 'HEAD');
  const taskRoot = await realpath(options.taskRoot).catch((error) => {
    throw new RecruitmentGitError(
      'Task-owned recruitment worktree parent is missing or inaccessible.',
      { cause: error }
    );
  });
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  const targetId = safeSegment(options.workerId, 'Worker ID'),
    targetBranch = validateRecruitmentBranch(options.branch),
    targetPath = path.join(taskRoot, `worker-${targetId}`);
  if (!samePath(options.worktreeRoot, targetPath))
    throw new RecruitmentGitError(
      'Worker dependency target does not match its task-owned worktree location.'
    );
  const recordedTarget = manifest.workers.find((worker) => worker.workerId === targetId);
  if (
    !recordedTarget ||
    recordedTarget.branch !== targetBranch ||
    !samePath(recordedTarget.worktreeRoot, targetPath)
  )
    throw new RecruitmentGitError(
      'Worker dependency target does not match the task ownership manifest.'
    );
  const ownedTarget = await validateOwnedLocation(projectRoot, taskRoot, targetPath, targetBranch);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dependency of options.dependencies) {
    const workerId = safeSegment(dependency.workerId, 'Dependency worker ID'),
      branch = validateRecruitmentBranch(dependency.branch),
      worktreeRoot = path.join(taskRoot, `worker-${workerId}`);
    if (workerId === targetId || seen.has(workerId))
      throw new RecruitmentGitError(
        'Worker dependencies must be unique and cannot include the target worker.'
      );
    seen.add(workerId);
    const recorded = manifest.workers.find((worker) => worker.workerId === workerId);
    if (
      !recorded ||
      recorded.branch !== branch ||
      !samePath(recorded.worktreeRoot, dependency.worktreeRoot)
    )
      throw new RecruitmentGitError(
        `Dependency worker ${workerId} does not match the task ownership manifest.`
      );
    if (!/^[0-9a-f]{40,64}$/i.test(dependency.headCommit))
      throw new RecruitmentGitError(
        `Dependency worker ${workerId} must provide a full commit SHA.`
      );
    const ownedDependency = await validateOwnedLocation(
        projectRoot,
        taskRoot,
        worktreeRoot,
        branch
      ),
      observedHead = await commitAt(ownedDependency);
    if (observedHead.toLowerCase() !== dependency.headCommit.toLowerCase())
      throw new RecruitmentGitError(
        `Dependency worker ${workerId} HEAD changed; refusing to expose an unconfirmed commit.`
      );
    try {
      await git(ownedTarget, ['merge', '--no-ff', '--no-edit', observedHead]);
      merged.push(observedHead);
    } catch (error) {
      const files = await git(ownedTarget, ['diff', '--name-only', '--diff-filter=U'])
        .then((result) => result.stdout.split(/\r?\n/).filter(Boolean))
        .catch(() => []);
      throw new RecruitmentGitError(
        `Could not prepare dependent worker ${targetId} from prerequisite ${workerId}${files.length ? `: merge conflicts in ${files.join(', ')}` : ''}. The worktree is preserved for inspection.`,
        { cause: error }
      );
    }
  }
  return merged;
}

export async function mergeRecruitmentCommits(options: {
  canonicalRoot: string;
  integrationRoot: string;
  workers: Array<{ workerId: string; branch: string; headCommit: string }>;
}): Promise<{
  merged: Array<{ workerId: string; headCommit: string }>;
  conflicts: Array<{ workerId: string; files: string[] }>;
  integrationHead: string;
  status: 'ready' | 'conflict';
}> {
  const { projectRoot } = await validateRecruitmentProject(options.canonicalRoot, 'HEAD');
  const integrationPath = await realpath(options.integrationRoot).catch((error) => {
    throw new RecruitmentGitError('Integration worktree path is missing or inaccessible.', {
      cause: error,
    });
  });
  if (!path.isAbsolute(options.integrationRoot))
    throw new RecruitmentGitError('Integration worktree path must be absolute.');
  const taskRoot = await realpath(path.dirname(integrationPath));
  if (!samePath(path.basename(integrationPath), 'integration'))
    throw new RecruitmentGitError(
      'Integration worktree must use the task-owned integration directory.'
    );
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  if (!samePath(manifest.integration.worktreeRoot, integrationPath))
    throw new RecruitmentGitError('Integration worktree does not match the task ownership record.');
  const integrationCommon = (
    await git(integrationPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).stdout;
  const projectCommon = (
    await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).stdout;
  if (!samePath(integrationCommon, projectCommon))
    throw new RecruitmentGitError(
      'Integration path is not a worktree belonging to the requested project.'
    );
  const integrationBranch = (
    await git(integrationPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  ).stdout;
  validateRecruitmentBranch(integrationBranch);
  if (integrationBranch !== manifest.integration.branch)
    throw new RecruitmentGitError('Integration branch does not match the task ownership record.');
  if (!Array.isArray(options.workers) || options.workers.length > 16)
    throw new RecruitmentGitError('Worker merge list must contain at most 16 entries.');
  const merged: Array<{ workerId: string; headCommit: string }> = [];
  const conflicts: Array<{ workerId: string; files: string[] }> = [];
  const seenWorkers = new Set<string>();
  for (const worker of options.workers) {
    const workerId = safeSegment(worker.workerId, 'Worker ID');
    if (seenWorkers.has(workerId))
      throw new RecruitmentGitError(`Worker appears more than once in merge state: ${workerId}`);
    seenWorkers.add(workerId);
    const branch = validateRecruitmentBranch(worker.branch);
    if (!/^[0-9a-f]{40,64}$/i.test(worker.headCommit))
      throw new RecruitmentGitError(`Worker ${workerId} must provide a full commit SHA.`);
    const workerPath = path.join(taskRoot, `worker-${workerId}`);
    const recordedWorker = manifest.workers.find((entry) => entry.workerId === workerId);
    if (
      !recordedWorker ||
      recordedWorker.branch !== branch ||
      !samePath(recordedWorker.worktreeRoot, workerPath)
    ) {
      throw new RecruitmentGitError(`Worker ${workerId} does not match the task ownership record.`);
    }
    const ownedPath = await validateOwnedLocation(projectRoot, taskRoot, workerPath, branch);
    const observedHead = await commitAt(ownedPath);
    if (observedHead.toLowerCase() !== worker.headCommit.toLowerCase())
      throw new RecruitmentGitError(
        `Worker ${workerId} HEAD changed; refusing to merge an unconfirmed commit.`
      );
    try {
      await git(integrationPath, ['merge', '--no-ff', '--no-edit', worker.headCommit]);
      merged.push({ workerId, headCommit: worker.headCommit });
    } catch (error) {
      const files = await git(integrationPath, ['diff', '--name-only', '--diff-filter=U'])
        .then((result) => result.stdout.split(/\r?\n/).filter(Boolean))
        .catch(() => []);
      if (!files.length) throw error;
      conflicts.push({ workerId, files });
      break;
    }
  }
  return {
    merged,
    conflicts,
    integrationHead: await commitAt(integrationPath),
    status: conflicts.length ? 'conflict' : 'ready',
  };
}

export async function verifyRecruitmentIntegration(options: {
  canonicalRoot: string;
  integrationRoot: string;
  integrationBranch: string;
  integrationBaseCommit: string;
  workerCommits: Array<{ workerId: string; commit: string }>;
}): Promise<{ headCommit: string }> {
  const { projectRoot } = await validateRecruitmentProject(options.canonicalRoot, 'HEAD');
  const integrationPath = await realpath(options.integrationRoot).catch((error) => {
    throw new RecruitmentGitError('Integration worktree path is missing or inaccessible.', {
      cause: error,
    });
  });
  const integrationBranch = validateRecruitmentBranch(options.integrationBranch);
  const taskRoot = await realpath(path.dirname(integrationPath));
  if (!samePath(path.basename(integrationPath), 'integration'))
    throw new RecruitmentGitError(
      'Integration worktree must use the task-owned integration directory.'
    );
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  if (
    manifest.integration.branch !== integrationBranch ||
    !samePath(manifest.integration.worktreeRoot, integrationPath)
  )
    throw new RecruitmentGitError('Integration worktree does not match its task ownership record.');
  await validateOwnedLocation(projectRoot, taskRoot, integrationPath, integrationBranch);
  const headCommit = await commitAt(integrationPath);
  const assertAncestor = async (commit: string, label: string) => {
    if (!/^[0-9a-f]{40,64}$/i.test(commit))
      throw new RecruitmentGitError(`${label} must be a full commit SHA.`);
    try {
      await git(integrationPath, ['merge-base', '--is-ancestor', commit, headCommit]);
    } catch (error) {
      throw new RecruitmentGitError(
        `${label} is not integrated in the recorded integration branch. Resolve the worker merge in the isolated integration worktree and retry verification.`,
        { cause: error }
      );
    }
  };
  await assertAncestor(options.integrationBaseCommit, 'The integration baseline');
  const seen = new Set<string>();
  for (const worker of options.workerCommits) {
    const workerId = safeSegment(worker.workerId, 'Worker ID');
    if (seen.has(workerId))
      throw new RecruitmentGitError(
        `Worker ${workerId} appears more than once in integration verification.`
      );
    seen.add(workerId);
    await assertAncestor(worker.commit, `Worker ${workerId} commit`);
  }
  return { headCommit };
}

async function validateOwnedLocation(
  projectRoot: string,
  taskRoot: string,
  target: string,
  expectedBranch: string
): Promise<string> {
  const candidate = await realpath(target).catch((error) => {
    throw new RecruitmentGitError('Worker worktree path is missing or inaccessible.', {
      cause: error,
    });
  });
  if (!isWithin(taskRoot, candidate))
    throw new RecruitmentGitError('Worktree path escapes its task-owned root.');
  const commonDir = (
    await git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).stdout;
  const projectCommon = (
    await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).stdout;
  if (!samePath(commonDir, projectCommon))
    throw new RecruitmentGitError('Path is not a worktree belonging to the requested project.');
  const branch = (await git(candidate, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  if (branch !== expectedBranch)
    throw new RecruitmentGitError(
      `Worktree branch mismatch: expected ${expectedBranch}, found ${branch || 'detached HEAD'}.`
    );
  return candidate;
}

async function taskManifestPath(taskRoot: string): Promise<string> {
  const entries = await readdir(taskRoot);
  const manifests = entries.filter(
    (entry) => entry === TASK_MANIFEST || entry === LEGACY_TASK_MANIFEST
  );

  if (manifests.length !== 1) {
    throw new RecruitmentGitError('Task ownership record is missing or ambiguous.');
  }

  return path.join(taskRoot, manifests[0]);
}

async function readTaskManifest(
  projectRoot: string,
  taskRoot: string,
  manifestPath?: string
): Promise<TaskManifest> {
  let manifest: TaskManifest;
  try {
    const sourcePath = manifestPath ?? (await taskManifestPath(taskRoot));
    manifest = JSON.parse(await readFile(sourcePath, 'utf8')) as TaskManifest;
  } catch (error) {
    throw new RecruitmentGitError('Task ownership record is missing or invalid.', { cause: error });
  }
  if (
    !manifest ||
    manifest.version !== 1 ||
    typeof manifest.canonicalRoot !== 'string' ||
    !path.isAbsolute(manifest.canonicalRoot) ||
    !manifest.integration ||
    typeof manifest.integration.branch !== 'string' ||
    typeof manifest.integration.worktreeRoot !== 'string' ||
    !Array.isArray(manifest.workers) ||
    manifest.workers.some(
      (worker) =>
        !worker ||
        typeof worker.workerId !== 'string' ||
        typeof worker.branch !== 'string' ||
        typeof worker.worktreeRoot !== 'string'
    ) ||
    !samePath(manifest.canonicalRoot, projectRoot)
  ) {
    throw new RecruitmentGitError('Task ownership record does not belong to this project.');
  }
  return manifest;
}

export async function removeRecruitmentWorktree(options: {
  canonicalRoot: string;
  taskRoot: string;
  worktreeRoot: string;
  branch: string;
}): Promise<void> {
  const { projectRoot } = await validateRecruitmentProject(options.canonicalRoot, 'HEAD');
  const taskRoot = await realpath(options.taskRoot).catch((error) => {
    throw new RecruitmentGitError('Task-owned root is missing or inaccessible.', { cause: error });
  });
  const target = path.resolve(options.worktreeRoot);
  const branch = validateRecruitmentBranch(options.branch);
  if (!isWithin(taskRoot, target))
    throw new RecruitmentGitError('Cleanup target escapes its task-owned root.');
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  const recorded =
    samePath(manifest.integration.worktreeRoot, target) && manifest.integration.branch === branch
      ? manifest.integration
      : manifest.workers.find(
          (worker) => samePath(worker.worktreeRoot, target) && worker.branch === branch
        );
  if (!recorded)
    throw new RecruitmentGitError('Cleanup target is not listed in the task ownership record.');
  const safePath = await validateOwnedLocation(projectRoot, taskRoot, target, branch);
  await git(projectRoot, ['worktree', 'remove', '--force', safePath]);
}

type ListedWorktree = { path: string; branch?: string };
function listedWorktrees(output: string): ListedWorktree[] {
  const rows: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) rows.push(current);
      current = { path: path.resolve(line.slice('worktree '.length)) };
    } else if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length);
  }
  if (current) rows.push(current);
  return rows;
}
/** Retires only an unsealed, pristine recruitment whose complete manifest still matches preparation. */
export async function cleanupPreparedRecruitmentWorktrees(
  prepared: PreparedRecruitmentWorktrees,
  expectedTaskParent: string,
  attemptedTargets?: Array<{ branch: string; worktreeRoot: string }>
): Promise<string[]> {
  const preserve = (reason: string) => [
    `Prepared recruitment cleanup was skipped or incomplete: ${reason}. Its remaining worktrees, branches, and ownership record were preserved.`,
  ];
  let projectRoot: string,
    taskRoot: string,
    taskParent: string,
    manifestPath: string,
    manifest: TaskManifest,
    manifestText: string;
  const targets = [
    { branch: prepared.integration.branch, worktreeRoot: prepared.integration.worktreeRoot },
    ...prepared.workers.map((row) => ({ branch: row.branch, worktreeRoot: row.worktreeRoot })),
  ];
  const attempts = attemptedTargets ?? targets,
    worktreesToRemove: Array<{ branch: string; worktreeRoot: string }> = [],
    branchesToDelete: string[] = [];
  try {
    projectRoot = (await validateRecruitmentProject(prepared.canonicalRoot, 'HEAD')).projectRoot;
    taskParent = await realpath(expectedTaskParent);
    const taskEntry = await lstat(prepared.taskRoot);
    if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink())
      return preserve('the task root is not a regular owned directory');
    taskRoot = await realpath(prepared.taskRoot);
    if (
      !samePath(taskRoot, prepared.taskRoot) ||
      !samePath(path.dirname(taskRoot), taskParent) ||
      !samePath(path.dirname(path.resolve(prepared.taskRoot)), taskParent)
    )
      return preserve('the task root escaped its exact generated parent');
    if (!/^[0-9a-f]{40,64}$/i.test(prepared.baseCommit))
      return preserve('the preparation result has no full initial commit SHA');
    manifestPath = await taskManifestPath(taskRoot);
    manifestText = await readFile(manifestPath, 'utf8');
    manifest = await readTaskManifest(projectRoot, taskRoot, manifestPath);
    const expectedWorkers = [...prepared.workers].sort((a, b) =>
      a.workerId.localeCompare(b.workerId)
    );
    const recordedWorkers = [...manifest.workers].sort((a, b) =>
      a.workerId.localeCompare(b.workerId)
    );
    if (
      !samePath(manifest.canonicalRoot, projectRoot) ||
      manifest.integration.branch !== prepared.integration.branch ||
      !samePath(manifest.integration.worktreeRoot, prepared.integration.worktreeRoot) ||
      recordedWorkers.length !== expectedWorkers.length ||
      recordedWorkers.some(
        (row, index) =>
          row.workerId !== expectedWorkers[index].workerId ||
          row.branch !== expectedWorkers[index].branch ||
          !samePath(row.worktreeRoot, expectedWorkers[index].worktreeRoot)
      )
    )
      return preserve('the task ownership manifest no longer exactly matches this preparation');
    if (
      new Set(targets.map((row) => row.branch)).size !== targets.length ||
      new Set(targets.map((row) => pathIdentity(row.worktreeRoot))).size !== targets.length
    )
      return preserve('the prepared branches or worktree paths are not unique');
    const targetKey = (row: { branch: string; worktreeRoot: string }) =>
      `${row.branch}\0${pathIdentity(row.worktreeRoot)}`;
    if (
      new Set(attempts.map(targetKey)).size !== attempts.length ||
      attempts.some((row) => !targets.some((target) => targetKey(target) === targetKey(row)))
    )
      return preserve('the attempted worktree list does not exactly match task-manifest targets');
    for (const row of targets) {
      validateRecruitmentBranch(row.branch);
      if (!samePath(path.dirname(row.worktreeRoot), taskRoot))
        return preserve(`worktree ${row.worktreeRoot} is not a direct child of its task root`);
    }
    const allowedEntries = new Set([
      path.basename(manifestPath),
      ...targets.map((row) => path.basename(row.worktreeRoot)),
    ]);
    const taskEntries = await readdir(taskRoot);
    if (taskEntries.some((entry) => !allowedEntries.has(entry)))
      return preserve('the task root contains unexpected files or directories');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
      return preserve('the ownership manifest is not a regular file');
    const worktrees = listedWorktrees(
      (await git(projectRoot, ['worktree', 'list', '--porcelain'])).stdout
    );
    for (const row of targets) {
      const attempted = attempts.some((item) => targetKey(item) === targetKey(row)),
        refName = `refs/heads/${row.branch}`,
        refRows = (
          await git(projectRoot, ['for-each-ref', '--format=%(refname) %(objectname)', refName])
        ).stdout
          .split(/\r?\n/)
          .filter(Boolean),
        exactRefs = refRows.filter((item) => item.startsWith(`${refName} `)),
        branchHead = exactRefs[0]?.slice(refName.length + 1),
        attachments = worktrees.filter((item) => item.branch === refName);
      if (exactRefs.length > 1) return preserve(`branch ${row.branch} has duplicate ref records`);
      if (!attempted) {
        if (attachments.length || branchHead)
          return preserve(`unattempted target ${row.branch} already has a worktree or branch ref`);
        try {
          await assertPathAbsent(row.worktreeRoot);
        } catch (error) {
          return preserve(
            `unattempted worktree path ${row.worktreeRoot} is occupied (${error instanceof Error ? error.message : String(error)})`
          );
        }
        continue;
      }
      if (attachments.length > 1)
        return preserve(`branch ${row.branch} is attached to multiple worktrees`);
      if (attachments.length) {
        if (!samePath(attachments[0].path, row.worktreeRoot))
          return preserve(`branch ${row.branch} is checked out at an unexpected worktree`);
        const safePath = await validateOwnedLocation(
          projectRoot,
          taskRoot,
          row.worktreeRoot,
          row.branch
        );
        if (!samePath(safePath, row.worktreeRoot))
          return preserve(`worktree ${row.worktreeRoot} resolved to a different path`);
        if ((await commitAt(safePath)).toLowerCase() !== prepared.baseCommit.toLowerCase())
          return preserve(`worktree ${row.worktreeRoot} no longer points at its initial commit`);
        if ((await git(safePath, ['status', '--porcelain', '--untracked-files=all'])).stdout)
          return preserve(`worktree ${row.worktreeRoot} contains uncommitted or untracked changes`);
        if (!branchHead || branchHead.toLowerCase() !== prepared.baseCommit.toLowerCase())
          return preserve(`branch ${row.branch} no longer points at its initial commit`);
        worktreesToRemove.push(row);
        branchesToDelete.push(row.branch);
      } else {
        try {
          await assertPathAbsent(row.worktreeRoot);
        } catch (error) {
          return preserve(
            `unregistered worktree path ${row.worktreeRoot} is occupied (${error instanceof Error ? error.message : String(error)})`
          );
        }
        if (branchHead) {
          if (branchHead.toLowerCase() !== prepared.baseCommit.toLowerCase())
            return preserve(`branch ${row.branch} no longer points at its initial commit`);
          branchesToDelete.push(row.branch);
        }
      }
    }
  } catch (error) {
    return preserve(error instanceof Error ? error.message : String(error));
  }

  for (const row of worktreesToRemove) {
    try {
      await git(projectRoot, ['worktree', 'remove', row.worktreeRoot]);
    } catch (error) {
      return preserve(
        `worktree ${row.worktreeRoot} could not be safely removed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  const afterRemoval = listedWorktrees(
      (await git(projectRoot, ['worktree', 'list', '--porcelain'])).stdout
    ),
    generatedBranches = [
      prepared.integration.branch,
      ...prepared.workers.map((worker) => worker.branch),
    ];
  if (afterRemoval.some((item) => targets.some((row) => samePath(item.path, row.worktreeRoot))))
    return preserve('a generated worktree remains registered after removal');
  if (
    afterRemoval.some(
      (item) => item.branch && generatedBranches.includes(item.branch.slice('refs/heads/'.length))
    )
  )
    return preserve('a generated branch remains checked out after worktree removal');

  try {
    const latestTaskRoot = await realpath(prepared.taskRoot);
    if (!samePath(latestTaskRoot, taskRoot) || !samePath(path.dirname(latestTaskRoot), taskParent))
      return preserve('the task root changed before generated branch cleanup');
    const currentText = await readFile(manifestPath, 'utf8'),
      currentManifest = await readTaskManifest(projectRoot, taskRoot, manifestPath);
    if (
      currentText !== manifestText ||
      JSON.stringify(currentManifest) !== JSON.stringify(manifest)
    )
      return preserve('the ownership manifest changed before generated branch cleanup');
    const entries = await readdir(taskRoot);
    if (entries.length !== 1 || entries[0] !== path.basename(manifestPath))
      return preserve('the task root contains unexpected files or directories');
    const currentManifestInfo = await lstat(manifestPath);
    if (!currentManifestInfo.isFile() || currentManifestInfo.isSymbolicLink())
      return preserve('the ownership manifest is not a regular file');
  } catch (error) {
    return preserve(error instanceof Error ? error.message : String(error));
  }

  const branchErrors: string[] = [];
  for (const branch of new Set(branchesToDelete)) {
    try {
      await git(projectRoot, ['update-ref', '-d', `refs/heads/${branch}`, prepared.baseCommit]);
    } catch (error) {
      branchErrors.push(
        `branch ${branch} changed or could not be conditionally deleted (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  if (branchErrors.length) return preserve(branchErrors.join('; '));

  try {
    const latestTaskRoot = await realpath(prepared.taskRoot);
    if (!samePath(latestTaskRoot, taskRoot) || !samePath(path.dirname(latestTaskRoot), taskParent))
      return preserve('the task root changed before manifest removal');
    const currentText = await readFile(manifestPath, 'utf8'),
      currentManifest = await readTaskManifest(projectRoot, taskRoot, manifestPath);
    if (
      currentText !== manifestText ||
      JSON.stringify(currentManifest) !== JSON.stringify(manifest)
    )
      return preserve('the ownership manifest changed before removal');
    const entries = await readdir(taskRoot);
    if (entries.length !== 1 || entries[0] !== path.basename(manifestPath))
      return preserve('the task root contains unexpected files or directories');
    const currentManifestInfo = await lstat(manifestPath);
    if (!currentManifestInfo.isFile() || currentManifestInfo.isSymbolicLink())
      return preserve('the ownership manifest is not a regular file');
    await unlink(manifestPath);
    try {
      await rmdir(taskRoot);
    } catch (error) {
      try {
        await writeFile(manifestPath, manifestText, { flag: 'wx' });
      } catch {}
      return preserve(
        `the empty task root could not be removed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  } catch (error) {
    return preserve(error instanceof Error ? error.message : String(error));
  }
  return [];
}

async function assertPathAbsent(target: string): Promise<void> {
  try {
    await access(target);
    throw new RecruitmentGitError(`Worktree destination already exists: ${target}`);
  } catch (error) {
    if (error instanceof RecruitmentGitError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new RecruitmentGitError(`Cannot inspect worktree destination: ${target}`, {
        cause: error,
      });
  }
}

async function commitAt(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout;
}
