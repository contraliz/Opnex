import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { GitCommandResult, GitWorkspaceCommand } from './git-workspace.js';
import { pathIdentity, samePath } from './path-identity.js';
import { inspectWorkspaceRepository } from './workspace-git-init.js';

export type InitialCommitFile = {
  path: string;
  status: 'staged' | 'working' | 'staged and modified' | 'untracked';
};
type PreviewFileSnapshot = {
  path: string;
  worktreeHash: string | null;
  indexEntries: { mode: string; objectId: string; stage: string }[];
};
export type InitialCommitPreview = {
  status: 'unborn' | 'committed' | 'unavailable';
  eligible: boolean;
  reason?:
    | 'repository-missing'
    | 'project-not-repository-root'
    | 'already-committed'
    | 'unresolved-conflicts';
  branch?: string;
  files: InitialCommitFile[];
  totalFiles: number;
  empty: boolean;
  truncated: boolean;
  previewToken?: string;
};
export type InitialCommitRunner = (
  executable: 'git',
  args: string[],
  cwd: string,
  maxStdoutBytes?: number,
  input?: string | Buffer,
  timeoutMs?: number
) => Promise<GitCommandResult>;
export class InitialCommitError extends Error {
  constructor(
    readonly code:
      'invalid-message' | 'stale-preview' | 'missing-author' | 'git-failure' | 'conflict',
    message: string
  ) {
    super(message);
    this.name = 'InitialCommitError';
  }
}

const gitEnvironmentRedirects = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
]);

export const runInitialCommitGit: InitialCommitRunner = (
  executable,
  args,
  cwd,
  maxStdoutBytes = 4_000_000,
  input,
  timeoutMs = 120_000
) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of Object.keys(env))
      if (gitEnvironmentRedirects.has(key.toUpperCase())) delete env[key];

    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (error?: Error, result?: GitCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk) => {
      const text = String(chunk),
        room = maxStdoutBytes - stdout.length;
      stdout += text.slice(0, Math.max(0, room));
      if (text.length > room) {
        child.kill();
        finish(new Error('Git returned more output than expected.'));
      }
    });
    child.stderr!.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text.slice(0, Math.max(0, 4096 - stderr.length));
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(undefined, { code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Git did not finish the request in time.'));
    }, timeoutMs);
    timer.unref?.();
    if (input !== undefined) child.stdin!.end(input);
  });

const previews = new Map<string, { root: string; fingerprint: string; expiresAt: number }>();
const pendingCommits = new Map<string, Promise<void>>();
const PREVIEW_FILE_LIMIT = 300;
const PREVIEW_TTL_MS = 5 * 60_000;
const HASH_CONCURRENCY = 8;

function parsePorcelainV1Z(output: string): { entries: InitialCommitFile[]; conflicts: boolean } {
  const fields = output.split('\0');
  const entries: InitialCommitFile[] = [];
  let conflicts = false;
  for (let index = 0; index < fields.length; index++) {
    const row = fields[index]!;
    if (!row) continue;
    const x = row.slice(0, 1),
      y = row.slice(1, 2),
      file = row.slice(3);
    if (!file) continue;
    if (x === 'U' || y === 'U' || x + y === 'AA' || x + y === 'DD') conflicts = true;
    const status: InitialCommitFile['status'] =
      x === '?' && y === '?'
        ? 'untracked'
        : x !== ' ' && y !== ' '
          ? 'staged and modified'
          : x !== ' '
            ? 'staged'
            : 'working';
    entries.push({ path: file, status });
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index++;
  }
  return { entries, conflicts };
}

async function git(
  runner: InitialCommitRunner,
  args: string[],
  cwd: string,
  input?: string | Buffer
) {
  try {
    return await runner('git', args, cwd, 16_000_000, input);
  } catch {
    throw new InitialCommitError(
      'git-failure',
      'Git could not inspect this project. No initial commit was created.'
    );
  }
}

async function snapshotPreviewFiles(
  root: string,
  entries: InitialCommitFile[],
  runner: InitialCommitRunner
) {
  const sortedEntries = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const files: PreviewFileSnapshot[] = [];
  for (let start = 0; start < sortedEntries.length; start += HASH_CONCURRENCY) {
    const batch = await Promise.all(
      sortedEntries.slice(start, start + HASH_CONCURRENCY).map(async (file) => {
        let worktreeHash: string | null = null;
        let fileExists = true;
        try {
          await lstat(path.join(root, file.path));
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') fileExists = false;
          else
            throw new InitialCommitError(
              'git-failure',
              'The project files changed while Git was preparing the preview.'
            );
        }
        if (fileExists) {
          const hashed = await git(
            runner,
            ['hash-object', `--path=${file.path}`, '--', file.path],
            root
          );
          if (hashed.code !== 0)
            throw new InitialCommitError(
              'git-failure',
              'Git could not verify a file in this preview. No initial commit was created.'
            );
          worktreeHash = hashed.stdout.trim();
        }
        const index = await git(
          runner,
          ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file.path],
          root
        );
        if (index.code !== 0)
          throw new InitialCommitError(
            'git-failure',
            'Git could not verify the staged contents in this preview.'
          );
        const indexEntries = index.stdout
          .split('\0')
          .filter(Boolean)
          .map((row) => {
            const separator = row.indexOf('\t');
            if (separator < 0)
              throw new InitialCommitError('git-failure', 'Git returned an invalid index record.');
            const [mode, objectId, stage] = row.slice(0, separator).split(' ');
            if (!mode || !objectId || !stage)
              throw new InitialCommitError('git-failure', 'Git returned an invalid index record.');
            return { mode, objectId, stage };
          });
        return { path: file.path, worktreeHash, indexEntries };
      })
    );
    files.push(...batch);
  }
  return files;
}

async function currentSnapshot(
  workspaceRoot: string,
  runner: InitialCommitRunner
): Promise<{
  preview: InitialCommitPreview;
  root: string;
  fingerprint: string;
  entries?: InitialCommitFile[];
  files?: PreviewFileSnapshot[];
}> {
  const repoRunner: GitWorkspaceCommand = (executable, args, cwd, maxStdoutBytes) =>
    executable === 'git'
      ? runner('git', args, cwd, maxStdoutBytes)
      : Promise.resolve({ code: 127, stdout: '', stderr: '' });
  let inspected;
  try {
    inspected = await inspectWorkspaceRepository(workspaceRoot, repoRunner);
  } catch {
    return {
      preview: unavailable('repository-missing'),
      root: path.resolve(workspaceRoot),
      fingerprint: '',
    };
  }
  if (inspected.status === 'missing')
    return {
      preview: unavailable('repository-missing'),
      root: inspected.workspaceRoot,
      fingerprint: '',
    };
  const root = inspected.workspaceRoot;
  if (!samePath(root, inspected.repositoryRoot))
    return { preview: unavailable('project-not-repository-root'), root, fingerprint: '' };

  const [head, symbolic, refs] = await Promise.all([
    git(runner, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root),
    git(runner, ['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
    git(runner, ['show-ref', '--quiet'], root),
  ]);
  if (head.code === 0)
    return {
      preview: {
        ...unavailable('already-committed'),
        status: 'committed' as const,
        reason: 'already-committed' as const,
      },
      root,
      fingerprint: '',
    };
  if (symbolic.code !== 0 || refs.code !== 1)
    return { preview: unavailable(), root, fingerprint: '' };

  const status = await git(
    runner,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    root
  );
  if (status.code !== 0)
    throw new InitialCommitError(
      'git-failure',
      'Git could not prepare a safe file preview. No initial commit was created.'
    );
  const parsed = parsePorcelainV1Z(status.stdout);
  if (parsed.conflicts)
    return {
      preview: {
        ...unavailable('unresolved-conflicts'),
        status: 'unavailable' as const,
        reason: 'unresolved-conflicts' as const,
      },
      root,
      fingerprint: '',
    };
  const branch = symbolic.stdout.trim();
  const [stagedDiff, workingDiff] = await Promise.all([
    git(runner, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], root),
    git(runner, ['diff', '--binary', '--no-ext-diff', '--no-textconv'], root),
  ]);
  if (stagedDiff.code !== 0 || workingDiff.code !== 0)
    throw new InitialCommitError(
      'git-failure',
      'Git could not verify the files in this preview. No initial commit was created.'
    );
  const files = await snapshotPreviewFiles(root, parsed.entries, runner);
  const fingerprint = createHash('sha256')
    .update(root)
    .update('\0')
    .update(branch)
    .update('\0')
    .update(status.stdout)
    .update('\0')
    .update(stagedDiff.stdout)
    .update('\0')
    .update(workingDiff.stdout)
    .update('\0')
    .update(JSON.stringify(files))
    .digest('hex');
  const previewToken = randomUUID();
  previews.set(previewToken, { root, fingerprint, expiresAt: Date.now() + PREVIEW_TTL_MS });
  for (const [token, record] of previews) if (record.expiresAt < Date.now()) previews.delete(token);
  while (previews.size > 256) previews.delete(previews.keys().next().value!);
  const totalFiles = parsed.entries.length;
  const preview: InitialCommitPreview = {
    status: 'unborn',
    eligible: true,
    branch,
    files: parsed.entries.slice(0, PREVIEW_FILE_LIMIT),
    totalFiles,
    empty: totalFiles === 0,
    truncated: totalFiles > PREVIEW_FILE_LIMIT,
    previewToken,
  };
  return { preview, root, fingerprint, entries: parsed.entries, files };
}

function unavailable(reason?: InitialCommitPreview['reason']): InitialCommitPreview {
  return {
    status: 'unavailable',
    eligible: false,
    ...(reason ? { reason } : {}),
    files: [],
    totalFiles: 0,
    empty: true,
    truncated: false,
  };
}

export async function previewInitialCommit(
  workspaceRoot: string,
  runner: InitialCommitRunner = runInitialCommitGit
): Promise<InitialCommitPreview> {
  return (await currentSnapshot(workspaceRoot, runner)).preview;
}

export async function createInitialCommit(
  input: { workspaceRoot: string; previewToken: string; message: string },
  runner: InitialCommitRunner = runInitialCommitGit
): Promise<{ commit: string; branch: string }> {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 500 || message.includes('\0') || !input.previewToken)
    throw new InitialCommitError(
      'invalid-message',
      'Enter a commit message of 1 to 500 characters.'
    );
  const savedPreview = previews.get(input.previewToken);
  previews.delete(input.previewToken);
  if (!savedPreview || savedPreview.expiresAt < Date.now())
    throw new InitialCommitError(
      'stale-preview',
      'This file preview expired. Refresh the Git workspace and review the files again.'
    );

  const key = pathIdentity(savedPreview.root);
  const prior = pendingCommits.get(key) || Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => lock);
  pendingCommits.set(key, queued);
  await prior;
  try {
    const snapshot = (await currentSnapshot(input.workspaceRoot, runner)) as Awaited<
      ReturnType<typeof currentSnapshot>
    > & { entries?: InitialCommitFile[] };
    if (
      !snapshot.preview.eligible ||
      !samePath(snapshot.root, savedPreview.root) ||
      snapshot.fingerprint !== savedPreview.fingerprint
    )
      throw new InitialCommitError(
        'stale-preview',
        'The repository changed after this preview. Refresh and review the files before creating the initial commit.'
      );
    const entries = snapshot.entries || [];
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const response = await git(runner, ['var', identity], snapshot.root);
      if (response.code !== 0)
        throw new InitialCommitError(
          'missing-author',
          'Configure Git author and committer identity for this repository, then review the files again. Opnex did not change Git configuration.'
        );
    }

    const toStage = entries
      .filter((file) => file.status === 'working' || file.status === 'untracked')
      .map((file) => file.path);
    if (toStage.length) {
      const pathspecs = Buffer.from(`${toStage.join('\0')}\0`, 'utf8');
      const staged = await git(
        runner,
        ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        snapshot.root,
        pathspecs
      );
      if (staged.code !== 0)
        throw new InitialCommitError(
          'git-failure',
          'Git could not stage the reviewed project files. No initial commit was created.'
        );
    }

    const current = await currentSnapshotAfterStage(snapshot.root, runner);
    const expectedPaths = entries.map((file) => file.path).sort();
    const currentPaths = (current.entries || []).map((file) => file.path).sort();
    if (!current.unborn)
      throw new InitialCommitError(
        'stale-preview',
        'A commit appeared while the preview was being prepared. Refresh the Git workspace; no second commit was created.'
      );
    if (
      !samePath(current.root, savedPreview.root) ||
      JSON.stringify(currentPaths) !== JSON.stringify(expectedPaths) ||
      !matchesWorktreeSnapshot(snapshot.files || [], current.files || []) ||
      !matchesStagedPreview(entries, snapshot.files || [], current.files || [])
    )
      throw new InitialCommitError(
        'stale-preview',
        'The project files changed while the preview was being prepared. Refresh and review the files before creating the initial commit.'
      );

    const stagedChanges = await git(runner, ['diff', '--cached', '--quiet'], snapshot.root);
    if (stagedChanges.code !== 0 && stagedChanges.code !== 1)
      throw new InitialCommitError(
        'git-failure',
        'Git could not verify the initial commit contents. No initial commit was created.'
      );
    const commitArgs = ['commit', '-m', message];
    if (stagedChanges.code === 0) commitArgs.push('--allow-empty');
    const committed = await git(runner, commitArgs, snapshot.root);
    if (committed.code !== 0) {
      const stderr = committed.stderr;
      if (
        /identity unknown|unable to auto-detect email address|no user.name|no user.email/i.test(
          stderr
        )
      )
        throw new InitialCommitError(
          'missing-author',
          'Configure Git author and committer identity for this repository, then review the files again. Opnex did not change Git configuration.'
        );
      if (/unmerged|merge conflict/i.test(stderr))
        throw new InitialCommitError(
          'conflict',
          'Resolve the repository conflicts before creating an initial commit.'
        );
      throw new InitialCommitError(
        'git-failure',
        'Git could not create the initial commit. Check the repository hooks and signing configuration, then try again.'
      );
    }
    const [head, branch] = await Promise.all([
      git(runner, ['rev-parse', '--verify', 'HEAD^{commit}'], snapshot.root),
      git(runner, ['symbolic-ref', '--quiet', '--short', 'HEAD'], snapshot.root),
    ]);
    if (head.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(head.stdout.trim()) || branch.code !== 0)
      throw new InitialCommitError(
        'git-failure',
        'Git reported an invalid initial commit result. Inspect the repository history before retrying.'
      );
    return { commit: head.stdout.trim(), branch: branch.stdout.trim() };
  } finally {
    release();
    if (pendingCommits.get(key) === queued) pendingCommits.delete(key);
  }
}

async function currentSnapshotAfterStage(workspaceRoot: string, runner: InitialCommitRunner) {
  const repoRunner: GitWorkspaceCommand = (executable, args, cwd, maxStdoutBytes) =>
    executable === 'git'
      ? runner('git', args, cwd, maxStdoutBytes)
      : Promise.resolve({ code: 127, stdout: '', stderr: '' });
  const inspected = await inspectWorkspaceRepository(workspaceRoot, repoRunner);
  if (
    inspected.status === 'missing' ||
    !samePath(inspected.workspaceRoot, inspected.repositoryRoot)
  )
    return { root: inspected.workspaceRoot, unborn: false };
  const [head, symbolic, refs, status] = await Promise.all([
    git(runner, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], inspected.workspaceRoot),
    git(runner, ['symbolic-ref', '--quiet', '--short', 'HEAD'], inspected.workspaceRoot),
    git(runner, ['show-ref', '--quiet'], inspected.workspaceRoot),
    git(
      runner,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      inspected.workspaceRoot
    ),
  ]);
  const entries = status.code === 0 ? parsePorcelainV1Z(status.stdout).entries : [];
  return {
    root: inspected.workspaceRoot,
    unborn: head.code !== 0 && symbolic.code === 0 && refs.code === 1,
    entries,
    files: await snapshotPreviewFiles(inspected.workspaceRoot, entries, runner),
  };
}

function matchesWorktreeSnapshot(expected: PreviewFileSnapshot[], observed: PreviewFileSnapshot[]) {
  return (
    JSON.stringify(expected.map(({ path: file, worktreeHash }) => [file, worktreeHash])) ===
    JSON.stringify(observed.map(({ path: file, worktreeHash }) => [file, worktreeHash]))
  );
}

function matchesStagedPreview(
  entries: InitialCommitFile[],
  expected: PreviewFileSnapshot[],
  observed: PreviewFileSnapshot[]
) {
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const observedByPath = new Map(observed.map((file) => [file.path, file]));
  for (const entry of entries) {
    const before = expectedByPath.get(entry.path);
    const after = observedByPath.get(entry.path);
    if (!before || !after) return false;
    if (entry.status === 'working' || entry.status === 'untracked') {
      const expectedObjectId = before.worktreeHash;
      if (expectedObjectId === null) {
        if (after.indexEntries.length) return false;
      } else if (
        after.indexEntries.length !== 1 ||
        after.indexEntries[0]?.objectId !== expectedObjectId ||
        after.indexEntries[0]?.stage !== '0'
      )
        return false;
    } else if (JSON.stringify(before.indexEntries) !== JSON.stringify(after.indexEntries))
      return false;
  }
  return true;
}
