import { z } from 'zod';
import path from 'node:path';
import {
  assignmentSchema,
  assignmentJsonSchema,
  receiptSchema,
  workerOutcomeSchema,
  workerOutcomeJsonSchema,
  type Assignment,
  type Receipt,
} from './contracts.js';
import {
  forgeIntegrationFindingSchema,
  forgePlanTaskInputSchema,
  type ForgePlanTaskInput,
  type ForgeSkillSnapshot,
  type ForgeTicket,
} from './forge-contracts.js';
import { parseWorkerStructuredOutput as parseForgeStructuredOutput } from './worker-staging.js';

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(12000);
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const profile = z.object({ provider: z.enum(['codex', 'deepseek']), model: z.string().trim().min(1).max(200), effort }).strict();
const knowledgeOperations = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const receiptJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'result', 'changes', 'acceptance', 'verification', 'risks', 'knowledge', 'decision_required'],
  properties: {
    status: { type: 'string', enum: ['complete', 'incomplete', 'blocked', 'failed'] }, result: { type: 'string', minLength: 1, maxLength: 12000 },
    changes: { type: 'array', maxItems: 40, items: { type: 'string' } }, acceptance: { type: 'object', additionalProperties: false, required: ['met', 'unmet'], properties: { met: { type: 'array', maxItems: 30, items: { type: 'string' } }, unmet: { type: 'array', maxItems: 30, items: { type: 'string' } } } },
    verification: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['check', 'result', 'evidence'], properties: { check: { type: 'string' }, result: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, evidence: { type: ['string', 'null'], maxLength: 4000 } } } },
    risks: { type: 'array', maxItems: 40, items: { type: 'string' } }, knowledge: { type: 'object', additionalProperties: false, required: ['consulted', 'updated'], properties: { consulted: { type: 'array', maxItems: 40, items: { type: 'string' } }, updated: { type: 'array', maxItems: 40, items: { type: 'string' } } } }, decision_required: { type: ['string', 'null'], maxLength: 4000 },
  },
} as const;

const forgeModelPlanTaskSchema = z.object({
  id,
  title: z.string().trim().min(1).max(160),
  description: text,
  dependencyIds: z.array(id).max(16),
  assignment: assignmentSchema,
  knowledgeScope: z.array(text.max(1024)).max(80),
  executionProfile: profile,
  skillIds: z.array(id).max(12),
}).strict();

export const forgePlanOutputSchema = z.object({
  type: z.literal('plan'),
  tasks: z.array(forgeModelPlanTaskSchema).min(1).max(16),
  knowledgeOperations,
}).strict();

export type ForgePlanOutput = z.infer<typeof forgePlanOutputSchema>;

export const forgePlanOutputJsonSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'tasks', 'knowledgeOperations'],
  properties: {
    type: { type: 'string', enum: ['plan'] },
    knowledgeOperations: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    tasks: { type: 'array', minItems: 1, maxItems: 16, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'title', 'description', 'dependencyIds', 'assignment', 'knowledgeScope', 'executionProfile', 'skillIds'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', minLength: 1, maxLength: 12000 },
        dependencyIds: { type: 'array', maxItems: 16, items: { type: 'string' } },
        assignment: assignmentJsonSchema,
        knowledgeScope: { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 1024 } },
        executionProfile: { type: 'object', additionalProperties: false, required: ['provider', 'model', 'effort'], properties: {
          provider: { type: 'string', enum: ['codex', 'deepseek'] }, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        } },
        skillIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
      },
    } },
  },
} as const;

export function parseForgePlanOutput(raw: string, ticket: ForgeTicket, knowledgeSkill?: ForgeSkillSnapshot): ForgePlanTaskInput[] {
  const result = forgePlanOutputSchema.parse(parseForgeStructuredOutput(raw));
  if (result.tasks.length > 16) throw new Error('A Forge plan may contain at most 16 work items.');
  const snapshots = new Map(ticket.orchestratorSkills.map((skill) => [skill.id, skill]));
  return result.tasks.map((task) => {
    if (JSON.stringify(task.executionProfile) !== JSON.stringify(ticket.workerProfile)) {
      throw new Error(`Forge task ${task.id} changed the worker profile selected for this ticket.`);
    }
    if (new Set(task.skillIds).size !== task.skillIds.length) throw new Error(`Forge task ${task.id} selected one skill more than once.`);
    const skillSnapshots = task.skillIds.map((skillId) => {
      const skill = snapshots.get(skillId);
      if (!skill) throw new Error(`Forge task ${task.id} selected skill ${skillId}, which is not in the ticket's immutable skill snapshot.`);
      return structuredClone(skill);
    });
    const requiredKnowledge = knowledgeSkill || ticket.orchestratorSkills.find((skill) => skill.name.toLowerCase() === 'agentmem-project');
    if (requiredKnowledge && !skillSnapshots.some((skill) => skill.id === requiredKnowledge.id && skill.revision === requiredKnowledge.revision)) {
      skillSnapshots.push(structuredClone(requiredKnowledge));
    }
    const { skillIds: _skillIds, ...planned } = task;
    return forgePlanTaskInputSchema.parse({ ...planned, assignment: normalizeForgeAssignmentPaths(planned.assignment, ticket.workspaceRoot), skillSnapshots });
  });
}

export function normalizeForgeAssignmentPaths(assignment: Assignment, workspaceRoot: string): Assignment {
  const normalize = (value: string) => {
    if (/^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i.test(value)) return value;
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
  };
  return { ...assignment, read_scope: assignment.read_scope.map(normalize), write_scope: assignment.write_scope.map(normalize) };
}

export function parseForgePlanResult(raw: string, ticket: ForgeTicket, knowledgeSkill?: ForgeSkillSnapshot) {
  const result = forgePlanOutputSchema.parse(parseForgeStructuredOutput(raw));
  return { knowledgeOperations: result.knowledgeOperations, tasks: parseForgePlanOutput(raw, ticket, knowledgeSkill) };
}

export function forgePlanPrompt(ticket: ForgeTicket, workspaceName: string, knowledgeSkill: ForgeSkillSnapshot | undefined, knowledgeBudget: unknown): string {
  const selected = [...ticket.orchestratorSkills];
  if (knowledgeSkill && !selected.some((skill) => skill.id === knowledgeSkill.id && skill.revision === knowledgeSkill.revision)) selected.push(knowledgeSkill);
  return [
    `Create one complete Forge execution plan for this ticket. Return a single JSON object matching the supplied schema. Choose one complete assignment or a dependency DAG of at most 16 work items. The app schedules approved ready items automatically; do not add context-plan or context-compose stages. Use only the ticket read/write/knowledge scopes and the selected worker provider/model/effort. Every task needs a complete assignment, explicit acceptance and verification, ordinary authority, escalation conditions, and receipt requirements. Return only skillIds from the immutable selected skill catalog; the app resolves their immutable snapshots. Do not fabricate an AgentMem lookup or identity. If the ticket needs unavailable knowledge, state that in the plan constraints and keep the task blocked until the missing capability is configured.`,
    `WORKSPACE: ${workspaceName}\nCanonical source root: ${ticket.workspaceRoot}\nExecution worktrees are linked to this canonical workspace; they are not new knowledge bases.`,
    `TICKET:\n${JSON.stringify({ id: ticket.id, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria, scope: ticket.scope, workerProfile: ticket.workerProfile, limits: ticket.limits, knowledgeBudget }, null, 2)}`,
    `IMMUTABLE SELECTED SKILLS:\n${skillSnapshotsText(selected) || 'No skills selected.'}`,
    `Each task must include assignment, executionProfile (exactly ${ticket.workerProfile.provider}/${ticket.workerProfile.model}/${ticket.workerProfile.effort}), knowledgeScope, and skillIds. Use only paths covered by the ticket scopes. A single complete task is valid when splitting does not help.`,
    'Include knowledgeOperations in the response: the actual number of knowledge-service operations used in this run, or 0 if none. This is actor-reported accounting, not a tool-enforced quota.',
  ].join('\n\n');
}

export function forgeWorkerPrompt(options: {
  ticket: ForgeTicket;
  workspaceName: string;
  workItemId: string;
  attemptId: string;
  workerId: string;
  assignment: Assignment;
  skillSnapshots: ForgeSkillSnapshot[];
  knowledgeSkill?: ForgeSkillSnapshot;
  knowledgeScope: string[];
  knowledgeBudget: unknown;
  dependencyReceipts: Array<{ taskId: string; attemptId: string; commitSha: string; receipt: Receipt }>;
}): string {
  const { ticket, workspaceName, workItemId, attemptId, workerId } = options;
  const selected = withKnowledgeSkill(options.skillSnapshots, options.knowledgeSkill);
  return [
    'Execute this complete Forge assignment in one normal worker turn. Gather relevant project context during this turn when the assignment requires it; there are no separate context stages. Make changes only in the validated worktree and within the accepted write scope. Return one structured worker outcome. A complete receipt is provisional until the host observes and validates the commit.',
    forgeIdentityBlock({ ticket, workspaceName, role: 'worker', taskId: workItemId, attemptId, workerId, knowledgeScope: options.knowledgeScope, knowledgeBudget: options.knowledgeBudget }),
    `ASSIGNMENT:\n${JSON.stringify(options.assignment, null, 2)}`,
    `SELECTED SKILLS (immutable snapshots):\n${skillSnapshotsText(selected) || 'No skills selected.'}`,
    `VERIFIED PREREQUISITE RESULTS:\n${JSON.stringify(options.dependencyReceipts, null, 2)}`,
    'Return exactly the worker outcome schema. Do not claim AgentMem or other knowledge was consulted unless a real tool result supports the claim. If required knowledge is unavailable or mismatched, return a blocked receipt with the exact missing capability. If optional knowledge is unavailable, continue and state the limit honestly.',
    'Include knowledgeOperations: the actual number of knowledge-service operations used in this run, or 0 if none. This is actor-reported accounting, not a tool-enforced quota.',
  ].join('\n\n');
}

export const forgeIntegratorOutputSchema = z.object({
  type: z.literal('integration'),
  knowledgeOperations,
  receipt: receiptSchema,
  workerReceipts: z.array(z.object({ taskId: id, attemptId: id, receiptId: id, receipt: receiptSchema }).strict()).min(1).max(16),
  scopeValidation: z.object({ status: z.enum(['passed', 'failed']), evidence: z.array(text).min(1).max(40) }).strict(),
  verification: z.array(z.object({ check: text, result: z.enum(['passed', 'failed', 'not_run']), evidence: z.string().max(4000).optional() }).strict()).min(1).max(40),
  findings: z.array(forgeIntegrationFindingSchema).max(40),
  corrections: z.array(z.object({ taskId: id, findingIds: z.array(id).min(1).max(40), assignment: assignmentSchema, knowledgeScope: z.array(text.max(1024)).max(80), skillIds: z.array(id).max(12) }).strict()).max(16),
}).strict();

export type ForgeIntegratorOutput = z.infer<typeof forgeIntegratorOutputSchema>;

export const forgeIntegratorOutputJsonSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'knowledgeOperations', 'receipt', 'workerReceipts', 'scopeValidation', 'verification', 'findings', 'corrections'],
  properties: {
    type: { type: 'string', enum: ['integration'] },
    knowledgeOperations: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    receipt: receiptJsonSchema,
    workerReceipts: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['taskId', 'attemptId', 'receiptId', 'receipt'], properties: { taskId: { type: 'string' }, attemptId: { type: 'string' }, receiptId: { type: 'string' }, receipt: receiptJsonSchema } } },
    scopeValidation: { type: 'object', additionalProperties: false, required: ['status', 'evidence'], properties: { status: { type: 'string', enum: ['passed', 'failed'] }, evidence: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 12000 } } } },
    verification: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['check', 'result', 'evidence'], properties: { check: { type: 'string' }, result: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, evidence: { type: ['string', 'null'], maxLength: 4000 } } } },
    findings: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'issue', 'requiredFix', 'evidence'], properties: { id: { type: 'string' }, taskId: { type: ['string', 'null'] }, title: { type: 'string' }, issue: { type: 'string' }, requiredFix: { type: 'string' }, evidence: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } } } } },
    corrections: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['taskId', 'findingIds', 'assignment', 'knowledgeScope', 'skillIds'], properties: { taskId: { type: 'string' }, findingIds: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string' } }, assignment: assignmentJsonSchema, knowledgeScope: { type: 'array', maxItems: 80, items: { type: 'string' } }, skillIds: { type: 'array', maxItems: 12, items: { type: 'string' } } } } },
  },
} as const;

const correctionSchema = z.object({
  taskId: id,
  findings: z.array(forgeIntegrationFindingSchema.omit({ taskId: true })).min(1).max(40),
  assignment: assignmentSchema,
  knowledgeScope: z.array(text.max(1024)).max(80),
  skillIds: z.array(id).max(12),
}).strict();

export const forgeReviewOutputSchema = z.object({
  type: z.literal('review'),
  knowledgeOperations,
  candidateSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetMainSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  disposition: z.enum(['accept', 'request_corrections', 'block']),
  note: z.string().max(4000),
  corrections: z.array(correctionSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if (value.disposition === 'request_corrections' && !value.corrections.length) ctx.addIssue({ code: 'custom', path: ['corrections'], message: 'A correction decision requires complete affected-task assignments.' });
  if (value.disposition !== 'request_corrections' && value.corrections.length) ctx.addIssue({ code: 'custom', path: ['corrections'], message: 'Only a correction decision may include correction assignments.' });
});

export type ForgeReviewOutput = z.infer<typeof forgeReviewOutputSchema>;

export const forgeReviewOutputJsonSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'knowledgeOperations', 'candidateSha', 'targetMainSha', 'disposition', 'note', 'corrections'],
  properties: {
    type: { type: 'string', enum: ['review'] }, candidateSha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, targetMainSha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
    knowledgeOperations: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    disposition: { type: 'string', enum: ['accept', 'request_corrections', 'block'] }, note: { type: 'string', maxLength: 4000 },
    corrections: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['taskId', 'findings', 'assignment', 'knowledgeScope', 'skillIds'], properties: {
      taskId: { type: 'string' },
      findings: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'issue', 'requiredFix', 'evidence'], properties: { id: { type: 'string' }, title: { type: 'string' }, issue: { type: 'string' }, requiredFix: { type: 'string' }, evidence: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } } } } },
      assignment: assignmentJsonSchema, knowledgeScope: { type: 'array', maxItems: 80, items: { type: 'string' } }, skillIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
    } } },
  },
} as const;

export const forgeWorkerOutcomeSchema = workerOutcomeSchema.extend({ knowledgeOperations }).strict();
export const forgeWorkerOutcomeJsonSchema = {
  ...workerOutcomeJsonSchema,
  required: [...workerOutcomeJsonSchema.required, 'knowledgeOperations'],
  properties: { ...workerOutcomeJsonSchema.properties, knowledgeOperations: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

export function parseForgeWorkerOutcome(raw: string) {
  return forgeWorkerOutcomeSchema.parse(parseForgeStructuredOutput(raw));
}

export function parseForgeIntegratorOutput(raw: string, saved: Array<{ taskId: string; attemptId: string; receiptId: string; receipt: Receipt }>): ForgeIntegratorOutput {
  const result = forgeIntegratorOutputSchema.parse(parseForgeStructuredOutput(raw));
  const expected = new Map(saved.map((row) => [row.taskId, row]));
  if (result.workerReceipts.length !== expected.size || new Set(result.workerReceipts.map((row) => row.taskId)).size !== expected.size) {
    throw new Error('The integrator receipt must preserve one exact saved receipt for every finished Forge task.');
  }
  for (const receipt of result.workerReceipts) {
    const commit = expected.get(receipt.taskId);
    if (!commit || commit.attemptId !== receipt.attemptId || commit.receiptId !== receipt.receiptId || JSON.stringify(commit.receipt) !== JSON.stringify(receipt.receipt)) {
      throw new Error(`The integrator receipt did not preserve the exact saved receipt and pinned worker attempt for ${receipt.taskId}.`);
    }
  }
  if (result.findings.some((finding) => !finding.taskId || !expected.has(finding.taskId))) throw new Error('Every integration finding must identify an affected finished Forge task.');
  const findingsByTask = new Map<string, Set<string>>();
  for (const finding of result.findings) {
    if (!finding.taskId) throw new Error('Every integration finding must identify an affected finished Forge task.');
    const ids = findingsByTask.get(finding.taskId) || new Set<string>(); ids.add(finding.id); findingsByTask.set(finding.taskId, ids);
  }
  const correctionsByTask = new Map(result.corrections.map((row) => [row.taskId, row]));
  if (correctionsByTask.size !== result.corrections.length || (result.findings.length === 0) !== (result.corrections.length === 0)) throw new Error('Integrator corrections must be complete for all findings and absent when the candidate has no findings.');
  const assigned = result.corrections.flatMap((row) => {
    const ids = findingsByTask.get(row.taskId);
    if (!ids || new Set(row.findingIds).size !== row.findingIds.length || row.findingIds.length !== ids.size || row.findingIds.some((id) => !ids.has(id))) throw new Error(`Integrator correction for ${row.taskId} must assign every finding on that task.`);
    return row.findingIds;
  });
  if (new Set(assigned).size !== assigned.length || assigned.length !== result.findings.length) throw new Error('Every integration finding must be assigned exactly once to a complete correction.');
  return result;
}

export function parseForgeReviewOutput(raw: string, candidateSha: string, targetMainSha: string, ticket: ForgeTicket): ForgeReviewOutput {
  const output = forgeReviewOutputSchema.parse(parseForgeStructuredOutput(raw));
  if (output.candidateSha.toLowerCase() !== candidateSha.toLowerCase() || output.targetMainSha.toLowerCase() !== targetMainSha.toLowerCase()) {
    throw new Error('The orchestrator review is bound to a different Forge candidate or target-main revision.');
  }
  const known = new Set(ticket.workitems.map((task) => task.id));
  const selectedSkills = new Map(ticket.acceptedPlan?.tasks.flatMap((task) => task.assignment.skillSnapshots).map((skill) => [skill.id, skill]) || []);
  for (const correction of output.corrections) {
    if (!known.has(correction.taskId)) throw new Error(`The orchestrator requested correction for an unknown Forge task: ${correction.taskId}.`);
    if (new Set(correction.skillIds).size !== correction.skillIds.length) throw new Error(`Correction for ${correction.taskId} selected a skill more than once.`);
    for (const skillId of correction.skillIds) if (!selectedSkills.has(skillId)) throw new Error(`Correction for ${correction.taskId} selected an unpinned skill revision: ${skillId}.`);
  }
  return output;
}

export function forgeReviewCommandCorrections(output: ForgeReviewOutput, ticket: ForgeTicket) {
  const selectedSkills = new Map(ticket.acceptedPlan?.tasks.flatMap((task) => task.assignment.skillSnapshots).map((skill) => [skill.id, skill]) || []);
  return output.corrections.map((item) => ({
    taskId: item.taskId,
    findings: item.findings.map((finding) => ({ ...finding, taskId: item.taskId })),
    assignment: {
      assignment: normalizeForgeAssignmentPaths(item.assignment, ticket.workspaceRoot),
      executionProfile: structuredClone(ticket.workerProfile),
      knowledgeScope: item.knowledgeScope,
      skillSnapshots: item.skillIds.map((id) => structuredClone(selectedSkills.get(id)!)),
    },
  }));
}

export function forgeIntegratorPrompt(options: {
  ticket: ForgeTicket;
  workspaceName: string;
  runId: string;
  workerReceipts: Array<{ taskId: string; attemptId: string; receiptId: string; commitSha: string; receipt: Receipt }>;
  candidateSha: string;
  targetMainSha: string;
  skillSnapshots: ForgeSkillSnapshot[];
  knowledgeSkill?: ForgeSkillSnapshot;
  knowledgeBudget: unknown;
  knowledgeScope?: string[];
}): string {
  return [
    'Review the exact composed candidate in this isolated integration worktree. Run the actual checks required by the assignments and ticket acceptance criteria. Do not change candidate files, create a synthetic check, claim an unobserved result, merge main, or publish remotely. Return one integration result with the complete combined receipt, actual check evidence, scope result, findings, and every original worker receipt copied exactly. Any finding must name a concrete affected task. The app binds this result to the observed candidate and target-main SHAs.',
    forgeIdentityBlock({ ticket: options.ticket, workspaceName: options.workspaceName, role: 'integrator', taskId: options.runId, attemptId: options.runId, workerId: options.runId, knowledgeScope: options.knowledgeScope || options.ticket.scope.knowledge, knowledgeBudget: options.knowledgeBudget }),
    `PINNED CANDIDATE:\n${JSON.stringify({ candidateSha: options.candidateSha, targetMainSha: options.targetMainSha, workerReceipts: options.workerReceipts }, null, 2)}`,
    `TICKET ACCEPTANCE:\n${JSON.stringify({ acceptanceCriteria: options.ticket.acceptanceCriteria, scope: options.ticket.scope }, null, 2)}`,
    `SELECTED SKILLS (immutable snapshots):\n${skillSnapshotsText(withKnowledgeSkill(options.skillSnapshots, options.knowledgeSkill)) || 'No skills selected.'}`,
    'For the combined receipt, preserve all original worker receipts as exact objects in workerReceipts. Report actual candidate checks and any unresolved gaps. The application verifies the receipt set against its saved records before accepting it.',
    'Include knowledgeOperations: the actual number of knowledge-service operations used in this run, or 0 if none. This is actor-reported accounting, not a tool-enforced quota.',
  ].join('\n\n');
}

export function forgeReviewPrompt(options: {
  ticket: ForgeTicket;
  workspaceName: string;
  runId: string;
  candidateSha: string;
  targetMainSha: string;
  diff: string;
  combinedReceipt: Receipt;
  skillSnapshots: ForgeSkillSnapshot[];
  knowledgeSkill?: ForgeSkillSnapshot;
  knowledgeBudget: unknown;
  knowledgeScope?: string[];
}): string {
  return [
    'Independently review the saved integrator receipt and actual diff for the exact candidate and target-main SHA below. Return one typed accept, request_corrections, or block decision. Bind both SHAs exactly. Accept only if the combined receipt is complete, original receipts are preserved, actual checks passed, scope is valid, and the diff meets the ticket criteria. A correction must identify every affected task with a complete scoped assignment, findings, pinned skill IDs, and knowledge scope. Do not merge main or claim tests that are not shown in actual evidence.',
    forgeIdentityBlock({ ticket: options.ticket, workspaceName: options.workspaceName, role: 'orchestrator', taskId: options.runId, attemptId: options.runId, workerId: options.runId, knowledgeScope: options.knowledgeScope || options.ticket.scope.knowledge, knowledgeBudget: options.knowledgeBudget }),
    `CANDIDATE IDENTITY:\n${JSON.stringify({ candidateSha: options.candidateSha, targetMainSha: options.targetMainSha })}`,
    `INTEGRATOR RECEIPT:\n${JSON.stringify(options.combinedReceipt, null, 2)}`,
    `ACTUAL DIFF (truncated to 300,000 characters):\n${options.diff.slice(0, 300000)}`,
    `SELECTED SKILLS (immutable snapshots):\n${skillSnapshotsText(withKnowledgeSkill(options.skillSnapshots, options.knowledgeSkill)) || 'No skills selected.'}`,
    'Include knowledgeOperations: the actual number of knowledge-service operations used in this run, or 0 if none. This is actor-reported accounting, not a tool-enforced quota.',
    'For corrections, use only skill IDs and exact revisions already accepted in the plan. The app validates the candidate identity and every correction assignment before accepting the decision.',
  ].join('\n\n');
}

export function skillSnapshotsText(skills: ForgeSkillSnapshot[]) {
  return skills.map((skill) => `### ${skill.name}\nImmutable skill ID: ${skill.id}\nSource: ${skill.source}\nRevision: ${skill.revision}\nDescription: ${skill.description || '(none)'}\n\n${skill.instructions}`).join('\n\n');
}

function withKnowledgeSkill(skills: ForgeSkillSnapshot[], knowledgeSkill?: ForgeSkillSnapshot) {
  if (!knowledgeSkill || skills.some((skill) => skill.id === knowledgeSkill.id && skill.revision === knowledgeSkill.revision)) return skills;
  return [...skills, knowledgeSkill];
}

function forgeIdentityBlock(options: {
  ticket: ForgeTicket;
  workspaceName: string;
  role: 'orchestrator' | 'worker' | 'integrator';
  taskId: string;
  attemptId: string;
  workerId: string;
  knowledgeScope: string[];
  knowledgeBudget: unknown;
}) {
  const { ticket } = options;
  return `FORGE IDENTITY AND KNOWLEDGE HANDOFF:\n${JSON.stringify({
    workspaceDisplayName: options.workspaceName,
    canonicalWorkspaceRoot: ticket.workspaceRoot,
    executionRoot: '<the isolated worktree configured for this run>',
    taskId: options.taskId,
    attemptId: options.attemptId,
    actorId: options.workerId,
    role: options.role,
    knowledgeScope: options.knowledgeScope,
    knowledgeBudget: options.knowledgeBudget,
    limits: ticket.limits,
    knowledgeCapability: ticket.capabilities.knowledgeScope,
  }, null, 2)}\nThe execution worktree is not a knowledge base. Use only the exact canonical workspace identity and assigned knowledge scope. The AgentMem skill explains how to resolve and verify its external registration by exact canonical source root. Supplying that skill does not prove the service or a successful lookup exists. Written allocations are instruction-only unless an external restricted service proves enforcement.`;
}

void forgePlanTaskInputSchema;
