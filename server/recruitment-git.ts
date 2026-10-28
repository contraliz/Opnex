import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
    const message = failure.code === 'ENOENT'
      ? 'Git is unavailable. Install Git or make it available on PATH.'
      : detail || failure.message || 'Git command failed.';
    throw new RecruitmentGitError(message, { cause: error });
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..') {
    throw new RecruitmentGitError(`${label} must be a simple 1-64 character identifier using letters, numbers, dot, underscore, or hyphen.`);
  }
  return value;
}

export function recruitmentWorkspaceRoot(stateRoot: string, taskId: string, passId: string, teamId?:string): string {
  const task = safeSegment(taskId, 'Task ID').replaceAll('-', '');
  const pass = safeSegment(passId, 'Pass ID').replaceAll('-', '');
  const team = teamId?safeSegment(teamId,'Team ID').replaceAll('-',''):'';
  const key = createHash('sha256').update(`${task}\0${pass}${team?`\0${team}`:''}`).digest('hex').slice(0, 32);
  return path.join(stateRoot, 'rw', key);
}

export async function recruitmentGitWritableRoots(canonicalRoot: string, worktreeRoot: string, branch: string): Promise<string[]> {
  const { projectRoot } = await validateRecruitmentProject(canonicalRoot, 'HEAD');
  const branchParts = validateRecruitmentBranch(branch).split('/');
  if (branchParts.length !== 4 || branchParts[0] !== 'recruitment') {
    throw new RecruitmentGitError('Worker branches must use the task and worker namespace required for scoped Git writes.');
  }
  const worktree = await canonicalDirectory(worktreeRoot, 'Worker worktree');
  const topLevel = await realpath((await git(worktree, ['rev-parse', '--show-toplevel'])).stdout);
  if (topLevel.toLowerCase() !== worktree.toLowerCase()) throw new RecruitmentGitError('Worker write roots require the exact worktree root.');
  const commonDirectory = await realpath((await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout);
  const canonicalCommonDirectory = await realpath((await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout);
  if (commonDirectory.toLowerCase() !== canonicalCommonDirectory.toLowerCase()) throw new RecruitmentGitError('Worker worktree belongs to a different Git repository.');
  const adminDirectory = await realpath((await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'])).stdout);
  const adminParent = path.join(commonDirectory, 'worktrees');
  if (!isWithin(adminParent, adminDirectory)) throw new RecruitmentGitError('Worker Git metadata is not isolated under this repository’s worktree administration directory.');
  const refNamespace = path.join(commonDirectory, 'refs', 'heads', ...branchParts.slice(0, 3));
  const logNamespace = path.join(commonDirectory, 'logs', 'refs', 'heads', ...branchParts.slice(0, 3));
  for (const root of [refNamespace, logNamespace]) {
    const resolved = path.resolve(root);
    if (!isWithin(commonDirectory, resolved)) throw new RecruitmentGitError('Worker Git ref write root escaped the shared repository metadata directory.');
  }
  return [worktree, adminDirectory, refNamespace, logNamespace];
}

export function validateRecruitmentBranch(branch: string): string {
  if (typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new RecruitmentGitError('Branch name contains unsupported characters or is too long.');
  }
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('@{')) {
    throw new RecruitmentGitError('Branch name contains a Git path or ref traversal pattern.');
  }
  if (branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock') || part === '@')) {
    throw new RecruitmentGitError('Branch name contains an invalid Git ref component.');
  }
  return branch;
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new RecruitmentGitError(`${label} must be an absolute path.`);
  try {
    const resolved = await realpath(input);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new RecruitmentGitError(`${label} is not a directory: ${input}`);
    return resolved;
  } catch (error) {
    if (error instanceof RecruitmentGitError) throw error;
    throw new RecruitmentGitError(`${label} does not exist or cannot be accessed: ${input}`, { cause: error });
  }
}

export async function validateRecruitmentProject(projectRoot: string, baseRef: string): Promise<{ projectRoot: string; baseRef: string; baseCommit: string }> {
  const root = await canonicalDirectory(projectRoot, 'Project root');
  let topLevel: string;
  try {
    topLevel = (await git(root, ['rev-parse', '--show-toplevel'])).stdout;
  } catch (error) {
    throw new RecruitmentGitError(`Project root is not a Git worktree: ${root}`, { cause: error });
  }
  const canonicalTop = await realpath(topLevel);
  if (path.resolve(canonicalTop).toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw new RecruitmentGitError(`Project root must be the Git worktree root, not a subdirectory: ${root}`);
  }
  if (typeof baseRef !== 'string' || !baseRef.trim() || baseRef.startsWith('-') || baseRef.length > 255) {
    throw new RecruitmentGitError('Selected base ref is missing or invalid.');
  }
  const commit = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/i.test(commit.stdout)) throw new RecruitmentGitError(`Selected base ref does not resolve to a commit: ${baseRef}`);
  return { projectRoot: root, baseRef, baseCommit: commit.stdout };
}

async function assertBranchAvailable(projectRoot: string, branch: string): Promise<void> {
  validateRecruitmentBranch(branch);
  const result = await git(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).catch((error: unknown) => {
    if (error instanceof RecruitmentGitError && (error.cause as { code?: string | number } | undefined)?.code === 1) return null;
    throw error;
  });
  if (result) throw new RecruitmentGitError(`Branch already exists: ${branch}`);
}

export async function validateRecruitmentRoot(canonicalRoot: string, baseRef: string): Promise<{ canonicalRoot: string; baseCommit: string }> {
  const validated = await validateRecruitmentProject(canonicalRoot, baseRef);
  return { canonicalRoot: validated.projectRoot, baseCommit: validated.baseCommit };
}

export async function readRecruitmentBranchHead(canonicalRoot: string, branch: string): Promise<string> {
  const { projectRoot } = await validateRecruitmentProject(canonicalRoot, 'HEAD');
  validateRecruitmentBranch(branch);
  const result = await git(projectRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/i.test(result.stdout)) throw new RecruitmentGitError(`Branch does not resolve to a commit: ${branch}`);
  return result.stdout;
}

export type PreparedRecruitmentWorker = { workerId: string; branch: string; worktreeRoot: string; headCommit: string };
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

const TASK_MANIFEST = '.pseudoharness-recruitment.json';

export async function prepareRecruitmentWorktrees(options: {
  canonicalRoot: string;
  taskRoot: string;
  baseRef: string;
  workers: Array<{ workerId: string; branch: string }>;
  integrationBranch: string;
}): Promise<PreparedRecruitmentWorktrees> {
  const validated = await validateRecruitmentProject(options.canonicalRoot, options.baseRef);
  if (!Array.isArray(options.workers) || options.workers.length === 0 || options.workers.length > 16) {
    throw new RecruitmentGitError('Provide between 1 and 16 workers.');
  }
  const integrationBranch = validateRecruitmentBranch(options.integrationBranch);
  const workers = options.workers.map((worker) => ({
    workerId: safeSegment(worker.workerId, 'Worker ID'),
    branch: validateRecruitmentBranch(worker.branch),
  }));
  const allBranches = [integrationBranch, ...workers.map((worker) => worker.branch)];
  if (new Set(allBranches).size !== allBranches.length) throw new RecruitmentGitError('Every worker and integration branch must be unique.');
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) throw new RecruitmentGitError('Worker IDs must be unique.');
  if (!path.isAbsolute(options.taskRoot)) throw new RecruitmentGitError('Task root must be an absolute path.');
  const requestedTaskRoot = path.resolve(options.taskRoot);
  // Canonicalize the existing parent before checking containment. macOS commonly
  // exposes /tmp through /private/tmp, and Windows can return a different spelling
  // (for example a short name) from realpath. Those aliases are the same directory.
  const parent = await canonicalDirectory(path.dirname(requestedTaskRoot), 'Task root parent');
  const taskRoot = path.join(parent, path.basename(requestedTaskRoot));
  if (!isWithin(parent, taskRoot)) {
    throw new RecruitmentGitError('Task root must be a direct child of an existing task-owned parent directory.');
  }
  await assertPathAbsent(taskRoot);
  const plans = [
    { workerId: 'integration', branch: integrationBranch, worktreeRoot: path.join(taskRoot, 'integration') },
    ...workers.map((worker) => ({ ...worker, worktreeRoot: path.join(taskRoot, `worker-${worker.workerId}`) })),
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
    workers: workers.map((worker) => ({ ...worker, worktreeRoot: path.join(taskRoot, `worker-${worker.workerId}`) })),
  };
  await writeFile(path.join(taskRoot, TASK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  let integrationCreated = false;
  const created: PreparedRecruitmentWorker[] = [];
  try {
    for (const plan of plans) {
      await git(validated.projectRoot, ['worktree', 'add', '-b', plan.branch, plan.worktreeRoot, validated.baseCommit]);
      if (plan.workerId === 'integration') integrationCreated = true;
      else created.push({ ...plan, headCommit: await commitAt(plan.worktreeRoot) });
    }
  } catch (error) {
    throw new RecruitmentGitError(`Worktree preparation failed; inspect the partial task directory before cleanup: ${taskRoot}`, { cause: error });
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

export async function mergeRecruitmentWorkerDependencies(options:{canonicalRoot:string;taskRoot:string;workerId:string;branch:string;worktreeRoot:string;dependencies:Array<{workerId:string;branch:string;worktreeRoot:string;headCommit:string}>}):Promise<string[]>{
  const {projectRoot}=await validateRecruitmentProject(options.canonicalRoot,'HEAD');
  const taskRoot=await realpath(options.taskRoot).catch(error=>{throw new RecruitmentGitError('Task-owned recruitment worktree parent is missing or inaccessible.',{cause:error});});
  const manifest=await readTaskManifest(projectRoot,taskRoot);
  const targetId=safeSegment(options.workerId,'Worker ID'),targetBranch=validateRecruitmentBranch(options.branch),targetPath=path.join(taskRoot,`worker-${targetId}`);
  if(path.resolve(options.worktreeRoot).toLowerCase()!==targetPath.toLowerCase())throw new RecruitmentGitError('Worker dependency target does not match its task-owned worktree location.');
  const recordedTarget=manifest.workers.find(worker=>worker.workerId===targetId);
  if(!recordedTarget||recordedTarget.branch!==targetBranch||path.resolve(recordedTarget.worktreeRoot).toLowerCase()!==targetPath.toLowerCase())throw new RecruitmentGitError('Worker dependency target does not match the task ownership manifest.');
  const ownedTarget=await validateOwnedLocation(projectRoot,taskRoot,targetPath,targetBranch);
  const merged:string[]=[];const seen=new Set<string>();
  for(const dependency of options.dependencies){
    const workerId=safeSegment(dependency.workerId,'Dependency worker ID'),branch=validateRecruitmentBranch(dependency.branch),worktreeRoot=path.join(taskRoot,`worker-${workerId}`);
    if(workerId===targetId||seen.has(workerId))throw new RecruitmentGitError('Worker dependencies must be unique and cannot include the target worker.');
    seen.add(workerId);
    const recorded=manifest.workers.find(worker=>worker.workerId===workerId);
    if(!recorded||recorded.branch!==branch||path.resolve(recorded.worktreeRoot).toLowerCase()!==path.resolve(dependency.worktreeRoot).toLowerCase())throw new RecruitmentGitError(`Dependency worker ${workerId} does not match the task ownership manifest.`);
    if(!/^[0-9a-f]{40,64}$/i.test(dependency.headCommit))throw new RecruitmentGitError(`Dependency worker ${workerId} must provide a full commit SHA.`);
    const ownedDependency=await validateOwnedLocation(projectRoot,taskRoot,worktreeRoot,branch),observedHead=await commitAt(ownedDependency);
    if(observedHead.toLowerCase()!==dependency.headCommit.toLowerCase())throw new RecruitmentGitError(`Dependency worker ${workerId} HEAD changed; refusing to expose an unconfirmed commit.`);
    try{await git(ownedTarget,['merge','--no-ff','--no-edit',observedHead]);merged.push(observedHead);}catch(error){const files=await git(ownedTarget,['diff','--name-only','--diff-filter=U']).then(result=>result.stdout.split(/\r?\n/).filter(Boolean)).catch(()=>[]);throw new RecruitmentGitError(`Could not prepare dependent worker ${targetId} from prerequisite ${workerId}${files.length?`: merge conflicts in ${files.join(', ')}`:''}. The worktree is preserved for inspection.`,{cause:error});}
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
  const integrationPath = await realpath(options.integrationRoot).catch((error) => { throw new RecruitmentGitError('Integration worktree path is missing or inaccessible.', { cause: error }); });
  if (!path.isAbsolute(options.integrationRoot)) throw new RecruitmentGitError('Integration worktree path must be absolute.');
  const taskRoot = await realpath(path.dirname(integrationPath));
  if (path.basename(integrationPath).toLowerCase() !== 'integration') throw new RecruitmentGitError('Integration worktree must use the task-owned integration directory.');
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  if (path.resolve(manifest.integration.worktreeRoot).toLowerCase() !== integrationPath.toLowerCase()) throw new RecruitmentGitError('Integration worktree does not match the task ownership record.');
  const integrationCommon = (await git(integrationPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout;
  const projectCommon = (await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout;
  if (path.resolve(integrationCommon).toLowerCase() !== path.resolve(projectCommon).toLowerCase()) throw new RecruitmentGitError('Integration path is not a worktree belonging to the requested project.');
  const integrationBranch = (await git(integrationPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  validateRecruitmentBranch(integrationBranch);
  if (integrationBranch !== manifest.integration.branch) throw new RecruitmentGitError('Integration branch does not match the task ownership record.');
  if (!Array.isArray(options.workers) || options.workers.length > 16) throw new RecruitmentGitError('Worker merge list must contain at most 16 entries.');
  const merged: Array<{ workerId: string; headCommit: string }> = [];
  const conflicts: Array<{ workerId: string; files: string[] }> = [];
  const seenWorkers = new Set<string>();
  for (const worker of options.workers) {
    const workerId = safeSegment(worker.workerId, 'Worker ID');
    if (seenWorkers.has(workerId)) throw new RecruitmentGitError(`Worker appears more than once in merge state: ${workerId}`);
    seenWorkers.add(workerId);
    const branch = validateRecruitmentBranch(worker.branch);
    if (!/^[0-9a-f]{40,64}$/i.test(worker.headCommit)) throw new RecruitmentGitError(`Worker ${workerId} must provide a full commit SHA.`);
    const workerPath = path.join(taskRoot, `worker-${workerId}`);
    const recordedWorker = manifest.workers.find((entry) => entry.workerId === workerId);
    if (!recordedWorker || recordedWorker.branch !== branch || path.resolve(recordedWorker.worktreeRoot).toLowerCase() !== workerPath.toLowerCase()) {
      throw new RecruitmentGitError(`Worker ${workerId} does not match the task ownership record.`);
    }
    const ownedPath = await validateOwnedLocation(projectRoot, taskRoot, workerPath, branch);
    const observedHead = await commitAt(ownedPath);
    if (observedHead.toLowerCase() !== worker.headCommit.toLowerCase()) throw new RecruitmentGitError(`Worker ${workerId} HEAD changed; refusing to merge an unconfirmed commit.`);
    try {
      await git(integrationPath, ['merge', '--no-ff', '--no-edit', worker.headCommit]);
      merged.push({ workerId, headCommit: worker.headCommit });
    } catch (error) {
      const files = await git(integrationPath, ['diff', '--name-only', '--diff-filter=U']).then((result) => result.stdout.split(/\r?\n/).filter(Boolean)).catch(() => []);
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
  const integrationPath = await realpath(options.integrationRoot).catch((error) => { throw new RecruitmentGitError('Integration worktree path is missing or inaccessible.', { cause: error }); });
  const integrationBranch = validateRecruitmentBranch(options.integrationBranch);
  const taskRoot = await realpath(path.dirname(integrationPath));
  if (path.basename(integrationPath).toLowerCase() !== 'integration') throw new RecruitmentGitError('Integration worktree must use the task-owned integration directory.');
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  if (manifest.integration.branch !== integrationBranch || path.resolve(manifest.integration.worktreeRoot).toLowerCase() !== integrationPath.toLowerCase()) throw new RecruitmentGitError('Integration worktree does not match its task ownership record.');
  await validateOwnedLocation(projectRoot, taskRoot, integrationPath, integrationBranch);
  const headCommit = await commitAt(integrationPath);
  const assertAncestor = async (commit: string, label: string) => {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new RecruitmentGitError(`${label} must be a full commit SHA.`);
    try { await git(integrationPath, ['merge-base', '--is-ancestor', commit, headCommit]); }
    catch (error) { throw new RecruitmentGitError(`${label} is not integrated in the recorded integration branch. Resolve the worker merge in the isolated integration worktree and retry verification.`, { cause: error }); }
  };
  await assertAncestor(options.integrationBaseCommit, 'The integration baseline');
  const seen = new Set<string>();
  for (const worker of options.workerCommits) {
    const workerId = safeSegment(worker.workerId, 'Worker ID');
    if (seen.has(workerId)) throw new RecruitmentGitError(`Worker ${workerId} appears more than once in integration verification.`);
    seen.add(workerId);
    await assertAncestor(worker.commit, `Worker ${workerId} commit`);
  }
  return { headCommit };
}

async function validateOwnedLocation(projectRoot: string, taskRoot: string, target: string, expectedBranch: string): Promise<string> {
  const candidate = await realpath(target).catch((error) => { throw new RecruitmentGitError('Worker worktree path is missing or inaccessible.', { cause: error }); });
  if (!isWithin(taskRoot, candidate)) throw new RecruitmentGitError('Worktree path escapes its task-owned root.');
  const commonDir = (await git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout;
  const projectCommon = (await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout;
  if (path.resolve(commonDir).toLowerCase() !== path.resolve(projectCommon).toLowerCase()) throw new RecruitmentGitError('Path is not a worktree belonging to the requested project.');
  const branch = (await git(candidate, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  if (branch !== expectedBranch) throw new RecruitmentGitError(`Worktree branch mismatch: expected ${expectedBranch}, found ${branch || 'detached HEAD'}.`);
  return candidate;
}

async function readTaskManifest(projectRoot: string, taskRoot: string): Promise<TaskManifest> {
  let manifest: TaskManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(taskRoot, TASK_MANIFEST), 'utf8')) as TaskManifest;
  } catch (error) {
    throw new RecruitmentGitError('Task ownership record is missing or invalid.', { cause: error });
  }
  if (!manifest || manifest.version !== 1 || typeof manifest.canonicalRoot !== 'string' || !path.isAbsolute(manifest.canonicalRoot)
    || !manifest.integration || typeof manifest.integration.branch !== 'string' || typeof manifest.integration.worktreeRoot !== 'string'
    || !Array.isArray(manifest.workers) || manifest.workers.some((worker) => !worker || typeof worker.workerId !== 'string' || typeof worker.branch !== 'string' || typeof worker.worktreeRoot !== 'string')
    || path.resolve(manifest.canonicalRoot).toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
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
  const taskRoot = await realpath(options.taskRoot).catch((error) => { throw new RecruitmentGitError('Task-owned root is missing or inaccessible.', { cause: error }); });
  const target = path.resolve(options.worktreeRoot);
  const branch = validateRecruitmentBranch(options.branch);
  if (!isWithin(taskRoot, target)) throw new RecruitmentGitError('Cleanup target escapes its task-owned root.');
  const manifest = await readTaskManifest(projectRoot, taskRoot);
  const recorded = path.resolve(manifest.integration.worktreeRoot).toLowerCase() === target.toLowerCase() && manifest.integration.branch === branch
    ? manifest.integration
    : manifest.workers.find((worker) => path.resolve(worker.worktreeRoot).toLowerCase() === target.toLowerCase() && worker.branch === branch);
  if (!recorded) throw new RecruitmentGitError('Cleanup target is not listed in the task ownership record.');
  const safePath = await validateOwnedLocation(projectRoot, taskRoot, target, branch);
  await git(projectRoot, ['worktree', 'remove', '--force', safePath]);
}

async function assertPathAbsent(target: string): Promise<void> {
  try {
    await access(target);
    throw new RecruitmentGitError(`Worktree destination already exists: ${target}`);
  } catch (error) {
    if (error instanceof RecruitmentGitError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RecruitmentGitError(`Cannot inspect worktree destination: ${target}`, { cause: error });
  }
}

async function commitAt(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout;
}
