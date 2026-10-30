import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveProjectDirectory } from './directories.js';
import type { GitCommandResult, GitWorkspaceCommand } from './git-workspace.js';

export type WorkspaceRepositoryErrorCode = 'invalid-root' | 'git-unavailable' | 'unsafe-repository' | 'permission-denied' | 'inspection-failed' | 'initialization-failed';

export class WorkspaceRepositoryError extends Error {
  constructor(readonly code: WorkspaceRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceRepositoryError';
  }
}

const redirectedGitEnvironment = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
]);

const runGit: GitWorkspaceCommand = (executable, args, cwd, maxStdoutBytes = 4096) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (redirectedGitEnvironment.has(key.toUpperCase())) delete env[key];

  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  const finish = (error?: Error, result?: GitCommandResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result!);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const text = String(chunk);
    const room = maxStdoutBytes - stdout.length;
    stdout += text.slice(0, Math.max(0, room));
    if (text.length > room) {
      child.kill();
      finish(new Error('Git returned more output than expected.'));
    }
  });
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    stderr += text.slice(0, Math.max(0, 4096 - stderr.length));
  });
  child.on('error', error => finish(error));
  child.on('close', code => finish(undefined, { code, stdout, stderr }));
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('Git did not finish the request in time.'));
  }, 12_000);
  timer.unref?.();
});

function samePath(left: string, right: string) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function hasControlCharacters(value: string) {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

async function canonicalWorkspaceRoot(input: string) {
  if (typeof input !== 'string' || !input.trim()) throw new WorkspaceRepositoryError('invalid-root', 'Choose an existing workspace folder.');
  if (hasControlCharacters(input)) throw new WorkspaceRepositoryError('invalid-root', 'Workspace paths cannot contain control characters.');
  if (!path.isAbsolute(input)) throw new WorkspaceRepositoryError('invalid-root', 'The workspace path must be absolute.');

  let root: string;
  try {
    root = await resolveProjectDirectory(input);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    const code = /permission/i.test(message) ? 'permission-denied' : 'invalid-root';
    throw new WorkspaceRepositoryError(code, message || 'The selected workspace folder does not exist or cannot be accessed.', { cause });
  }
  if (!samePath(input, root)) throw new WorkspaceRepositoryError('invalid-root', 'Use the canonical workspace path. Symbolic-link and reparse paths are not supported.');
  return root;
}

function failureCode(error: unknown, stderr = ''): WorkspaceRepositoryErrorCode {
  const errorCode = (error as NodeJS.ErrnoException | null)?.code;
  if (errorCode === 'ENOENT') return 'git-unavailable';
  if (errorCode === 'EACCES' || errorCode === 'EPERM') return 'permission-denied';
  const detail = `${stderr}\n${error instanceof Error ? error.message : ''}`;
  if (/dubious ownership|unsafe repository|safe\.directory/i.test(detail)) return 'unsafe-repository';
  if (/permission denied|operation not permitted|access is denied|unable to access/i.test(detail)) return 'permission-denied';
  return 'inspection-failed';
}

function failureMessage(code: WorkspaceRepositoryErrorCode) {
  if (code === 'git-unavailable') return 'Git is not available on PATH. Install Git and try again.';
  if (code === 'unsafe-repository') return 'Git refused to inspect this folder as unsafe. Check its ownership or Git safe.directory configuration.';
  if (code === 'permission-denied') return 'Git cannot access the selected folder. Check folder permissions and try again.';
  if (code === 'initialization-failed') return 'Git could not initialize a repository in the selected folder. Check write permissions and try again.';
  return 'Could not inspect the selected folder with Git. Check that it is accessible and Git is configured correctly.';
}

function isMissingRepository(result: GitCommandResult) {
  return result.code === 128 && /not a git repository/i.test(result.stderr);
}

async function inspectCanonicalWorkspaceRepository(workspaceRoot: string, runner: GitWorkspaceCommand) {
  let result: GitCommandResult;
  try {
    result = await runner('git', ['rev-parse', '--show-toplevel'], workspaceRoot, 4096);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === 'ENOENT') await canonicalWorkspaceRoot(workspaceRoot);
    const code = failureCode(cause, cause instanceof Error ? cause.message : '');
    throw new WorkspaceRepositoryError(code, failureMessage(code), { cause });
  }
  if (result.code !== 0) {
    if (isMissingRepository(result)) return { status: 'missing' as const, workspaceRoot };
    const code = failureCode(undefined, result.stderr);
    throw new WorkspaceRepositoryError(code, failureMessage(code));
  }

  const repositoryPath = result.stdout.replace(/\r?\n$/, '');
  if (!repositoryPath || hasControlCharacters(repositoryPath)) throw new WorkspaceRepositoryError('inspection-failed', 'Git returned an invalid repository path.');
  let repositoryRoot: string;
  try {
    repositoryRoot = await resolveProjectDirectory(repositoryPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : '';
    const code = /permission/i.test(detail) ? 'permission-denied' : 'inspection-failed';
    const message = code === 'permission-denied' ? failureMessage(code) : 'Git returned a repository folder that is no longer available.';
    throw new WorkspaceRepositoryError(code, message, { cause });
  }
  return { status: 'repository' as const, workspaceRoot, repositoryRoot };
}

export async function inspectWorkspaceRepository(workspaceRoot: string, runner: GitWorkspaceCommand = runGit) {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  return inspectCanonicalWorkspaceRepository(root, runner);
}

const pendingInitializations = new Map<string, Promise<void>>();

async function ensureCanonicalWorkspaceRepository(workspaceRoot: string, runner: GitWorkspaceCommand, authorizeInitialization?: () => boolean | Promise<boolean>) {
  const existing = await inspectCanonicalWorkspaceRepository(workspaceRoot, runner);
  if (existing.status === 'repository') return { created: false, workspaceRoot, repositoryRoot: existing.repositoryRoot };

  await canonicalWorkspaceRoot(workspaceRoot);
  const raced = await inspectCanonicalWorkspaceRepository(workspaceRoot, runner);
  if (raced.status === 'repository') return { created: false, workspaceRoot, repositoryRoot: raced.repositoryRoot };
  if (authorizeInitialization && !await authorizeInitialization()) throw new Error('Git initialization is no longer authorized for the active workspace execution.');

  let initialized: GitCommandResult;
  try {
    initialized = await runner('git', ['init'], workspaceRoot, 4096);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === 'ENOENT') await canonicalWorkspaceRoot(workspaceRoot);
    const classified = failureCode(cause, cause instanceof Error ? cause.message : '');
    const code = classified === 'inspection-failed' ? 'initialization-failed' : classified;
    throw new WorkspaceRepositoryError(code, failureMessage(code), { cause });
  }
  if (initialized.code !== 0) {
    const classified = failureCode(undefined, initialized.stderr);
    const code = classified === 'inspection-failed' ? 'initialization-failed' : classified;
    throw new WorkspaceRepositoryError(code, failureMessage(code));
  }

  const result = await inspectCanonicalWorkspaceRepository(workspaceRoot, runner);
  if (result.status === 'missing') throw new WorkspaceRepositoryError('initialization-failed', 'Git completed initialization but no repository was found in the selected folder.');
  return { created: samePath(result.repositoryRoot, workspaceRoot), workspaceRoot, repositoryRoot: result.repositoryRoot };
}

export async function ensureWorkspaceRepository(workspaceRoot: string, runner: GitWorkspaceCommand = runGit, authorizeInitialization?: () => boolean | Promise<boolean>) {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const previous = pendingInitializations.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pendingInitializations.set(key, current);
  await previous;
  try {
    return await ensureCanonicalWorkspaceRepository(root, runner, authorizeInitialization);
  } finally {
    release();
    if (pendingInitializations.get(key) === current) pendingInitializations.delete(key);
  }
}
