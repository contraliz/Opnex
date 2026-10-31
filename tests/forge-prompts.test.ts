import { describe, expect, it } from 'vitest';
import { createForgeTicket, applyForgeCommand } from '../server/forge-state.js';
import type { ForgePlanTaskInput, ForgeSkillSnapshot, ForgeTicket } from '../server/forge-contracts.js';
import {
  forgePlanOutputSchema,
  parseForgeIntegratorOutput,
  parseForgePlanOutput,
  parseForgeReviewOutput,
} from '../server/forge-prompts.js';

const at = '2026-10-31T00:00:00.000Z';
const skill: ForgeSkillSnapshot = { id: 'skill-a', revision: 'rev-1', name: 'Scoped skill', description: '', source: 'library', instructions: 'Use the selected guidance.', files: [] };
const receipt = {
  status: 'complete' as const,
  result: 'Implemented the requested change.',
  changes: ['src/a.ts'],
  acceptance: { met: ['The requested behavior is present.'], unmet: [] },
  verification: [{ check: 'focused suite', result: 'passed' as const, evidence: '1 test passed.' }],
  risks: [], knowledge: { consulted: [], updated: [] }, decision_required: null,
};
const assignment = {
  outcome: 'Implement the requested behavior.', deliverable: 'A verified code change.', read_scope: ['C:/repo/src'], write_scope: ['C:/repo/src'], exclusions: [], constraints: [], context_refs: [], skill_refs: ['skill-a'], acceptance: ['The behavior works.'], verification: ['Run focused tests.'], ordinary_authority: ['Edit files under src.'], escalation_conditions: ['A required API change is missing.'], receipt_requirements: ['Return observed checks.'],
};
const ticket = (skills: ForgeSkillSnapshot[] = [skill]): ForgeTicket => createForgeTicket({
  id: 'ticket-1', projectId: '11111111-1111-4111-8111-111111111111', workspaceRoot: 'C:/repo', title: 'Example', description: 'Implement the requested behavior.', acceptanceCriteria: ['The behavior works.'],
  scope: { read: ['C:/repo'], write: ['C:/repo/src'], knowledge: ['D:/projects/repo'] },
  orchestrator: { model: 'gpt-6-luna', effort: 'low' }, workerProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, orchestratorSkills: skills,
  capabilities: { filesystemWriteScope: 'enforced', knowledgeScope: 'instruction-only', operationBudget: 'instruction-only', toolAuthorization: 'monitored', cancellation: 'monitored', commitScopeValidation: 'enforced', finalMergeGate: 'enforced' }, createdAt: at,
});
const planTask = (): ForgePlanTaskInput => ({
  id: 'task-a', title: 'Implement', description: 'Implement the behavior.', dependencyIds: [], assignment, knowledgeScope: ['D:/projects/repo'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, skillSnapshots: [skill],
});
function acceptedTicket() {
  const saved = ticket();
  const proposed = applyForgeCommand(saved, { type: 'submit_manual_plan', actor: { role: 'user', id: 'user' }, planId: 'plan-a', tasks: [planTask()] }, at);
  return applyForgeCommand(proposed, { type: 'accept_plan', actor: { role: 'user', id: 'user' }, revision: 1 }, at);
}

describe('Forge role prompt contracts', () => {
  it('maps only pinned skill IDs from the structured plan into F1 task assignments', () => {
    const plan = {
      type: 'plan', knowledgeOperations: 0, tasks: [{ id: 'task-a', title: 'Implement', description: 'Implement the behavior.', dependencyIds: [], assignment, knowledgeScope: ['D:/projects/repo'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, skillIds: ['skill-a'] }],
    };
    expect(forgePlanOutputSchema.parse(plan).tasks).toHaveLength(1);
    expect(parseForgePlanOutput(JSON.stringify(plan), ticket())[0].skillSnapshots).toEqual([skill]);
  });

  it('rejects invented skill revisions and a silent worker-profile substitution', () => {
    const plan = {
      type: 'plan', knowledgeOperations: 0, tasks: [{ id: 'task-a', title: 'Implement', description: 'Implement the behavior.', dependencyIds: [], assignment, knowledgeScope: ['D:/projects/repo'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, skillIds: ['invented'] }],
    };
    expect(() => parseForgePlanOutput(JSON.stringify(plan), ticket())).toThrow(/immutable skill snapshot/i);
    expect(() => parseForgePlanOutput(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], skillIds: [], executionProfile: { provider: 'deepseek', model: 'changed', effort: 'high' } }] }), ticket())).toThrow(/changed the worker profile/i);
    expect(() => forgePlanOutputSchema.parse({ ...plan, extra: true })).toThrow();
  });

  it('pins the external AgentMem skill on every worker assignment without duplicating an exact snapshot', () => {
    const knowledge: ForgeSkillSnapshot = { id: 'codex:agentmem-project', revision: 'sha256:one', name: 'agentmem-project', description: 'External knowledge skill.', source: 'Configured skill', instructions: 'Resolve the exact canonical root.', files: [] };
    const saved = ticket([skill, knowledge]);
    const plan = { type: 'plan', knowledgeOperations: 0, tasks: [{ id: 'task-a', title: 'Implement', description: 'Implement the behavior.', dependencyIds: [], assignment, knowledgeScope: ['D:/projects/repo'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, skillIds: ['skill-a'] }] };
    const selected = parseForgePlanOutput(JSON.stringify(plan), saved)[0].skillSnapshots;
    expect(selected).toEqual([skill, knowledge]);
    const selectedTwice = parseForgePlanOutput(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], skillIds: ['skill-a', knowledge.id] }] }), saved)[0].skillSnapshots;
    expect(selectedTwice).toEqual([skill, knowledge]);
  });

  it('requires the integrator to return every exact saved receipt for the pinned attempt', () => {
    const saved = [{ taskId: 'task-a', attemptId: 'attempt-a', receiptId: 'receipt-a', receipt }];
    const output = { type: 'integration', knowledgeOperations: 0, receipt, workerReceipts: saved, scopeValidation: { status: 'passed', evidence: ['All changed files match the accepted scopes.'] }, verification: [{ check: 'focused suite', result: 'passed', evidence: '1 test passed.' }], findings: [], corrections: [] };
    expect(parseForgeIntegratorOutput(JSON.stringify(output), saved).workerReceipts).toEqual(saved);
    expect(() => parseForgeIntegratorOutput(JSON.stringify({ ...output, workerReceipts: [{ ...saved[0], receipt: { ...receipt, result: 'rewritten' } }] }), saved)).toThrow(/exact saved receipt/i);
    expect(() => parseForgeIntegratorOutput(JSON.stringify({ ...output, workerReceipts: [] }), saved)).toThrow(/workerReceipts/i);
  });

  it('binds final review to the exact candidate and target main', () => {
    const candidate = 'a'.repeat(40), target = 'b'.repeat(40), saved = acceptedTicket();
    const output = { type: 'review', knowledgeOperations: 0, candidateSha: candidate, targetMainSha: target, disposition: 'accept', note: 'Receipt and diff pass.', corrections: [] };
    expect(parseForgeReviewOutput(JSON.stringify(output), candidate, target, saved).disposition).toBe('accept');
    expect(() => parseForgeReviewOutput(JSON.stringify({ ...output, targetMainSha: 'c'.repeat(40) }), candidate, target, saved)).toThrow(/different Forge candidate or target-main/i);
  });
});
