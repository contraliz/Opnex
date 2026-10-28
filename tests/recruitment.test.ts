import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { recruitmentWorkersSchema } from '../server/contracts.js';
import { integrationReadScope, rebaseRecruitmentAssignment } from '../server/recruitment-scope.js';
import {
  cancelRecruitmentTeamState,
  claimRecruitmentCompletion,
  claimRecruitmentIntegration,
  pauseRecruitmentTeamAfterRestart,
  upgradeStoredState,
  type RecruitmentTeam,
} from '../server/state.js';

const assignment = {
  outcome: 'Implement a bounded feature',
  deliverable: 'A scoped code change',
  read_scope: ['D:/project/src'],
  write_scope: ['D:/project/src'],
  exclusions: ['Do not change unrelated files'],
  constraints: ['Use the selected project'],
  context_refs: ['REQ-1'],
  skill_refs: [],
  acceptance: ['Feature works'],
  verification: ['Run targeted checks'],
  ordinary_authority: ['Make routine implementation decisions'],
  escalation_conditions: ['Escalate cross-project changes'],
  receipt_requirements: ['Report changed files and test results'],
};

function teamFixture(workerStatuses: Array<'queued'|'running'|'complete'|'failed'|'escalated'|'cancelled'> = ['running','queued']): RecruitmentTeam {
  const workers = workerStatuses.map((status, index) => ({
    workerId: `worker-${index}`,
    name: `Worker ${index}`,
    assignment,
    effort: 'high' as const,
    skills: [],
    branch: `recruitment/task/worker-${index}`,
    worktreeRoot: `D:/state/worktrees/worker-${index}`,
    status,
    threadId: `thread-${index}`,
    ...(status === 'running' ? { activeTurnId: `turn-${index}` } : {}),
  }));
  return {
    teamId: 'team',
    passId: 'pass',
    createdAt: '2026-10-26T00:00:00.000Z',
    canonicalProjectRoot: 'D:/project',
    agentmemProjectId: 'pseudoharness',
    workspaceParent: 'D:/state/worktrees/task/pass',
    baseRef: 'HEAD',
    baseCommit: 'a'.repeat(40),
    status: 'running',
    sealed: true,
    workers,
    integration: {
      status: 'queued',
      branch: 'recruitment/task/integration',
      worktreeRoot: 'D:/state/worktrees/integration',
      assignment,
      effort: 'high',
      skills: [],
    },
    toolCallIds: ['call'],
    completionWakeSent: false,
  };
}

describe('recruited worker team contracts and recovery', () => {
  it('enforces the 1–9 worker cap, complete assignments and supported efforts', () => {
    const plan = (count: number, effort = 'max') => ({ workers: Array.from({ length: count }, (_, index) => ({ name: `Worker ${index}`, step: `Implement worker ${index}'s independent step`, depends_on: [], assignment, effort, skill_refs: [] })) });
    expect(recruitmentWorkersSchema.parse(plan(1)).workers).toHaveLength(1);
    expect(recruitmentWorkersSchema.parse(plan(9)).workers).toHaveLength(9);
    expect(recruitmentWorkersSchema.safeParse(plan(10)).success).toBe(false);
    expect(recruitmentWorkersSchema.safeParse(plan(2, 'low')).success).toBe(false);
    expect(recruitmentWorkersSchema.safeParse(plan(2, 'high')).success).toBe(false);
    expect(recruitmentWorkersSchema.safeParse({ workers: [{ name: 'Missing assignment', effort: 'high', skill_refs: [] }] }).success).toBe(false);
  });

  it('defaults worker effort to max when the model omits it', () => {
    const { effort: _effort, ...worker } = { name: 'Default', step: 'Implement an independent step', depends_on: [], assignment, effort: 'max', skill_refs: [] };
    expect(recruitmentWorkersSchema.parse({ workers: [worker] }).workers[0].effort).toBe('max');
  });

  it('keeps canonical project identity while rebasing only the worker filesystem scopes', () => {
    const canonical = path.resolve('D:/projects/pseudoharness');
    const worktree = path.resolve('D:/app-state/worktrees/task/worker-a');
    const scoped = { ...assignment, read_scope: [path.join(canonical, 'src'), 'REQ-1'], write_scope: [path.join(canonical, 'src')] };
    const local = rebaseRecruitmentAssignment(scoped, canonical, worktree);
    expect(local.read_scope).toEqual([path.join(worktree, 'src'), 'REQ-1']);
    expect(local.write_scope).toEqual([path.join(worktree, 'src')]);
    expect(scoped.read_scope[0]).toBe(path.join(canonical, 'src'));
    expect(() => rebaseRecruitmentAssignment({ ...scoped, read_scope: [path.resolve('D:/other-project/private')] }, canonical, worktree)).toThrow(/escapes/i);
  });

  it('gives integration read access to validated worker output scopes without widening individual workers', () => {
    const alpha = { ...assignment, read_scope: ['D:/project/README.md'], write_scope: ['D:/project/qa-artifacts/alpha'] };
    const beta = { ...assignment, read_scope: ['D:/project/README.md'], write_scope: ['D:/project/qa-artifacts/beta'] };
    expect(integrationReadScope([alpha, beta])).toEqual(['D:/project/README.md', 'D:/project/qa-artifacts/alpha', 'D:/project/qa-artifacts/beta']);
    expect(alpha.read_scope).toEqual(['D:/project/README.md']);
    expect(beta.read_scope).toEqual(['D:/project/README.md']);
  });

  it('claims integration once and only after every worker is terminal', () => {
    const team = teamFixture();
    expect(claimRecruitmentIntegration(team)).toBe(false);
    team.workers.forEach(worker => { worker.status = 'complete'; });
    expect(claimRecruitmentIntegration(team)).toBe(true);
    expect(team).toMatchObject({ status: 'integrating', integration: { status: 'preparing' } });
    expect(claimRecruitmentIntegration(team)).toBe(false);
  });

  it('makes final wake idempotent and records cancellation without erasing terminal outcomes', () => {
    const team = teamFixture(['complete','running']);
    expect(claimRecruitmentCompletion(team)).toBe(true);
    expect(claimRecruitmentCompletion(team)).toBe(false);
    cancelRecruitmentTeamState(team);
    expect(team.status).toBe('cancelled');
    expect(team.workers.map(worker => worker.status)).toEqual(['complete','cancelled']);
    expect(team.integration.status).toBe('cancelled');
    expect(team.workers[1].activeTurnId).toBeUndefined();
  });

  it('pauses interrupted work on restart while preserving the canonical project identity and completed receipts', () => {
    const team = teamFixture(['complete','running']);
    team.workers[0].headCommit = 'b'.repeat(40);
    team.integration.status = 'preparing';
    pauseRecruitmentTeamAfterRestart(team);
    expect(team.status).toBe('paused_after_restart');
    expect(team.workers.map(worker => worker.status)).toEqual(['complete','paused_after_restart']);
    expect(team.integration.status).toBe('paused_after_restart');
    expect(team.workers[0].headCommit).toBe('b'.repeat(40));
    expect(team.canonicalProjectRoot).toBe('D:/project');
    expect(team.agentmemProjectId).toBe('pseudoharness');
    expect(pauseRecruitmentTeamAfterRestart(team)).toBeUndefined();
  });

  it('migrates an active recruited pass to paused recovery instead of restarting workers', () => {
    const team = teamFixture(['running','queued']);
    const task = {
      id: 'task', title: 'Original task', phase: 'worker_running', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:01:00.000Z',
      userRoot: 'D:/project', agentmemProjectId: 'pseudoharness', userMessages: ['Original task'], messages: [], correctionCount: 0,
      processedTurns: [], currentPassId: 'pass', activeTurnId: 'turn-0', activeRole: 'worker',
      passes: [{ id: 'pass', index: 1, createdAt: '2026-10-26T00:00:00.000Z', userInput: 'Original task', userInputs: ['Original task'], userMessageIds: [], phase: 'worker_running', correctionCount: 0, processedTurns: [], recruitmentTeam: team }],
    };
    const recovered = upgradeStoredState({ version: 2, settings: {}, tasks: [task], activeTaskId: 'task' }).tasks[0];
    expect(recovered.phase).toBe('paused_after_restart');
    expect(recovered.passes?.[0].recruitmentTeam?.workers.map(worker => worker.status)).toEqual(['paused_after_restart','paused_after_restart']);
    expect(recovered.passes?.[0].recruitmentTeam?.integration.status).toBe('paused_after_restart');
    expect(recovered.passes?.[0].recruitmentTeam?.canonicalProjectRoot).toBe('D:/project');
  });
});
