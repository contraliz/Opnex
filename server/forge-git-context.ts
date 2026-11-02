import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { samePath } from './path-identity.js';
import { promisify } from 'node:util';
import type { ForgeAttempt, ForgeIntegrationRun, ForgeTicket } from './forge-contracts.js';
import type { PreparedForgeWorktrees } from './forge-git.js';
import { forgeGitWritableRoots, validateRecruitmentRoot } from './recruitment-git.js';

const execFileAsync = promisify(execFile);
const branchSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function forgeAttemptWorkerId(attemptId: string) {
  if (!branchSegmentPattern.test(attemptId))
    throw new Error('Forge attempt ID cannot be used in a worker branch.');
  return `w-${attemptId.replaceAll('-', '').slice(0, 28)}`;
}

export function forgeBranchName(
  ticketId: string,
  attemptId: string,
  role: 'worker' | 'integration',
  workerId?: string
) {
  if (!branchSegmentPattern.test(ticketId) || !branchSegmentPattern.test(attemptId))
    throw new Error('Forge ticket and attempt IDs must be safe Git branch segments.');
  if (role === 'integration') return `codex/forge/${ticketId}/${attemptId}/integration/head`;
  if (!workerId || !branchSegmentPattern.test(workerId))
    throw new Error('Forge worker ID must be a safe Git branch segment.');
  return `codex/forge/${ticketId}/${attemptId}/worker/${workerId}/head`;
}

export function forgeAttemptRoot(stateRoot: string, ticketId: string, attemptId: string) {
  if (
    !path.isAbsolute(stateRoot) ||
    !branchSegmentPattern.test(ticketId) ||
    !branchSegmentPattern.test(attemptId)
  )
    throw new Error('Forge worktree identity is invalid.');
  return path.join(stateRoot, 'forge-worktrees', ticketId, attemptId);
}

export async function createForgeAttemptParent(taskRoot: string) {
  if (!path.isAbsolute(taskRoot)) throw new Error('Forge task root must be absolute.');
  await mkdir(path.dirname(taskRoot), { recursive: true });
}

/** Recover the F2 ownership shape from persisted ticket/attempt identity, then let F2 validate the manifest and refs. */
export async function restoreForgeWorkerWorktrees(
  ticket: ForgeTicket,
  attempt: ForgeAttempt
): Promise<PreparedForgeWorktrees> {
  if (attempt.taskId !== ticket.workitems.find((task) => task.id === attempt.taskId)?.id)
    throw new Error('Forge attempt does not belong to a saved ticket work item.');
  const workerId = attempt.claim.ownerId;
  const expectedBranch = forgeBranchName(ticket.id, attempt.id, 'worker', workerId);
  if (attempt.branch !== expectedBranch)
    throw new Error('Saved Forge worker branch does not match its ticket, attempt, and owner.');
  const taskRoot = path.dirname(path.resolve(attempt.worktreeRoot));
  const expectedWorkerRoot = path.join(taskRoot, `worker-${workerId}`);
  if (!samePath(attempt.worktreeRoot, expectedWorkerRoot))
    throw new Error('Saved Forge worker worktree does not match its generated attempt root.');
  const prepared: PreparedForgeWorktrees = {
    canonicalRoot: ticket.workspaceRoot,
    taskRoot,
    ticketId: ticket.id,
    attemptId: attempt.id,
    baseCommit: attempt.sourceBaselineSha,
    integration: {
      branch: forgeBranchName(ticket.id, attempt.id, 'integration'),
      worktreeRoot: path.join(taskRoot, 'integration'),
    },
    workers: [
      {
        workerId,
        branch: attempt.branch,
        worktreeRoot: attempt.worktreeRoot,
        baselineCommit: attempt.sourceBaselineSha,
      },
    ],
  };
  await forgeGitWritableRoots({
    canonicalRoot: prepared.canonicalRoot,
    taskRoot,
    ticketId: ticket.id,
    attemptId: attempt.id,
    role: 'worker',
    workerId,
    worktreeRoot: attempt.worktreeRoot,
  });
  return prepared;
}

/** The integration worktree has a distinct role and no worker actor of its own. */
export async function restoreForgeIntegrationWorktrees(
  ticket: ForgeTicket,
  run: ForgeIntegrationRun
): Promise<PreparedForgeWorktrees> {
  const taskRoot = path.dirname(path.resolve(run.worktreeRoot));
  const expectedRoot = path.join(taskRoot, 'integration');
  if (
    !samePath(run.worktreeRoot, expectedRoot) ||
    run.branch !== forgeBranchName(ticket.id, run.id, 'integration')
  )
    throw new Error('Saved Forge integration worktree does not match its ticket and run identity.');
  const prepared: PreparedForgeWorktrees = {
    canonicalRoot: ticket.workspaceRoot,
    taskRoot,
    ticketId: ticket.id,
    attemptId: run.id,
    baseCommit: run.sourceBaselineSha,
    integration: { branch: run.branch, worktreeRoot: run.worktreeRoot },
    workers: [],
  };
  await forgeGitWritableRoots({
    canonicalRoot: prepared.canonicalRoot,
    taskRoot,
    ticketId: ticket.id,
    attemptId: run.id,
    role: 'integration',
    worktreeRoot: run.worktreeRoot,
  });
  return prepared;
}

/** Selects a local main/default branch without remote writes; F2 validates the chosen ref and pins its commit. */
export async function resolveLocalForgeTargetBranch(canonicalRoot: string): Promise<string> {
  let remoteDefault = '';
  try {
    const result = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: canonicalRoot,
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }
    );
    remoteDefault = String(result.stdout)
      .trim()
      .replace(/^origin\//, '');
  } catch {
    /* An unconfigured remote HEAD is common in local repositories. */
  }
  for (const candidate of [...new Set([remoteDefault, 'main', 'master'])].filter(Boolean)) {
    if (!branchSegmentPattern.test(candidate)) continue;
    try {
      await validateRecruitmentRoot(canonicalRoot, candidate);
      return candidate;
    } catch {
      /* Try the next local main/default candidate. */
    }
  }
  throw new Error(
    'Forge needs an available local main branch. Create or fetch the default branch (main or master), then retry ticket creation.'
  );
}
