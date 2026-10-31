import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assignmentWriteRoots } from './policy.js';
import { forgeTicketInputSchema, type Assignment, type Receipt } from './contracts.js';
import { applyForgeCommandInState, clearForgeApprovalAfterProviderCancellationInState, createForgeSessionInState, recordForgeApprovalRequestInState, recordForgeToolCallInState, resolveForgeApprovalRequestInState, type ForgeApprovalContext, type ForgeApprovalRequest, type State } from './state.js';
import type { ToolCallEvent } from './tool-call-log.js';
import { executionProfileForSettings } from './state.js';
import { getSkill } from './skill-library.js';
import { loadForgeKnowledgeSkill } from './forge-knowledge-skill.js';
import { createForgeIntegrationCandidate, finalizeForgeMerge, prepareForgeWorktrees, prepareForgeWorkerDependencies, validateForgeWorkerCommit, type ForgeCandidateEvidence, type ForgeWorkerCommitInput, type PreparedForgeWorktrees } from './forge-git.js';
import { forgeAttemptRoot, forgeAttemptWorkerId, forgeBranchName, restoreForgeIntegrationWorktrees, restoreForgeWorkerWorktrees, resolveLocalForgeTargetBranch } from './forge-git-context.js';
import { mergeForgeSkillSnapshots, type ForgeActor, type ForgeApprovalPolicy, type ForgeAttempt, type ForgeSkillSnapshot, type ForgeTicket, type ForgeWorkitem } from './forge-contracts.js';
import { forgeKnowledgeBudgetBalance } from './forge-state.js';
import { forgeIntegratorOutputJsonSchema, forgePlanOutputJsonSchema, forgeReviewOutputJsonSchema, forgeWorkerOutcomeJsonSchema, forgeReviewOutputSchema, normalizeForgeAssignmentPaths, parseForgeIntegratorOutput, parseForgePlanResult, parseForgeReviewOutput, parseForgeWorkerOutcome, forgeIntegratorPrompt, forgePlanPrompt, forgeReviewPrompt, forgeWorkerPrompt } from './forge-prompts.js';
import { ForgeProviderStartError, type ForgeProviderApprovalDecision, type ForgeProviderApprovalRequest, type ForgeProviderCancelResult, type ForgeProviderEvent, type ForgeProviderHandle, type ForgeProviderOutcome, type ForgeProviderRequest, type ForgeProviderRole, type ForgeProviderStartEvidence } from './forge-provider.js';
import { cancelForgeRole, respondForgeRoleApproval, startForgeRole } from './orchestrator.js';
import { resolveDeepSeekHarnessPermission } from './deepseek-harness.js';
import { forgeGitWritableRoots, validateRecruitmentRoot } from './recruitment-git.js';
import { stateDirectory } from './paths.js';
import type { ForgeCommand, ForgeHostAttestation, ForgeKnowledgeAllocation, ForgeReceiptProvenance } from './forge-contracts.js';

const execFileAsync = promisify(execFile);
const HOST: ForgeActor = { role: 'host', id: 'forge-runtime' };
const MAX_GIT_DIFF = 300_000;
const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearchCall', 'dynamicToolCall', 'collabAgentToolCall']);

export type ForgeRoleLauncher = (
  request: ForgeProviderRequest,
  onStarted?: (evidence: ForgeProviderStartEvidence) => void | Promise<void>,
  onEvent?: (event: ForgeProviderEvent) => void | Promise<void>,
  onApproval?: (request: ForgeProviderApprovalRequest) => void | Promise<void>,
) => Promise<ForgeProviderHandle>;

type ForgeActorBinding = {
  ticketId: string;
  role: ForgeProviderRole;
  targetType: ForgeApprovalContext['targetType'];
  targetId: string;
  ownerId: string;
  claimToken?: string;
  model: string;
  effort: ForgeTicket['workerProfile']['effort'];
  executionRoot: string;
  canonicalRoot: string;
  writeRoots: string[];
  prompt: string;
  outputSchema: unknown;
  approvalPolicy: ForgeApprovalPolicy;
  handle?: ForgeProviderHandle;
  observedTools: Array<{ command: string; exitCode?: number; status: string }>;
};

export type ForgeCoordinatorOptions = {
  getState: () => State;
  mutate: (fn: (state: State) => void) => Promise<unknown>;
  startRole?: ForgeRoleLauncher;
  cancelRole?: (handle: ForgeProviderHandle) => Promise<ForgeProviderCancelResult>;
  respondApproval?: (decision: ForgeProviderApprovalDecision) => boolean;
  stateRoot?: string;
  now?: () => string;
};

/** Event-driven Forge host: durable claims and run snapshots precede every external effect. */
export class ForgeCoordinator {
  private readonly actors = new Map<string, ForgeActorBinding>();
  private readonly pumpLocks = new Set<string>();
  private readonly stageLocks = new Set<string>();
  private readonly startRole: ForgeRoleLauncher;
  private readonly cancelRole: (handle: ForgeProviderHandle) => Promise<ForgeProviderCancelResult>;
  private readonly respondApproval: (decision: ForgeProviderApprovalDecision) => boolean;
  private readonly stateRoot: string;
  private readonly now: () => string;

  constructor(private readonly options: ForgeCoordinatorOptions) {
    this.startRole = options.startRole || startForgeRole;
    this.cancelRole = options.cancelRole || cancelForgeRole;
    this.respondApproval = options.respondApproval || respondForgeRoleApproval;
    this.stateRoot = options.stateRoot || stateDirectory();
    this.now = options.now || (() => new Date().toISOString());
  }

  getTicket(ticketId: string): ForgeTicket | undefined {
    const task = this.options.getState().tasks.find((row) => row.id === ticketId && row.sessionType === 'forge');
    return task?.forge ? structuredClone(task.forge) : undefined;
  }

  async create(body: unknown) {
    const parsed = forgeTicketInputSchema.parse(body);
    const state = this.options.getState();
    const project = state.projects.find((row) => row.id === parsed.projectId);
    if (!project || project.needsLocation) throw new Error('Choose an existing workspace with a current working directory before creating a Forge ticket.');
    const selected: ForgeSkillSnapshot[] = [];
    for (const skillId of parsed.skillIds) {
      const skill = await getSkill(skillId);
      selected.push({ id: skill.id, revision: skill.revision, name: skill.name, description: skill.description, source: skill.source, instructions: skill.instructions, files: skill.files.map((file) => ({ path: file.path, size: file.size })) });
    }
    const knowledgeSkill = await loadForgeKnowledgeSkill({ appRoot: appRoot() });
    const orchestratorSkills = mergeForgeSkillSnapshots(selected, [knowledgeSkill]);
    const selectedTargetBranch = (body as { targetBranch?: string }).targetBranch;
    const targetBranch = selectedTargetBranch || await resolveLocalForgeTargetBranch(project.projectRoot);
    await validateRecruitmentRoot(project.projectRoot, targetBranch);
    let createdId = '';
    await this.options.mutate((current) => {
      const currentProject = current.projects.find((row) => row.id === parsed.projectId);
      if (!currentProject || currentProject.needsLocation) throw new Error('Choose an existing workspace with a current working directory before creating a Forge ticket.');
      const workerProfile = executionProfileForSettings(current.settings);
      const capabilities = {
        filesystemWriteScope: workerProfile.provider === 'codex' ? 'enforced' as const : 'unavailable' as const,
        knowledgeScope: 'instruction-only' as const,
        operationBudget: 'instruction-only' as const,
        toolAuthorization: 'monitored' as const,
        cancellation: 'monitored' as const,
        commitScopeValidation: 'enforced' as const,
        finalMergeGate: 'enforced' as const,
      };
      const created = createForgeSessionInState(current, {
        projectId: parsed.projectId,
        title: parsed.title,
        description: parsed.description,
        acceptanceCriteria: parsed.acceptanceCriteria,
        scope: normalizeTicketScope(parsed.scope, currentProject.projectRoot),
        orchestrator: parsed.orchestrator,
        workerProfile,
        targetBranch,
        orchestratorSkills,
        limits: parsed.limits,
        knowledgeBudget: parsed.knowledgeBudget,
        capabilities,
      });
      createdId = created.id;
    });
    return this.getTicket(createdId)!;
  }

  async start(ticketId: string, planRevision?: number) {
    const ticket = this.requireTicket(ticketId);
    if (planRevision === undefined) {
      if (ticket.phase === 'draft') await this.startPlanning(ticket);
      else if (ticket.phase === 'planned') throw new Error(`Accept plan revision ${ticket.proposedPlan?.revision} explicitly before Forge can dispatch workers.`);
      else if (ticket.phase === 'running') await this.pump(ticketId);
      else throw new Error(`Forge ticket cannot start from phase ${ticket.phase}.`);
      return this.requireTicket(ticketId);
    }
    if (ticket.proposedPlan?.revision !== planRevision) throw new Error('The submitted Forge plan revision is stale. Refresh the ticket and accept the current proposal.');
    await this.command(ticketId, { type: 'accept_plan', actor: { role: 'user', id: 'forge-user' }, revision: planRevision });
    await this.command(ticketId, { type: 'start', actor: { role: 'user', id: 'forge-user' } });
    await this.pump(ticketId);
    return this.requireTicket(ticketId);
  }

  async pause(ticketId: string) { return this.stop(ticketId, 'pause'); }
  async cancel(ticketId: string) { return this.stop(ticketId, 'cancel'); }

  async resume(ticketId: string) {
    const ticket = this.requireTicket(ticketId);
    await this.command(ticketId, { type: 'resume', actor: { role: 'user', id: 'forge-user' } });
    const resumed = this.requireTicket(ticketId);
    if (resumed.activeOrchestratorRunId && !this.actorFor(resumed, 'orchestrator', resumed.activeOrchestratorRunId)) {
      await this.command(ticketId, { type: 'recover_after_restart', actor: HOST });
      throw new Error('A Forge orchestrator run has no live runtime owner. It was preserved as unknown and must be reconciled before retrying.');
    }
    if (resumed.integration.activeRunId && !this.actorFor(resumed, 'integrator', resumed.integration.activeRunId)) {
      await this.command(ticketId, { type: 'recover_after_restart', actor: HOST });
      throw new Error('A Forge integrator run has no live runtime owner. It was preserved as unknown and must be reconciled before retrying.');
    }
    if (resumed.phase === 'draft') await this.startPlanning(resumed);
    else await this.pump(ticketId);
    return this.requireTicket(ticketId);
  }

  async approve(ticketId: string, requestId: string | number, body: unknown) {
    const input = approvalInput.parse(body);
    const task = this.options.getState().tasks.find((row) => row.id === ticketId && row.sessionType === 'forge' && row.forge);
    if (!task?.forge) throw new Error('Forge session not found.');
    if (!['planning', 'review', 'running', 'integrating'].includes(task.forge.phase)) throw new Error(`Forge approvals cannot be answered while the ticket is ${task.forge.phase}. The saved request remains unresolved for recovery.`);
    const saved = (task.approvalRequests || []).find((request) => request.requestId === requestId && request.forgeContext?.ticketId === ticketId) as ForgeApprovalRequest | undefined;
    if (!saved?.forgeContext) throw new Error('The Forge approval is stale, already answered, or belongs to a different ticket.');
    const binding = this.actorFor(task.forge, roleForTarget(saved.forgeContext.targetType), saved.forgeContext.targetId);
    if (!binding?.handle || binding.handle.threadId !== saved.threadId || binding.handle.turnId !== saved.turnId) throw new Error('The original Forge provider request is not live in this runtime. The saved approval remains unresolved; no permission was granted.');
    if (saved.method === 'item/permissions/requestApproval' && input.decision === 'accept') throw new Error('This provider requested a permission profile whose subset cannot be proven against this Forge claim. Decline it; the assignment or runtime boundary needs a scoped correction.');
    const request = providerApprovalFromSaved(saved, binding);
    const decision: ForgeProviderApprovalDecision = { request, decision: input.decision, ...(input.content ? { content: input.content } : {}) };
    if (!this.respondApproval(decision)) throw new Error('The Forge runtime rejected this stale approval response. No permission was granted.');
    const context = { ...saved.forgeContext, threadId: saved.threadId, turnId: saved.turnId };
    await this.options.mutate((state) => { resolveForgeApprovalRequestInState(state, ticketId, requestId, context); });
    return this.requireTicket(ticketId);
  }

  private async stop(ticketId: string, action: 'pause' | 'cancel') {
    await this.command(ticketId, { type: action, actor: { role: 'user', id: 'forge-user' } });
    const bindings = [...this.actors.values()].filter((actor) => actor.ticketId === ticketId);
    for (const binding of bindings) {
      if (!binding.handle) continue;
      let result: ForgeProviderCancelResult;
      try { result = await this.cancelRole(binding.handle); }
      catch { result = { status: 'uncertain' }; }
      if (result.status === 'uncertain') {
        await this.markUncertain(binding, 'The host requested cancellation but the provider did not confirm that the original turn stopped. Its claim, worktree, and budget allocation remain reserved.');
      } else if (result.status === 'completed' && result.outcome) {
        await this.finishActor(binding, result.outcome);
      } else {
        await this.recordActorStopped(binding, `The provider confirmed the turn stopped after the user requested ${action}.`);
      }
      if (result.status !== 'uncertain') await this.clearConfirmedActorApprovals(binding, result.status, `The provider confirmed the ${result.status} outcome after ${action}; the approval belongs to this exact provider turn.`);
      this.actors.delete(actorKey(binding.ticketId, binding.targetType, binding.targetId));
    }
    return this.requireTicket(ticketId);
  }

  private async startPlanning(ticket: ForgeTicket) {
    const knowledgeSkill = await this.loadKnowledgeSkill(ticket);
    const branch = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch);
    const runId = randomUUID();
    const ownerId = `orchestrator-${runId}`;
    const skillSnapshots = mergeForgeSkillSnapshots(ticket.orchestratorSkills, [knowledgeSkill]);
    const runInput = {
      id: runId, ownerId, purpose: 'planning' as const, projectId: ticket.projectId, workspaceRoot: ticket.workspaceRoot,
      requestedProfile: { provider: 'codex' as const, model: ticket.orchestrator.model, effort: ticket.orchestrator.effort },
      scopes: { read: [...ticket.scope.read, ...ticket.scope.write], write: [], knowledge: [...ticket.scope.knowledge] },
      skillSnapshots, expectedPlanRevision: ticket.planRevision + 1, sourceBaselineSha: branch.baseCommit,
      knowledgeAllocation: ticket.knowledgeBudget.defaultAllocationOperations,
    };
    await this.command(ticket.id, { type: 'begin_orchestrator_run', actor: HOST, run: runInput });
    const updated = this.requireTicket(ticket.id);
    const run = updated.orchestratorRuns.find((row) => row.id === runId)!;
    const workspaceName = path.basename(ticket.workspaceRoot.replace(/[\\/]+$/, ''));
    const prompt = forgePlanPrompt(updated, workspaceName, knowledgeSkill, knowledgeAllocationSummary(updated, run.knowledgeAllocation));
    const binding: ForgeActorBinding = {
      ticketId: ticket.id, role: 'orchestrator', targetType: 'planning', targetId: runId, ownerId, model: ticket.orchestrator.model, effort: ticket.orchestrator.effort,
      executionRoot: ticket.workspaceRoot, canonicalRoot: ticket.workspaceRoot, writeRoots: [], prompt, outputSchema: forgePlanOutputJsonSchema,
      approvalPolicy: ticket.approvalPolicy, observedTools: [],
    };
    await this.launch(binding, run.knowledgeAllocation?.operations);
  }

  private async pump(ticketId: string): Promise<void> {
    if (this.pumpLocks.has(ticketId)) return;
    this.pumpLocks.add(ticketId);
    try {
      while (true) {
        const ticket = this.requireTicket(ticketId);
        if (ticket.phase !== 'running') break;
        const active = ticket.attempts.filter((attempt) => ['claimed', 'unknown_after_restart', 'unknown_effect'].includes(attempt.status)).length;
        if (active >= ticket.limits.maxActiveWorkers) break;
        const ready = ticket.workitems.find((task) => task.state === 'open' && task.dependencyIds.every((id) => ticket.workitems.find((row) => row.id === id)?.state === 'finished'));
        if (!ready) break;
        await this.dispatchWorker(ticket, ready);
      }
      const current = this.requireTicket(ticketId);
      if (current.phase === 'integrating' && current.integration.status === 'not_started' && !current.integration.activeRunId) await this.dispatchIntegration(current);
      else if (current.phase === 'review' && current.integration.status === 'ready_for_review' && !current.activeOrchestratorRunId) await this.dispatchFinalReview(current);
    } finally {
      this.pumpLocks.delete(ticketId);
      queueMicrotask(() => {
        const current = this.getTicket(ticketId);
        if (!current) return;
        if (current.phase === 'running' && current.workitems.some((task) => task.state === 'open' && task.dependencyIds.every((id) => current.workitems.find((row) => row.id === id)?.state === 'finished'))
          && current.attempts.filter((attempt) => ['claimed', 'unknown_after_restart', 'unknown_effect'].includes(attempt.status)).length < current.limits.maxActiveWorkers) void this.pump(ticketId);
      });
    }
  }

  private async dispatchWorker(ticket: ForgeTicket, item: ForgeWorkitem) {
    const planItem = (ticket.acceptedPlan?.tasks || []).find((row) => row.id === item.id);
    if (!planItem) throw new Error(`Accepted Forge work item ${item.id} has no saved assignment.`);
    const assignmentSnapshot = item.correctionAssignments.at(-1) || planItem.assignment;
    const profile = assignmentSnapshot.executionProfile;
    const planningRun = ticket.orchestratorRuns.find((run) => run.purpose === 'planning' && run.resultPlanId === ticket.acceptedPlan?.id);
    const planningBaseline = planningRun?.purpose === 'planning' ? planningRun.sourceBaselineSha : undefined;
    if (!planningBaseline) throw new Error('The accepted Forge plan is missing its original saved source baseline; worker dispatch is blocked.');
    const attemptId = randomUUID();
    const ownerId = forgeAttemptWorkerId(attemptId);
    const claimId = randomUUID();
    const claimToken = randomBytes(32).toString('base64url');
    const branch = forgeBranchName(ticket.id, attemptId, 'worker', ownerId);
    const taskRoot = forgeAttemptRoot(this.stateRoot, ticket.id, attemptId);
    const worktreeRoot = path.join(taskRoot, `worker-${ownerId}`);
    const runtimeId = `forge:${ticket.id}:${attemptId}`;
    await this.command(ticket.id, { type: 'claim_task', actor: HOST, taskId: item.id, ownerId, claimId, attemptId, claimToken, runtimeId, branch, worktreeRoot, sourceBaselineSha: planningBaseline, knowledgeAllocation: ticket.knowledgeBudget.defaultAllocationOperations });
    const claimed = this.requireTicket(ticket.id).attempts.find((row) => row.id === attemptId)!;
    const actor = actorForAttempt(ticket.id, claimed);
    actor.canonicalRoot = ticket.workspaceRoot;
    actor.approvalPolicy = ticket.approvalPolicy;
    let preflightStage: 'workspace_prepare' | 'dependency_merge' = 'workspace_prepare';
    let prepared: PreparedForgeWorktrees;
    try {
      await mkdir(path.dirname(taskRoot), { recursive: true });
      prepared = await prepareForgeWorktrees({ canonicalRoot: ticket.workspaceRoot, taskRoot, baseRef: planningBaseline, ticketId: ticket.id, attemptId, workerIds: [ownerId] });
      if (profile.provider === 'deepseek') {
        try { resolveDeepSeekHarnessPermission({ approvalPolicy: ticket.approvalPolicy, selectedForTask: true, workspaceRoot: ticket.workspaceRoot, writeScope: assignmentSnapshot.assignment.write_scope, requiresFilesystemConfinement: true }); }
        catch (error) { throw new Error(error instanceof Error ? error.message : 'Forge requires a runtime that enforces this writable scope. DeepSeek Harness reports writable scope as assignment-instruction-only.'); }
        throw new Error('The selected DeepSeek Harness profile has no Forge role adapter in this runtime. No Codex fallback was started. Select a supported Codex worker profile or configure a confinement-capable Forge adapter.');
      }
      const prerequisites = await this.prerequisiteCommits(ticket, item, assignmentSnapshot.assignment);
      preflightStage = 'dependency_merge';
      const dependencyResult = await prepareForgeWorkerDependencies({ prepared, workItemId: item.id, workerId: ownerId, prerequisites });
      if (dependencyResult.status !== 'ready') throw new Error(dependencyResult.status === 'conflict' ? `Dependency merge conflict at ${dependencyResult.conflicts.join(', ')}; preserved in the owned worktree.` : dependencyResult.reason);
      await this.command(ticket.id, { type: 'record_attempt_dispatch_baseline', actor: HOST, taskId: item.id, ownerId, attemptId, claimToken, dispatchBaselineSha: dependencyResult.baselineCommit });
      const knowledgeSkill = await this.loadKnowledgeSkill(ticket);
      const worktreeWriteRoots = mapWriteRoots(assignmentSnapshot.assignment.write_scope, ticket.workspaceRoot, worktreeRoot);
      const gitRoots = await forgeGitWritableRoots({ canonicalRoot: ticket.workspaceRoot, taskRoot, ticketId: ticket.id, attemptId, role: 'worker', workerId: ownerId, worktreeRoot });
      const writeRoots = [...new Set([...worktreeWriteRoots, ...gitRoots.slice(1)])];
      const prompt = forgeWorkerPrompt({
        ticket, workspaceName: path.basename(ticket.workspaceRoot.replace(/[\\/]+$/, '')), workItemId: item.id, attemptId, workerId: ownerId,
        assignment: assignmentForWorktree(assignmentSnapshot.assignment, ticket.workspaceRoot, worktreeRoot), skillSnapshots: assignmentSnapshot.skillSnapshots,
        knowledgeSkill, knowledgeScope: assignmentSnapshot.knowledgeScope, knowledgeBudget: knowledgeAllocationSummary(ticket, claimed.knowledgeAllocation),
        dependencyReceipts: ticket.workitems.filter((row) => item.dependencyIds.includes(row.id)).map((dependency) => savedWorkerReceipt(ticket, dependency.id)),
      });
      actor.executionRoot = worktreeRoot; actor.writeRoots = writeRoots; actor.prompt = prompt; actor.outputSchema = forgeWorkerOutcomeJsonSchema;
      await this.launch(actor, claimed.knowledgeAllocation?.operations);
    } catch (error) {
      const latest = this.requireTicket(ticket.id).attempts.find((row) => row.id === attemptId);
      if (!latest || latest.status !== 'claimed' || latest.threadId || latest.turnId) throw error;
      const reason = error instanceof Error ? error.message : 'Forge worktree preparation failed.';
      await this.command(ticket.id, { type: 'fail_attempt_preflight', actor: HOST, taskId: item.id, ownerId, attemptId, claimToken, stage: preflightStage, failureReason: reason, evidence: [reason] });
      void this.pump(ticket.id);
    }
  }

  private async prerequisiteCommits(ticket: ForgeTicket, item: ForgeWorkitem, _assignment: Assignment): Promise<ForgeWorkerCommitInput[]> {
    return Promise.all(item.dependencyIds.map(async (taskId) => {
      const dependency = ticket.workitems.find((row) => row.id === taskId);
      const attempt = latestFinishedAttempt(ticket, taskId);
      if (!dependency || !attempt?.commitSha || !attempt.dispatchBaselineSha) throw new Error(`Verified prerequisite ${taskId} is missing its accepted commit evidence.`);
      const sourceAssignment = dependency.correctionAssignments.at(-1) || ticket.acceptedPlan!.tasks.find((row) => row.id === taskId)!.assignment;
      return {
        workItemId: taskId, workerId: attempt.claim.ownerId, baselineCommit: attempt.dispatchBaselineSha, reportedCommit: attempt.commitSha,
        writeScope: sourceAssignment.assignment.write_scope, prepared: await restoreForgeWorkerWorktrees(ticket, attempt),
      };
    }));
  }

  private async dispatchIntegration(ticket: ForgeTicket) {
    const lock = `integration:${ticket.id}`;
    if (this.stageLocks.has(lock)) return;
    this.stageLocks.add(lock);
    try {
      const knowledgeSkill = await this.loadKnowledgeSkill(ticket);
      const planningRun = ticket.orchestratorRuns.find((row) => row.purpose === 'planning' && row.resultPlanId === ticket.acceptedPlan?.id);
      const sourceBaselineSha = planningRun?.purpose === 'planning' ? planningRun.sourceBaselineSha : '';
      if (!sourceBaselineSha) throw new Error('The accepted Forge plan is missing its saved source baseline; integration cannot continue.');
      const runId = randomUUID(); const ownerId = `integrator-${runId}`;
      const taskRoot = forgeAttemptRoot(this.stateRoot, ticket.id, runId);
      const worktreeRoot = path.join(taskRoot, 'integration');
      const runInput = {
        id: runId, ownerId, projectId: ticket.projectId, workspaceRoot: ticket.workspaceRoot,
        requestedProfile: ticket.workerProfile, branch: forgeBranchName(ticket.id, runId, 'integration'), targetBranch: ticket.targetBranch,
        worktreeRoot, sourceBaselineSha,
        scopes: { read: [...ticket.scope.read, ...ticket.scope.write], write: [...ticket.scope.write], knowledge: [...ticket.scope.knowledge] },
        skillSnapshots: mergeForgeSkillSnapshots(ticket.orchestratorSkills, [knowledgeSkill]),
        knowledgeAllocation: ticket.knowledgeBudget.defaultAllocationOperations,
        ...(ticket.integration.correctionRounds.at(-1)?.id ? { correctionRoundId: ticket.integration.correctionRounds.at(-1)!.id } : {}),
      };
      await this.command(ticket.id, { type: 'begin_integration', actor: HOST, run: runInput });
      const fresh = this.requireTicket(ticket.id);
      const run = fresh.integration.runs.find((row) => row.id === runId)!;
      let prepared: PreparedForgeWorktrees;
      try {
        await mkdir(path.dirname(taskRoot), { recursive: true });
        prepared = await prepareForgeWorktrees({ canonicalRoot: ticket.workspaceRoot, taskRoot, baseRef: sourceBaselineSha, ticketId: ticket.id, attemptId: runId, workerIds: [`candidate-${runId.replaceAll('-', '').slice(0, 20)}`] });
        const commits = await this.finishedWorkerCommits(fresh);
        const candidateResult = await createForgeIntegrationCandidate({ prepared, targetBranch: ticket.targetBranch, workers: commits });
        if (candidateResult.status !== 'ready') throw new Error(candidateResult.status === 'stale-target' ? `Target ${ticket.targetBranch} moved from ${candidateResult.expectedMainCommit} to ${candidateResult.observedMainCommit} while preparing integration.` : candidateResult.status === 'conflict' ? `Integration preflight found conflicts: ${candidateResult.conflicts.map((row) => row.path).join(', ')}.` : candidateResult.reason);
        if (fresh.workerProfile.provider === 'deepseek') {
          try { resolveDeepSeekHarnessPermission({ approvalPolicy: ticket.approvalPolicy, selectedForTask: true, workspaceRoot: ticket.workspaceRoot, writeScope: [], requiresFilesystemConfinement: false }); }
          catch (error) { throw new Error(error instanceof Error ? error.message : 'The selected DeepSeek Harness profile cannot safely run Forge integration.'); }
          throw new Error('The selected DeepSeek Harness profile has no Forge integration adapter in this runtime. No Codex fallback was started.');
        }
        const gitRoots = await forgeGitWritableRoots({ canonicalRoot: ticket.workspaceRoot, taskRoot, ticketId: ticket.id, attemptId: runId, role: 'integration', worktreeRoot });
        const prompt = forgeIntegratorPrompt({
          ticket: fresh, workspaceName: path.basename(ticket.workspaceRoot.replace(/[\\/]+$/, '')), runId,
          workerReceipts: candidateResult.candidate.workerCommits.map((commit) => savedWorkerReceipt(fresh, commit.workItemId)),
          candidateSha: candidateResult.candidate.candidateCommit, targetMainSha: candidateResult.candidate.targetMainCommit,
          skillSnapshots: run.skillSnapshots, knowledgeSkill, knowledgeBudget: knowledgeAllocationSummary(fresh, run.knowledgeAllocation),
        });
        const actor: ForgeActorBinding = {
          ticketId: ticket.id, role: 'integrator', targetType: 'integration', targetId: runId, ownerId, model: run.requestedProfile.model, effort: run.requestedProfile.effort,
          executionRoot: candidateResult.candidate.candidateRoot, canonicalRoot: ticket.workspaceRoot, writeRoots: gitRoots.slice(1), prompt,
          outputSchema: forgeIntegratorOutputJsonSchema, approvalPolicy: ticket.approvalPolicy, observedTools: [],
        };
        actorCandidateEvidence.set(actorKey(ticket.id, 'integration', runId), { evidence: candidateResult.candidate, prepared, commits });
        await this.launch(actor, run.knowledgeAllocation?.operations);
      } catch (error) {
        const current = this.requireTicket(ticket.id).integration.runs.find((row) => row.id === runId);
        if (!current || current.status !== 'prepared' || current.threadId || current.turnId) throw error;
        await this.command(ticket.id, { type: 'fail_integration_run', actor: HOST, runId, failureReason: error instanceof Error ? error.message : 'Integration preflight failed.' });
      }
    } finally { this.stageLocks.delete(lock); }
  }

  private async finishedWorkerCommits(ticket: ForgeTicket): Promise<ForgeWorkerCommitInput[]> {
    const result: ForgeWorkerCommitInput[] = [];
    for (const item of ticket.workitems) {
      const attempt = latestFinishedAttempt(ticket, item.id);
      if (!attempt?.commitSha || !attempt.dispatchBaselineSha) throw new Error(`Finished Forge task ${item.id} has no pinned verified commit.`);
      const assignment = item.correctionAssignments.at(-1) || ticket.acceptedPlan!.tasks.find((row) => row.id === item.id)!.assignment;
      result.push({ workItemId: item.id, workerId: attempt.claim.ownerId, baselineCommit: attempt.dispatchBaselineSha, reportedCommit: attempt.commitSha,
        writeScope: assignment.assignment.write_scope, prepared: await restoreForgeWorkerWorktrees(ticket, attempt) });
    }
    return result;
  }

  private async dispatchFinalReview(ticket: ForgeTicket) {
    const lock = `review:${ticket.id}`;
    if (this.stageLocks.has(lock)) return;
    this.stageLocks.add(lock);
    try {
      const candidate = ticket.integration.candidates.find((row) => row.id === ticket.integration.activeCandidateId);
      const run = ticket.integration.runs.find((row) => row.id === ticket.integration.activeRunId) || ticket.integration.runs.filter((row) => row.candidateId === candidate?.id).at(-1);
      if (!candidate || !run) throw new Error('Forge final review needs the saved current integration candidate and run.');
      const knowledgeSkill = await this.loadKnowledgeSkill(ticket);
      const reviewRunId = randomUUID(); const ownerId = `reviewer-${reviewRunId}`;
      const reviewInput = {
        id: reviewRunId, ownerId, purpose: 'final_review' as const, projectId: ticket.projectId, workspaceRoot: ticket.workspaceRoot,
        requestedProfile: { provider: 'codex' as const, model: ticket.orchestrator.model, effort: ticket.orchestrator.effort },
        scopes: { read: [...ticket.scope.read, ...ticket.scope.write], write: [], knowledge: [...ticket.scope.knowledge] },
        skillSnapshots: mergeForgeSkillSnapshots(ticket.orchestratorSkills, [knowledgeSkill]),
        expectedPlanRevision: ticket.acceptedPlan!.revision, candidateId: candidate.id, candidateSha: candidate.candidateSha,
        targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch,
        knowledgeAllocation: ticket.knowledgeBudget.defaultAllocationOperations,
      };
      await this.command(ticket.id, { type: 'begin_orchestrator_run', actor: HOST, run: reviewInput });
      const fresh = this.requireTicket(ticket.id);
      const savedRun = fresh.orchestratorRuns.find((row) => row.id === reviewRunId)!;
      const diff = await gitDiff(ticket.workspaceRoot, candidate.targetMainSha, candidate.candidateSha);
      const prompt = forgeReviewPrompt({ ticket: fresh, workspaceName: path.basename(ticket.workspaceRoot.replace(/[\\/]+$/, '')), runId: reviewRunId,
        candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, diff, combinedReceipt: candidate.combinedReceipt,
        skillSnapshots: savedRun.skillSnapshots, knowledgeSkill, knowledgeBudget: knowledgeAllocationSummary(fresh, savedRun.knowledgeAllocation) });
      await this.launch({
        ticketId: ticket.id, role: 'orchestrator', targetType: 'final_review', targetId: reviewRunId, ownerId, model: reviewInput.requestedProfile.model, effort: reviewInput.requestedProfile.effort,
        executionRoot: ticket.workspaceRoot, canonicalRoot: ticket.workspaceRoot, writeRoots: [], prompt, outputSchema: forgeReviewOutputJsonSchema,
        approvalPolicy: ticket.approvalPolicy, observedTools: [],
      }, savedRun.knowledgeAllocation?.operations);
    } finally { this.stageLocks.delete(lock); }
  }

  private async launch(binding: ForgeActorBinding, _allocation?: number) {
    const request: ForgeProviderRequest = {
      role: binding.role, ticketId: binding.ticketId, taskId: binding.targetId, canonicalRoot: binding.canonicalRoot, executionRoot: binding.executionRoot,
      model: binding.model, effort: binding.effort, prompt: binding.prompt, outputSchema: binding.outputSchema, writeRoots: binding.writeRoots, approvalPolicy: binding.approvalPolicy,
    };
    try {
      const handle = await this.startRole(request,
        async (evidence) => { await this.recordRuntime(binding, evidence); },
        async (event) => { await this.observeEvent(binding, event); },
        async (requestEvent) => { await this.saveApproval(binding, requestEvent); });
      binding.handle = handle;
      const key = actorKey(binding.ticketId, binding.targetType, binding.targetId);
      this.actors.set(key, binding);
      const ticket = this.requireTicket(binding.ticketId);
      if (['paused', 'cancelled'].includes(ticket.phase)) {
        void this.stopActor(binding, 'The ticket was paused or cancelled while the provider turn was starting.');
        return;
      }
      void handle.completion.then((outcome) => this.finishActor(binding, outcome), (error) => this.handleActorError(binding, error));
    } catch (error) {
      const startError = error instanceof ForgeProviderStartError ? error : new ForgeProviderStartError(error instanceof Error ? error.message : 'Forge provider failed to start.', 'uncertain', { cause: error });
      if (binding.targetType === 'worker_attempt') {
        const attempt = this.requireTicket(binding.ticketId).attempts.find((row) => row.id === binding.targetId);
        if (!attempt) return;
        if (startError.effect === 'not_started') await this.command(binding.ticketId, { type: 'fail_attempt_preflight', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token, stage: 'provider_start', effect: 'confirmed_not_started', failureReason: startError.message, evidence: [startError.message] });
        else await this.command(binding.ticketId, { type: 'mark_attempt_effect_uncertain', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token, evidence: startError.message });
      } else if (startError.effect === 'not_started') {
        if (binding.targetType === 'planning' || binding.targetType === 'final_review') await this.command(binding.ticketId, { type: 'fail_orchestrator_run', actor: HOST, runId: binding.targetId, failureReason: startError.message });
        else await this.command(binding.ticketId, { type: 'fail_integration_run', actor: HOST, runId: binding.targetId, failureReason: startError.message });
      } else await this.command(binding.ticketId, { type: 'recover_after_restart', actor: HOST });
      if (binding.targetType === 'worker_attempt') void this.pump(binding.ticketId);
    }
  }

  private async recordRuntime(binding: ForgeActorBinding, evidence: ForgeProviderStartEvidence) {
    if (binding.targetType === 'worker_attempt') {
      const attempt = this.requireTicket(binding.ticketId).attempts.find((row) => row.id === binding.targetId);
      if (!attempt) throw new Error('Forge worker attempt disappeared before provider IDs were persisted.');
      await this.command(binding.ticketId, { type: 'record_attempt_runtime', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token, threadId: evidence.threadId, turnId: evidence.turnId });
    } else if (binding.targetType === 'integration') {
      await this.command(binding.ticketId, { type: 'record_integration_runtime', actor: HOST, runId: binding.targetId, threadId: evidence.threadId, turnId: evidence.turnId });
    } else await this.command(binding.ticketId, { type: 'record_orchestrator_runtime', actor: HOST, runId: binding.targetId, threadId: evidence.threadId, turnId: evidence.turnId });
  }

  private async observeEvent(binding: ForgeActorBinding, event: ForgeProviderEvent) {
    const ticket = this.getTicket(binding.ticketId);
    if (!ticket || !this.actorOwns(ticket, binding, event.threadId, event.turnId)) return;
    const item = (event.params as any)?.item;
    if (!item || !TOOL_ITEM_TYPES.has(item.type)) return;
    const callId = String(item.id || item.callId || item.itemId || '');
    if (!callId) return;
    const lifecycle = event.method === 'item/started' ? 'started' : 'completed';
    const name = safeToolName(item);
    const toolEvent: ToolCallEvent = {
      identity: { provider: 'codex', agentId: `${binding.role}:${binding.ownerId}`, threadId: event.threadId, turnId: event.turnId, callId },
      name, type: String(item.type).slice(0, 160), source: 'model', lifecycle, timestamp: this.now(), agentRole: binding.role,
    };
    await this.options.mutate((state) => { recordForgeToolCallInState(state, binding.ticketId, toolEvent, toolEvent.timestamp); });
    if (item.type === 'commandExecution' && event.method === 'item/completed') {
      const command = typeof item.command === 'string' ? item.command.slice(0, 500) : '';
      const exitCode = Number.isInteger(item.exitCode) ? item.exitCode as number : undefined;
      binding.observedTools.push({ command, ...(exitCode === undefined ? {} : { exitCode }), status: typeof item.status === 'string' ? item.status : 'completed' });
      if (binding.observedTools.length > 100) binding.observedTools.splice(0, binding.observedTools.length - 100);
    }
  }

  private async saveApproval(binding: ForgeActorBinding, event: ForgeProviderApprovalRequest) {
    const ticket = this.getTicket(binding.ticketId);
    if (!ticket || !this.actorOwns(ticket, binding, event.threadId, event.turnId)) throw new Error('The Forge approval request is no longer owned by a live ticket actor.');
    const forgeContext: ForgeApprovalContext = { ticketId: binding.ticketId, targetType: binding.targetType, targetId: binding.targetId, ownerId: binding.ownerId, ...(binding.claimToken ? { claimToken: binding.claimToken } : {}) };
    const { requestId, method, itemId, threadId, turnId, request } = event;
    const saved = {
      requestId, method: method as ForgeApprovalRequest['method'], itemId, threadId, turnId,
      ...optionalRequestFields(request),
      ...(request.permissions && typeof request.permissions === 'object' ? { permissions: request.permissions } : {}),
      forgeContext,
    } as ForgeApprovalRequest;
    await this.options.mutate((state) => { recordForgeApprovalRequestInState(state, binding.ticketId, saved); });
  }

  private async clearConfirmedActorApprovals(binding: ForgeActorBinding, status: 'stopped' | 'completed', evidence: string) {
    const task = this.options.getState().tasks.find((row) => row.id === binding.ticketId && row.sessionType === 'forge');
    const requests = (task?.approvalRequests || []).filter((request) => {
      const context = request.forgeContext;
      return context?.ticketId === binding.ticketId && context.targetType === binding.targetType && context.targetId === binding.targetId
        && context.ownerId === binding.ownerId && context.claimToken === binding.claimToken
        && request.threadId === binding.handle?.threadId && request.turnId === binding.handle?.turnId;
    });
    for (const request of requests) {
      if (!request.forgeContext) continue;
      const context = { ...request.forgeContext, threadId: request.threadId, turnId: request.turnId };
      await this.options.mutate((state) => {
        clearForgeApprovalAfterProviderCancellationInState(state, binding.ticketId, request.requestId, request.itemId, context, { status, evidence });
      });
    }
  }

  private async finishActor(binding: ForgeActorBinding, outcome: ForgeProviderOutcome) {
    const key = actorKey(binding.ticketId, binding.targetType, binding.targetId);
    const active = this.actors.get(key);
    if (active && active.handle && binding.handle && active.handle.turnId !== binding.handle.turnId) return;
    if (outcome.status === 'unknown') { await this.markUncertain(binding, 'The provider completion effect is uncertain; the saved actor, worktree, receipt history, and knowledge reservation remain owned pending reconciliation.'); return; }
    if (binding.targetType === 'worker_attempt') await this.finishWorker(binding, outcome);
    else if (binding.targetType === 'planning') await this.finishPlanning(binding, outcome);
    else if (binding.targetType === 'integration') await this.finishIntegration(binding, outcome);
    else await this.finishReview(binding, outcome);
    this.actors.delete(key);
    void this.pump(binding.ticketId);
  }

  private async finishPlanning(binding: ForgeActorBinding, outcome: ForgeProviderOutcome) {
    const ticket = this.requireTicket(binding.ticketId);
    const run = ticket.orchestratorRuns.find((row) => row.id === binding.targetId);
    if (!run?.threadId || !run.turnId) return;
    if (outcome.status !== 'completed') {
      await this.command(ticket.id, { type: 'fail_orchestrator_run', actor: HOST, runId: run.id, failureReason: `The planning turn ${outcome.status}: ${providerFailure(outcome)}` });
      return;
    }
    try {
      const result = parseForgePlanResult(outcome.text, ticket, await this.loadKnowledgeSkill(ticket));
      await this.recordKnowledge(ticket.id, 'planning', run.id, run.ownerId, run.threadId, run.turnId, result.knowledgeOperations, 'agent_reported', `Planning model reported ${result.knowledgeOperations} knowledge operations.`);
      await this.command(ticket.id, { type: 'complete_planning', actor: HOST, runId: run.id, expectedPlanRevision: run.expectedPlanRevision, threadId: run.threadId, turnId: run.turnId, planId: randomUUID(), tasks: result.tasks });
    } catch (error) {
      await this.command(ticket.id, { type: 'fail_orchestrator_run', actor: HOST, runId: run.id, failureReason: `Planning output was rejected: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async finishWorker(binding: ForgeActorBinding, outcome: ForgeProviderOutcome) {
    const ticket = this.requireTicket(binding.ticketId);
    const attempt = ticket.attempts.find((row) => row.id === binding.targetId);
    if (!attempt?.threadId || !attempt.turnId) return;
    if (outcome.status !== 'completed') {
      const receipt = applicationReceipt('failed', `The worker turn ${outcome.status}: ${providerFailure(outcome)}`, 'The provider did not return a complete worker outcome.', 'application_failure');
      await this.command(ticket.id, { type: 'accept_worker_outcome', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token,
        outcomeId: randomUUID(), receiptId: randomUUID(), receipt, provenance: receiptProvenance(attempt, 'application_failure'), retryable: this.canRetry(ticket, attempt), failureReason: providerFailure(outcome) });
      return;
    }
    let parsed;
    try { parsed = parseForgeWorkerOutcome(outcome.text); }
    catch (error) {
      const receipt = applicationReceipt('failed', `The worker output was not a valid Forge receipt: ${error instanceof Error ? error.message : String(error)}`, 'The application could not validate the structured worker outcome.', 'application_failure');
      await this.command(ticket.id, { type: 'accept_worker_outcome', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token,
        outcomeId: randomUUID(), receiptId: randomUUID(), receipt, provenance: receiptProvenance(attempt, 'application_failure'), retryable: this.canRetry(ticket, attempt), failureReason: receipt.result });
      return;
    }
    await this.recordKnowledge(ticket.id, 'worker_attempt', attempt.id, attempt.claim.ownerId, attempt.threadId, attempt.turnId, parsed.knowledgeOperations, 'agent_reported', `Worker ${attempt.claim.ownerId} reported ${parsed.knowledgeOperations} knowledge operations.`);
    if (parsed.type === 'escalation') {
      const receipt: Receipt = { status: 'blocked', result: parsed.decision_needed || 'The worker requested an orchestrator decision.', changes: [], acceptance: { met: [], unmet: ['Worker escalation requires a scoped orchestration decision.'] }, verification: [], risks: parsed.evidence, knowledge: { consulted: [], updated: [] }, decision_required: parsed.decision_needed };
      await this.command(ticket.id, { type: 'accept_worker_outcome', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token,
        outcomeId: randomUUID(), receiptId: randomUUID(), receipt, provenance: receiptProvenance(attempt, 'model_turn'), retryable: false, failureReason: parsed.decision_needed || undefined });
      return;
    }
    const receipt = parsed.receipt!;
    const { prepared, attestation, failure } = await this.attestWorkerCommit(ticket, attempt, receipt);
    void prepared;
    const complete = receipt.status === 'complete' && receipt.acceptance.unmet.length === 0 && attestation?.status === 'verified';
    await this.command(ticket.id, { type: 'accept_worker_outcome', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token,
      outcomeId: randomUUID(), receiptId: randomUUID(), receipt, provenance: receiptProvenance(attempt, 'model_turn'), ...(attestation ? { hostAttestation: attestation } : {}),
      retryable: !complete && this.canRetry(ticket, attempt), ...(failure ? { failureReason: failure } : {}) });
  }

  private async attestWorkerCommit(ticket: ForgeTicket, attempt: ForgeAttempt, receipt: Receipt) {
    if (!attempt.dispatchBaselineSha) return { prepared: undefined, failure: 'The dispatch baseline was not saved.', attestation: undefined as ForgeHostAttestation | undefined };
    try {
      const prepared = await restoreForgeWorkerWorktrees(ticket, attempt);
      const reportedCommit = await readHead(attempt.worktreeRoot);
      const assignment = ticket.workitems.find((row) => row.id === attempt.taskId)!;
      const plan = ticket.acceptedPlan!.tasks.find((row) => row.id === attempt.taskId)!;
      const assignmentSnapshot = assignment.correctionAssignments.at(-1) || plan.assignment;
      const check = await validateForgeWorkerCommit({ prepared, workItemId: attempt.taskId, workerId: attempt.claim.ownerId, baselineCommit: attempt.dispatchBaselineSha, reportedCommit, writeScope: assignmentSnapshot.assignment.write_scope });
      const attestation: ForgeHostAttestation = {
        status: check.status === 'accepted' ? 'verified' : 'rejected', commitObserved: check.status === 'accepted', scopeValidation: check.status === 'accepted' ? 'passed' : 'failed',
        ...(check.status === 'accepted' ? { commitSha: check.commit } : {}), observedAt: this.now(), evidenceRefs: check.status === 'accepted' ? [`F2 observed HEAD ${check.commit} from saved dispatch baseline ${check.baselineCommit}; changed paths: ${check.changedPaths.join(', ') || '(none)'}.`] : [`F2 rejected worker commit: ${check.reason || 'unknown'}; out-of-scope paths: ${check.outOfScopePaths.join(', ') || '(none)'}.`],
      };
      const failure = check.status === 'accepted' ? undefined : `F2 worker commit validation failed: ${check.reason || 'unknown'}; out-of-scope paths: ${check.outOfScopePaths.join(', ') || '(none)'}.`;
      if (receipt.status === 'complete' && check.status !== 'accepted') return { prepared, failure, attestation };
      return { prepared, failure, attestation };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'F2 could not validate the worker commit.';
      return { prepared: undefined, failure: reason, attestation: { status: 'rejected', commitObserved: false, scopeValidation: 'failed', observedAt: this.now(), evidenceRefs: [`F2 host validation failed: ${reason}`] } as ForgeHostAttestation };
    }
  }

  private async finishIntegration(binding: ForgeActorBinding, outcome: ForgeProviderOutcome) {
    const ticket = this.requireTicket(binding.ticketId);
    const run = ticket.integration.runs.find((row) => row.id === binding.targetId);
    const savedCandidate = actorCandidateEvidence.get(actorKey(ticket.id, 'integration', binding.targetId));
    if (!run?.threadId || !run.turnId || !savedCandidate) return;
    if (outcome.status !== 'completed') {
      await this.command(ticket.id, { type: 'fail_integration_run', actor: HOST, runId: run.id, failureReason: `The integrator turn ${outcome.status}: ${providerFailure(outcome)}` });
      return;
    }
    try {
      const saved = ticket.workitems.map((item) => savedWorkerReceipt(ticket, item.id));
      const result = parseForgeIntegratorOutput(outcome.text, saved);
      await this.recordKnowledge(ticket.id, 'integration', run.id, run.ownerId, run.threadId, run.turnId, result.knowledgeOperations, 'agent_reported', `Integrator reported ${result.knowledgeOperations} knowledge operations.`);
      const expectedCandidate = savedCandidate.evidence.candidateCommit;
      const actualHead = await readHead(savedCandidate.evidence.candidateRoot);
      const actualBase = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch);
      if (actualHead.toLowerCase() !== expectedCandidate.toLowerCase()) throw new Error('The integrator changed the pinned candidate HEAD. Candidate checks cannot be accepted after mutation.');
      if (actualBase.baseCommit.toLowerCase() !== savedCandidate.evidence.targetMainCommit.toLowerCase()) throw new Error('The pinned target branch changed while the integrator was checking the candidate. Rebuild and recheck against the new main SHA.');
      const checkCommands = binding.observedTools.filter((tool) => tool.status === 'completed' && tool.command);
      if (!checkCommands.length) throw new Error('No candidate check command was observed from the integrator turn.');
      for (const check of result.verification) {
        if (check.result === 'passed' && !checkCommands.some((tool) => tool.exitCode === 0 && check.evidence?.includes(tool.command))) throw new Error(`Integrator reported a passing check without matching an observed completed command with exit code 0: ${check.check}`);
        if (check.result === 'failed' && !checkCommands.some((tool) => tool.exitCode !== undefined && tool.exitCode !== 0 && check.evidence?.includes(tool.command))) throw new Error(`Integrator reported a failed check without matching an observed nonzero command result: ${check.check}`);
      }
      const findings = result.findings.map((finding) => ({ ...finding, taskId: finding.taskId || undefined }));
      const corrections = findings.length ? result.corrections.map((row) => {
        const task = ticket.workitems.find((item) => item.id === row.taskId);
        const plan = ticket.acceptedPlan!.tasks.find((item) => item.id === row.taskId);
        if (!task || !plan || task.state !== 'finished') throw new Error(`Integrator correction refers to an unknown or unfinished task: ${row.taskId}.`);
        const selectedSkills = new Map(plan.assignment.skillSnapshots.map((skill) => [skill.id, skill]));
        if (new Set(row.skillIds).size !== row.skillIds.length || row.skillIds.length !== selectedSkills.size || [...selectedSkills.keys()].some((id) => !row.skillIds.includes(id))) throw new Error(`Integrator correction for ${row.taskId} changed the immutable skill revision set.`);
        const assignment = normalizeForgeAssignmentPaths(row.assignment, ticket.workspaceRoot);
        if (!scopeListWithin(assignment.read_scope, [...plan.assignment.assignment.read_scope, ...plan.assignment.assignment.write_scope], ticket.workspaceRoot)
          || !scopeListWithin(assignment.write_scope, plan.assignment.assignment.write_scope, ticket.workspaceRoot)
          || !scopeListWithin(row.knowledgeScope, plan.assignment.knowledgeScope, ticket.workspaceRoot)) throw new Error(`Integrator correction for ${row.taskId} exceeds its accepted scope.`);
        return { taskId: task.id, findingIds: row.findingIds, assignment: { assignment, executionProfile: ticket.workerProfile, knowledgeScope: row.knowledgeScope, skillSnapshots: row.skillIds.map((id) => structuredClone(selectedSkills.get(id)!)) } };
      }) : [];
      const workerCommits = savedCandidate.evidence.workerCommits.map((commit) => {
        const saved = savedWorkerReceipt(ticket, commit.workItemId);
        return { taskId: commit.workItemId, attemptId: commit.sourceAttemptId, receiptId: saved.receiptId, commitSha: commit.commit };
      });
      const candidate = {
        id: randomUUID(), integratorRunId: run.id, candidateSha: expectedCandidate, targetMainSha: savedCandidate.evidence.targetMainCommit, targetBranch: ticket.targetBranch,
        workerCommits, scopeValidation: { status: result.scopeValidation.status, evidence: [`F2 verified all ${workerCommits.length} worker commits against their saved dispatch baselines and scopes.`, ...result.scopeValidation.evidence] },
        verification: result.verification.map((row) => ({ check: row.check, result: row.result, ...(row.evidence ? { evidence: row.evidence } : {}) })),
        combinedReceipt: result.receipt, provenance: { producerRole: 'integrator' as const, threadId: run.threadId, turnId: run.turnId, recordedAt: this.now(), artifactRefs: [`candidate:${expectedCandidate}`, `target:${ticket.targetBranch}:${savedCandidate.evidence.targetMainCommit}`] }, findings, createdAt: this.now(),
      };
      await this.command(ticket.id, { type: 'record_integration_candidate', actor: HOST, candidate });
      if (findings.length) {
        await this.command(ticket.id, { type: 'request_corrections', actor: { role: 'integrator', id: run.ownerId }, correctionId: randomUUID(), items: corrections });
      }
    } catch (error) {
      const current = this.requireTicket(ticket.id).integration.runs.find((row) => row.id === run.id);
      if (current?.status === 'running') await this.command(ticket.id, { type: 'fail_integration_run', actor: HOST, runId: run.id, failureReason: `Integration output or candidate evidence was rejected: ${error instanceof Error ? error.message : String(error)}` });
    }
    actorCandidateEvidence.delete(actorKey(ticket.id, 'integration', binding.targetId));
  }

  private async finishReview(binding: ForgeActorBinding, outcome: ForgeProviderOutcome) {
    const ticket = this.requireTicket(binding.ticketId);
    const run = ticket.orchestratorRuns.find((row) => row.id === binding.targetId);
    if (!run || run.purpose !== 'final_review') return;
    const candidate = ticket.integration.candidates.find((row) => row.id === run.candidateId);
    if (!run.threadId || !run.turnId || !candidate) return;
    if (outcome.status !== 'completed') {
      await this.command(ticket.id, { type: 'fail_orchestrator_run', actor: HOST, runId: run.id, failureReason: `The final-review turn ${outcome.status}: ${providerFailure(outcome)}` });
      return;
    }
    try {
      const result = parseForgeReviewOutput(outcome.text, candidate.candidateSha, candidate.targetMainSha, ticket);
      await this.recordKnowledge(ticket.id, 'final_review', run.id, run.ownerId, run.threadId, run.turnId, result.knowledgeOperations, 'agent_reported', `Final reviewer reported ${result.knowledgeOperations} knowledge operations.`);
      const corrections = result.disposition === 'request_corrections' ? forgeReviewCorrections(result, ticket) : undefined;
      await this.command(ticket.id, { type: 'complete_candidate_review', actor: HOST, runId: run.id, expectedPlanRevision: run.expectedPlanRevision, threadId: run.threadId, turnId: run.turnId,
        candidateId: candidate.id, candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch, disposition: result.disposition, note: result.note,
        ...(corrections ? { correctionId: randomUUID(), corrections } : {}) });
      const reviewed = this.requireTicket(ticket.id);
      if (result.disposition === 'accept' && reviewed.phase === 'merge_ready') await this.mergeAcceptedCandidate(reviewed, candidate);
    } catch (error) {
      const current = this.requireTicket(ticket.id).orchestratorRuns.find((row) => row.id === run.id);
      if (current?.status === 'running') await this.command(ticket.id, { type: 'fail_orchestrator_run', actor: HOST, runId: run.id, failureReason: `Final review output was rejected: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async mergeAcceptedCandidate(ticket: ForgeTicket, candidate: ForgeTicket['integration']['candidates'][number]) {
    const target = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch);
    await this.command(ticket.id, { type: 'begin_merge', actor: HOST, candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch, observedMainSha: target.baseCommit });
    const afterIntent = this.requireTicket(ticket.id);
    if (!afterIntent.integration.mergeIntent) { void this.pump(ticket.id); return; }
    const run = afterIntent.integration.runs.find((row) => row.candidateId === candidate.id);
    if (!run) throw new Error('The approved candidate has no saved F2 integration owner.');
    const prepared = await restoreForgeIntegrationWorktrees(afterIntent, run);
    const workers = await this.finishedWorkerCommits(afterIntent);
    const savedEvidence = await rebuildCandidateEvidence(ticket.id, candidate, prepared, workers);
    const preMerge = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch);
    if (preMerge.baseCommit.toLowerCase() !== candidate.targetMainSha.toLowerCase()) {
      await this.command(ticket.id, { type: 'record_merge_readback', actor: HOST, result: 'stale', candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch, preMergeMainSha: preMerge.baseCommit, observedMainSha: preMerge.baseCommit, detail: 'Target main drifted after candidate review; the candidate was invalidated.' });
      void this.pump(ticket.id); return;
    }
    const result = await finalizeForgeMerge({ prepared, candidate: savedEvidence, workers, authorization: { decisionId: afterIntent.integration.reviewDecisions.find((row) => row.candidateId === candidate.id && row.disposition === 'accept')!.id, acceptedCandidateCommit: candidate.candidateSha, acceptedTargetMainCommit: candidate.targetMainSha } });
    if (result.status === 'stale-target') {
      const observed = result.observedMainCommit;
      await this.command(ticket.id, { type: 'record_merge_readback', actor: HOST, result: 'stale', candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch, preMergeMainSha: result.expectedMainCommit, observedMainSha: observed, detail: `F2 observed target branch drift to ${observed}.` });
      void this.pump(ticket.id); return;
    }
    if (result.status !== 'merged') {
      const observed = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch).then((row) => row.baseCommit).catch(() => candidate.targetMainSha);
      await this.command(ticket.id, { type: 'record_merge_readback', actor: HOST, result: 'failed', candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch, preMergeMainSha: observed, observedMainSha: observed, detail: result.reason || 'F2 rejected the guarded local merge.' });
      throw new Error(result.reason || 'F2 rejected the final local merge.');
    }
    const readback = await validateRecruitmentRoot(ticket.workspaceRoot, ticket.targetBranch);
    if (readback.baseCommit.toLowerCase() !== result.commit.toLowerCase()) throw new Error('The target branch SHA did not read back as the F2 merge commit.');
    await this.command(ticket.id, { type: 'record_merge_readback', actor: HOST, result: 'merged', candidateSha: candidate.candidateSha, targetMainSha: candidate.targetMainSha, targetBranch: ticket.targetBranch,
      preMergeMainSha: result.targetMainCommit, observedMainSha: readback.baseCommit, mergeCommitSha: result.commit, commitReadbackSha: readback.baseCommit });
  }

  private async recordActorStopped(binding: ForgeActorBinding, detail: string) {
    const ticket = this.getTicket(binding.ticketId);
    if (!ticket) return;
    if (binding.targetType === 'worker_attempt') {
      const attempt = ticket.attempts.find((row) => row.id === binding.targetId);
      if (!attempt?.threadId || !attempt.turnId) return;
      const receipt = applicationReceipt('incomplete', detail, 'The provider confirmed the turn stopped before a complete receipt was saved.', 'application_status');
      await this.command(ticket.id, { type: 'accept_worker_outcome', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token, outcomeId: randomUUID(), receiptId: randomUUID(), receipt, provenance: receiptProvenance(attempt, 'application_status'), retryable: this.canRetry(ticket, attempt), failureReason: detail });
    } else if (binding.targetType === 'planning' || binding.targetType === 'final_review') await this.command(ticket.id, { type: 'fail_orchestrator_run', actor: HOST, runId: binding.targetId, failureReason: detail });
    else await this.command(ticket.id, { type: 'fail_integration_run', actor: HOST, runId: binding.targetId, failureReason: detail });
  }

  private async markUncertain(binding: ForgeActorBinding, evidence: string) {
    if (binding.targetType === 'worker_attempt') {
      const attempt = this.requireTicket(binding.ticketId).attempts.find((row) => row.id === binding.targetId);
      if (attempt) await this.command(binding.ticketId, { type: 'mark_attempt_effect_uncertain', actor: HOST, taskId: attempt.taskId, ownerId: attempt.claim.ownerId, attemptId: attempt.id, claimToken: attempt.claim.token, evidence });
    } else await this.command(binding.ticketId, { type: 'recover_after_restart', actor: HOST });
  }

  private async stopActor(binding: ForgeActorBinding, detail: string) {
    if (!binding.handle) return;
    try {
      const result = await this.cancelRole(binding.handle);
      if (result.status === 'uncertain') await this.markUncertain(binding, detail);
      else if (result.status === 'completed' && result.outcome) await this.finishActor(binding, result.outcome);
      else await this.recordActorStopped(binding, detail);
    } catch { await this.markUncertain(binding, detail); }
  }

  private async handleActorError(binding: ForgeActorBinding, error: unknown) {
    const detail = error instanceof Error ? error.message : 'Forge provider turn failed.';
    if (binding.targetType === 'worker_attempt') {
      const attempt = this.requireTicket(binding.ticketId).attempts.find((row) => row.id === binding.targetId);
      if (attempt?.threadId && attempt.turnId) await this.finishWorker(binding, { status: 'failed', turn: undefined, text: detail });
      else await this.markUncertain(binding, detail);
    } else if (binding.handle) await this.markUncertain(binding, detail);
    else if (binding.targetType === 'integration') await this.command(binding.ticketId, { type: 'fail_integration_run', actor: HOST, runId: binding.targetId, failureReason: detail });
    else await this.command(binding.ticketId, { type: 'fail_orchestrator_run', actor: HOST, runId: binding.targetId, failureReason: detail });
    this.actors.delete(actorKey(binding.ticketId, binding.targetType, binding.targetId));
    void this.pump(binding.ticketId);
  }

  private async recordKnowledge(ticketId: string, targetType: 'planning' | 'final_review' | 'worker_attempt' | 'integration', targetId: string, ownerId: string, threadId: string, turnId: string, operations: number, source: 'agent_reported' | 'runtime_observed', evidence: string) {
    await this.command(ticketId, { type: 'record_knowledge_usage', actor: HOST, targetType, targetId, operations, source, threadId, turnId, evidence: `${ownerId}: ${evidence}` });
  }

  private canRetry(ticket: ForgeTicket, attempt: ForgeAttempt) {
    return ticket.attempts.filter((row) => row.taskId === attempt.taskId && row.assignmentRevision === attempt.assignmentRevision).length < ticket.limits.maxExecutionAttempts;
  }

  private async loadKnowledgeSkill(ticket: ForgeTicket) {
    const snapshots = ticket.orchestratorSkills.filter((skill) => skill.name.toLowerCase() === 'agentmem-project');
    const selected = snapshots.at(-1);
    if (!selected) throw new Error('Forge needs the required external AgentMem project skill snapshot. Install or configure agentmem-project in the selected workspace or Codex skill roots, then create a new ticket.');
    return structuredClone(selected);
  }

  private async command(ticketId: string, command: ForgeCommand) {
    let output: ForgeTicket | undefined;
    await this.options.mutate((state) => { output = applyCommandInState(state, ticketId, command, this.now()); });
    return output!;
  }

  private requireTicket(ticketId: string) {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error('Forge session not found.');
    return ticket;
  }

  private actorFor(ticket: ForgeTicket, role: ForgeProviderRole, targetId: string) {
    const targetType = role === 'integrator' ? 'integration' : role === 'worker' ? 'worker_attempt' : ticket.orchestratorRuns.find((row) => row.id === targetId)?.purpose;
    return targetType ? this.actors.get(actorKey(ticket.id, targetType, targetId)) : undefined;
  }

  private actorOwns(ticket: ForgeTicket, binding: ForgeActorBinding, threadId: string, turnId: string) {
    if (binding.targetType === 'worker_attempt') {
      const attempt = ticket.attempts.find((row) => row.id === binding.targetId);
      return !!attempt && attempt.claim.ownerId === binding.ownerId && attempt.claim.token === binding.claimToken && attempt.threadId === threadId && attempt.turnId === turnId && ['claimed', 'unknown_after_restart'].includes(attempt.status);
    }
    if (binding.targetType === 'integration') {
      const run = ticket.integration.runs.find((row) => row.id === binding.targetId);
      return !!run && run.ownerId === binding.ownerId && run.threadId === threadId && run.turnId === turnId && ['running', 'unknown_after_restart'].includes(run.status);
    }
    const run = ticket.orchestratorRuns.find((row) => row.id === binding.targetId && row.purpose === binding.targetType);
    return !!run && run.ownerId === binding.ownerId && run.threadId === threadId && run.turnId === turnId && ['running', 'unknown_after_restart'].includes(run.status);
  }
}

function applyCommandInState(state: State, ticketId: string, command: ForgeCommand, now: string) {
  return applyForgeCommandInState(state, ticketId, command, now);
}

const actorCandidateEvidence = new Map<string, { evidence: ForgeCandidateEvidence; prepared: PreparedForgeWorktrees; commits: ForgeWorkerCommitInput[] }>();
const approvalInput = z.object({ decision: z.enum(['accept', 'decline', 'cancel']), content: z.record(z.string(), z.unknown()).optional() }).strict();

function actorKey(ticketId: string, targetType: string, targetId: string) { return `${ticketId}:${targetType}:${targetId}`; }
function roleForTarget(targetType: ForgeApprovalContext['targetType']): ForgeProviderRole { return targetType === 'integration' ? 'integrator' : targetType === 'worker_attempt' ? 'worker' : 'orchestrator'; }
function normalizeTicketScope(scope: ForgeTicket['scope'], workspaceRoot: string): ForgeTicket['scope'] {
  const normalize = (value: string) => {
    if (/^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i.test(value)) return value;
    const root = path.resolve(workspaceRoot);
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Forge filesystem scope must remain inside the selected workspace: ${value}`);
    return resolved;
  };
  return { read: scope.read.map(normalize), write: scope.write.map(normalize), knowledge: [...scope.knowledge] };
}
function scopeListWithin(values: string[], allowed: string[], workspaceRoot: string) {
  const canonical = (value: string) => {
    if (/^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i.test(value)) return value.trim().toLowerCase();
    const root = path.resolve(workspaceRoot);
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    return relative.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  };
  const allowedPaths = allowed.map(canonical).filter((value): value is string => value !== undefined);
  return values.every((value) => {
    const candidate = canonical(value);
    return candidate !== undefined && allowedPaths.some((base) => base === candidate || !/^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i.test(base)
      && candidate.startsWith(base ? `${base}/` : ''));
  });
}
function safeToolName(item: any) { const labels: Record<string, string> = { commandExecution: 'Run command', fileChange: 'File change', mcpToolCall: 'MCP tool', webSearchCall: 'Web search', dynamicToolCall: 'App tool', collabAgentToolCall: 'Agent collaboration' }; return labels[item.type] || 'Provider tool'; }
function optionalRequestFields(request: Record<string, unknown>) {
  const fields = ['reason', 'command', 'cwd', 'grantRoot', 'availableDecisions', 'kind', 'networkHost', 'networkProtocol', 'serverName', 'mode', 'message', 'requestedSchema', 'url'] as const;
  return Object.fromEntries(fields.flatMap((field) => request[field] === undefined ? [] : [[field, request[field]]])) as Partial<ForgeApprovalRequest>;
}
function providerApprovalFromSaved(saved: ForgeApprovalRequest, binding: ForgeActorBinding): ForgeProviderApprovalRequest {
  const request = saved as ForgeApprovalRequest & { permissions?: unknown };
  return { requestId: saved.requestId, method: saved.method, threadId: saved.threadId, turnId: saved.turnId, itemId: saved.itemId, role: binding.role, ticketId: binding.ticketId, taskId: binding.targetId, request: { ...optionalRequestFields(saved), ...(request.permissions ? { permissions: request.permissions } : {}) } };
}
function assignmentForWorktree(assignment: Assignment, canonicalRoot: string, worktreeRoot: string): Assignment {
  const translated = (value: string) => {
    const root = path.resolve(canonicalRoot); const scope = path.resolve(value);
    const relative = path.relative(root, scope);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Forge write scope escaped the canonical workspace: ${value}`);
    return path.resolve(worktreeRoot, relative);
  };
  return { ...assignment, read_scope: assignment.read_scope.map((value) => path.isAbsolute(value) ? translated(value) : value), write_scope: assignment.write_scope.map((value) => /^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i.test(value) ? value : translated(value)) };
}
function mapWriteRoots(writeScope: string[], canonicalRoot: string, worktreeRoot: string) {
  return assignmentWriteRoots({ write_scope: writeScope }, canonicalRoot).map((root) => {
    const relative = path.relative(path.resolve(canonicalRoot), root);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Forge writable path escaped the canonical workspace.');
    return path.resolve(worktreeRoot, relative);
  });
}
function actorForAttempt(ticketId: string, attempt: ForgeAttempt): ForgeActorBinding {
  return { ticketId, role: 'worker', targetType: 'worker_attempt', targetId: attempt.id, ownerId: attempt.claim.ownerId, claimToken: attempt.claim.token, model: attempt.executionProfile.model, effort: attempt.executionProfile.effort, executionRoot: attempt.worktreeRoot, canonicalRoot: '', writeRoots: [], prompt: '', outputSchema: forgeWorkerOutcomeJsonSchema, approvalPolicy: 'on-request', observedTools: [] };
}
function latestFinishedAttempt(ticket: ForgeTicket, taskId: string) { return ticket.attempts.filter((attempt) => attempt.taskId === taskId && attempt.assignmentRevision === ticket.workitems.find((row) => row.id === taskId)?.assignmentRevision && attempt.status === 'finished').at(-1); }
function savedWorkerReceipt(ticket: ForgeTicket, taskId: string) {
  const attempt = latestFinishedAttempt(ticket, taskId);
  const saved = attempt && ticket.receipts.find((receipt) => receipt.attemptId === attempt.id && receipt.id === attempt.receiptId);
  if (!attempt?.commitSha || !saved) throw new Error(`Forge task ${taskId} has no finished verified receipt.`);
  return { taskId, attemptId: attempt.id, receiptId: saved.id, commitSha: attempt.commitSha, receipt: saved.receipt };
}
function receiptProvenance(attempt: ForgeAttempt, origin: 'model_turn' | 'application_failure' | 'application_status'): ForgeReceiptProvenance {
  return { producerRole: 'worker', threadId: attempt.threadId!, turnId: attempt.turnId!, recordedAt: new Date().toISOString(), artifactRefs: [], origin, workerId: attempt.claim.ownerId };
}
function applicationReceipt(status: Receipt['status'], result: string, unmet: string, _origin: 'application_failure' | 'application_status'): Receipt {
  return { status, result: result.slice(0, 12000), changes: [], acceptance: { met: [], unmet: [unmet] }, verification: [], risks: [], knowledge: { consulted: [], updated: [] }, decision_required: null };
}
function knowledgeAllocationSummary(ticket: ForgeTicket, allocation?: ForgeKnowledgeAllocation) {
  const balance = forgeKnowledgeBudgetBalance(ticket);
  return { allocationOperations: allocation?.operations ?? ticket.knowledgeBudget.defaultAllocationOperations, totalOperations: balance.totalOperations, allocatedOperations: balance.allocatedOperations, remainingOperations: balance.remainingOperations, enforcement: ticket.capabilities.operationBudget };
}
function providerFailure(outcome: ForgeProviderOutcome) { return (outcome.text || (outcome.turn as any)?.error || `Provider status ${outcome.status}`).slice(0, 3000); }
async function readHead(root: string) {
  const result = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { cwd: root, windowsHide: true, timeout: 10_000, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return String(result.stdout).trim();
}
async function gitDiff(root: string, base: string, head: string) {
  const result = await execFileAsync('git', ['--no-pager', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', `${base}..${head}`, '--'], { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return String(result.stdout).slice(0, MAX_GIT_DIFF);
}
async function rebuildCandidateEvidence(ticketId: string, candidate: ForgeTicket['integration']['candidates'][number], prepared: PreparedForgeWorktrees, workers: ForgeWorkerCommitInput[]): Promise<ForgeCandidateEvidence> {
  const workerCommits = workers.map((worker) => ({
    workItemId: worker.workItemId!, workerId: worker.workerId, sourceAttemptId: worker.prepared!.attemptId, sourceTaskRoot: worker.prepared!.taskRoot,
    branch: worker.prepared!.workers.find((row) => row.workerId === worker.workerId)!.branch, worktreeRoot: worker.prepared!.workers.find((row) => row.workerId === worker.workerId)!.worktreeRoot,
    baselineCommit: worker.baselineCommit, commit: worker.reportedCommit,
  }));
  return { ticketId, attemptId: prepared.attemptId, targetBranch: candidate.targetBranch, targetMainCommit: candidate.targetMainSha, candidateBranch: prepared.integration.branch, candidateRoot: prepared.integration.worktreeRoot, candidateCommit: candidate.candidateSha, workerCommits };
}
function forgeReviewCorrections(result: z.infer<typeof forgeReviewOutputSchema>, ticket: ForgeTicket) {
  const selected = new Map(ticket.acceptedPlan!.tasks.flatMap((task) => task.assignment.skillSnapshots).map((skill) => [skill.id, skill]));
  return result.corrections.map((row) => ({ taskId: row.taskId, findings: row.findings.map((finding) => ({ ...finding, taskId: row.taskId })), assignment: { assignment: row.assignment, executionProfile: ticket.workerProfile, knowledgeScope: row.knowledgeScope, skillSnapshots: row.skillIds.map((id) => structuredClone(selected.get(id)!)) } }));
}

function appRoot() { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
