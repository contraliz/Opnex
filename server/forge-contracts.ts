import { z } from 'zod';
import {
  assignmentSchema,
  forgeCapabilitiesSchema,
  forgeEffortSchema,
  forgeExecutionProfileSchema,
  type ApprovalPolicy,
  forgeKnowledgeBudgetSchema,
  DEFAULT_FORGE_KNOWLEDGE_BUDGET,
  MAX_FORGE_SKILL_SNAPSHOTS,
  forgeLimitsSchema,
  forgeScopeSchema,
  MAX_FORGE_WORKITEMS,
  receiptSchema,
  type Receipt,
} from './contracts.js';

const id=z.string().trim().min(1).max(128);
const text=z.string().trim().min(1).max(12000);
const date=z.string().datetime();
const sha=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);

export const forgeActorSchema=z.object({role:z.enum(['orchestrator','worker','integrator','host','user']),id}).strict();
export const forgeSkillSnapshotSchema=z.object({
  id:z.string().trim().min(1).max(200),revision:z.string().trim().min(1).max(200),
  name:z.string().trim().min(1).max(160),description:z.string().max(2000),source:z.string().min(1).max(500),
  instructions:z.string().max(100000),files:z.array(z.object({path:z.string().min(1).max(1024),size:z.number().int().nonnegative().max(100000000)}).strict()).max(256),
  role:z.enum(['router','direct','simple','orchestrator','worker','integrator']).optional(),loadedAt:date.optional(),
}).strict();
export const forgeReceiptProvenanceSchema=z.object({
  producerRole:z.enum(['simple','worker','integrator']),threadId:id,turnId:id,recordedAt:date,artifactRefs:z.array(text).max(40),
  origin:z.enum(['model_turn','application_failure','application_status']).optional(),workerId:id.optional(),teamId:id.optional(),passId:id.optional(),
}).strict();
export const forgeAssignmentSnapshotInputSchema=z.object({
  assignment:assignmentSchema,executionProfile:forgeExecutionProfileSchema,
  skillSnapshots:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),knowledgeScope:z.array(text.max(1024)).max(80),
}).strict();
export const forgePlanTaskInputSchema=z.object({
  id,title:z.string().trim().min(1).max(160),description:text,dependencyIds:z.array(id).max(MAX_FORGE_WORKITEMS),
  assignment:assignmentSchema,knowledgeScope:z.array(text.max(1024)).max(80),
  executionProfile:forgeExecutionProfileSchema,skillSnapshots:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),
}).strict();
const forgeAssignmentSnapshotSchema=forgeAssignmentSnapshotInputSchema.extend({
  revision:z.number().int().min(1),source:z.enum(['plan','correction']),createdAt:date,findingIds:z.array(id).max(100).optional(),
}).strict();
const forgePlanItemSchema=z.object({id,title:z.string().trim().min(1).max(160),description:text,dependencyIds:z.array(id).max(MAX_FORGE_WORKITEMS),assignment:forgeAssignmentSnapshotSchema}).strict();
const forgePlanProposalSchema=z.object({
  id,revision:z.number().int().min(1),proposedAt:date,proposedBy:id,source:z.enum(['legacy','manual','model_run']).default('legacy'),runId:id.optional(),tasks:z.array(forgePlanItemSchema).min(1).max(MAX_FORGE_WORKITEMS),
}).strict();
const forgeAcceptedPlanSchema=forgePlanProposalSchema.extend({acceptedAt:date,acceptedBy:id}).strict();
const forgeReconciliationSchema=z.object({status:z.enum(['still_running','stopped']),evidence:text,actorId:id,recordedAt:date}).strict();
export const forgePreflightFailureSchema=z.object({stage:z.enum(['dependency_merge','workspace_prepare','provider_start']),reason:text,evidence:z.array(text).min(1).max(40),recordedAt:date}).strict();
export const forgeKnowledgeUsageSchema=z.object({
  operations:z.number().int().nonnegative(),source:z.enum(['agent_reported','runtime_observed']),ownerId:id,recordedBy:id,
  threadId:id,turnId:id,recordedAt:date,evidence:z.string().trim().min(1).max(4000),
}).strict();
export const forgeKnowledgeAllocationSchema=z.object({
  operations:z.number().int().min(0).max(8),ownerId:id,reservedBy:id,reservedAt:date,status:z.enum(['reserved','reported']),usage:forgeKnowledgeUsageSchema.optional(),
}).strict().superRefine((allocation,ctx)=>{
  if((allocation.status==='reported')!==!!allocation.usage)ctx.addIssue({code:'custom',message:'Knowledge allocation status must match its saved usage report.'});
  if(allocation.usage&&allocation.usage.ownerId!==allocation.ownerId)ctx.addIssue({code:'custom',path:['usage','ownerId'],message:'Knowledge usage must be attributed to its allocated agent.'});
});
const forgeBlockReasonSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('dependencies'),taskIds:z.array(id).min(1).max(MAX_FORGE_WORKITEMS)}).strict(),
  z.object({kind:z.literal('execution_issue'),code:z.enum(['attempt_failed','retry_limit','unknown_after_restart','unknown_effect','preflight_failed','unverified_commit','manual','correction_limit']),detail:text,attemptId:id.optional()}).strict(),
]);
export const forgeVisibleTaskStateSchema=z.enum(['open','claimed','finished','blocked']);
export const forgeWorkitemSchema=z.object({
  id,state:forgeVisibleTaskStateSchema,dependencyIds:z.array(id).max(MAX_FORGE_WORKITEMS),blockedReason:forgeBlockReasonSchema.optional(),
  activeAttemptId:id.optional(),attemptIds:z.array(id).max(1000),assignmentRevision:z.number().int().min(1),
  correctionAssignments:z.array(forgeAssignmentSnapshotSchema).max(10),updatedAt:date,
}).strict();
export const forgeClaimSchema=z.object({id,token:z.string().min(1).max(512),ownerId:id,attemptId:id,claimedAt:date,expiresAt:date.optional()}).strict();
export const forgeAttemptSchema=z.object({
  id,taskId:id,ordinal:z.number().int().min(1),assignmentRevision:z.number().int().min(1),status:z.enum(['claimed','unknown_after_restart','unknown_effect','finished','failed','interrupted','preflight_failed']),
  claim:forgeClaimSchema,runtimeId:id,branch:z.string().trim().min(1).max(240),worktreeRoot:z.string().trim().min(1).max(1024),sourceBaselineSha:sha,
  executionProfile:forgeExecutionProfileSchema,scopes:forgeScopeSchema,skillSnapshots:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),knowledgeAllocation:forgeKnowledgeAllocationSchema.optional(),
  dispatchBaselineSha:sha.optional(),preflightFailure:forgePreflightFailureSchema.optional(),threadId:id.optional(),turnId:id.optional(),startedAt:date.optional(),completedAt:date.optional(),outcomeId:id.optional(),receiptId:id.optional(),commitSha:sha.optional(),failureReason:z.string().max(4000).optional(),reconciliation:forgeReconciliationSchema.optional(),
}).strict();
export const forgeHostAttestationSchema=z.object({
  status:z.enum(['verified','rejected']),commitObserved:z.boolean(),scopeValidation:z.enum(['passed','failed']),commitSha:sha.optional(),
  observedAt:date,evidenceRefs:z.array(text).min(1).max(40),
}).strict().superRefine((value,ctx)=>{
  if(value.status==='verified'&&(!value.commitObserved||value.scopeValidation!=='passed'||!value.commitSha))ctx.addIssue({code:'custom',message:'Verified worker commits require an observed SHA and passing scope validation.'});
});
export const forgeStoredReceiptSchema=z.object({
  id,attemptId:id,outcomeId:id,receipt:receiptSchema,provenance:forgeReceiptProvenanceSchema,hostAttestation:forgeHostAttestationSchema.optional(),savedAt:date,
}).strict();
export const forgeVerificationSchema=z.object({check:text,result:z.enum(['passed','failed','not_run']),evidence:z.string().max(4000).optional()}).strict().superRefine((value,ctx)=>{
  if(value.result==='passed'&&!value.evidence?.trim())ctx.addIssue({code:'custom',path:['evidence'],message:'Passing Forge verification requires recorded evidence.'});
});
const forgeWorkerCommitSchema=z.object({taskId:id,attemptId:id,receiptId:id,commitSha:sha}).strict();
export const forgeIntegrationFindingSchema=z.object({id,taskId:id.optional(),title:z.string().trim().min(1).max(240),issue:text,requiredFix:text,evidence:z.array(text).min(1).max(12)}).strict();
export const forgeCorrectionFindingSchema=forgeIntegrationFindingSchema.extend({taskId:id}).strict();
export const forgeIntegrationRunInputSchema=z.object({
  id,ownerId:id,projectId:z.string().uuid(),workspaceRoot:z.string().trim().min(1).max(1024),requestedProfile:forgeExecutionProfileSchema,
  branch:z.string().trim().min(1).max(240),targetBranch:z.string().trim().min(1).max(240).default('main'),worktreeRoot:z.string().trim().min(1).max(1024),sourceBaselineSha:sha,scopes:forgeScopeSchema,knowledgeAllocation:z.number().int().min(0).max(8).optional(),
  skillSnapshots:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),correctionRoundId:id.optional(),
}).strict();
export const forgeIntegrationRunSchema=forgeIntegrationRunInputSchema.extend({
  knowledgeAllocation:forgeKnowledgeAllocationSchema.optional(),
  status:z.enum(['prepared','running','unknown_after_restart','completed','failed','interrupted']),effectiveProfile:forgeExecutionProfileSchema.optional(),
  threadId:id.optional(),turnId:id.optional(),createdAt:date,startedAt:date.optional(),completedAt:date.optional(),candidateId:id.optional(),failureReason:z.string().max(4000).optional(),reconciliation:forgeReconciliationSchema.optional(),
}).strict();
const forgeOrchestratorRunBaseSchema=z.object({
  id,ownerId:id,projectId:z.string().uuid(),workspaceRoot:z.string().trim().min(1).max(1024),requestedProfile:forgeExecutionProfileSchema,
  scopes:forgeScopeSchema,skillSnapshots:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),knowledgeAllocation:z.number().int().min(0).max(8).optional(),expectedPlanRevision:z.number().int().min(1),
}).strict();
const forgePlanningRunInputSchema=forgeOrchestratorRunBaseSchema.extend({purpose:z.literal('planning'),sourceBaselineSha:sha}).strict();
const forgeFinalReviewRunInputSchema=forgeOrchestratorRunBaseSchema.extend({purpose:z.literal('final_review'),candidateId:id,candidateSha:sha,targetMainSha:sha,targetBranch:z.string().trim().min(1).max(240).default('main')}).strict();
export const forgeOrchestratorRunInputSchema=z.discriminatedUnion('purpose',[forgePlanningRunInputSchema,forgeFinalReviewRunInputSchema]);
const forgeOrchestratorRunRuntimeFields={
  status:z.enum(['prepared','running','unknown_after_restart','completed','failed','interrupted']),effectiveProfile:forgeExecutionProfileSchema.optional(),
  threadId:id.optional(),turnId:id.optional(),createdAt:date,startedAt:date.optional(),completedAt:date.optional(),failureReason:z.string().max(4000).optional(),reconciliation:forgeReconciliationSchema.optional(),
};
export const forgeOrchestratorRunSchema=z.discriminatedUnion('purpose',[
  forgePlanningRunInputSchema.extend({...forgeOrchestratorRunRuntimeFields,knowledgeAllocation:forgeKnowledgeAllocationSchema.optional(),resultPlanId:id.optional()}),
  forgeFinalReviewRunInputSchema.extend({...forgeOrchestratorRunRuntimeFields,knowledgeAllocation:forgeKnowledgeAllocationSchema.optional(),resultReviewId:id.optional()}),
]);
export const forgeIntegrationCandidateSchema=z.object({
  id,integratorRunId:id,candidateSha:sha,targetMainSha:sha,targetBranch:z.string().trim().min(1).max(240).default('main'),workerCommits:z.array(forgeWorkerCommitSchema).min(1).max(MAX_FORGE_WORKITEMS),
  scopeValidation:z.object({status:z.enum(['passed','failed']),evidence:z.array(text).min(1).max(40)}).strict(),
  verification:z.array(forgeVerificationSchema).min(1).max(40),combinedReceipt:receiptSchema,provenance:forgeReceiptProvenanceSchema,
  findings:z.array(forgeIntegrationFindingSchema).max(40),createdAt:date,
}).strict();
const forgeCorrectionRoundSchema=z.object({
  id,index:z.number().int().min(1),source:z.enum(['integrator','final_review']),candidateId:id,requestedAt:date,requestedBy:id,
  findings:z.array(forgeCorrectionFindingSchema).min(1).max(40),
  items:z.array(z.object({taskId:id,findingIds:z.array(id).min(1).max(40),assignmentRevision:z.number().int().min(2)}).strict()).min(1).max(MAX_FORGE_WORKITEMS),
}).strict();
const forgeReviewDecisionSchema=z.object({
  id,candidateId:id,candidateSha:sha,targetMainSha:sha,targetBranch:z.string().trim().min(1).max(240).default('main'),disposition:z.enum(['accept','request_corrections','block']),note:z.string().max(4000),reviewedAt:date,reviewedBy:id,source:z.enum(['legacy','manual','model_run']).default('legacy'),runId:id.optional(),correctionRoundId:id.optional(),
}).strict();
const forgeMergeIntentSchema=z.object({candidateId:id,candidateSha:sha,targetMainSha:sha,targetBranch:z.string().trim().min(1).max(240).default('main'),startedAt:date,startedBy:id}).strict();
const forgeMergeReadbackSchema=z.object({
  id,candidateId:id,candidateSha:sha,targetMainSha:sha,targetBranch:z.string().trim().min(1).max(240).default('main'),preMergeMainSha:sha.optional(),result:z.enum(['merged','stale','failed']),observedMainSha:sha,
  mergeCommitSha:sha.optional(),commitReadbackSha:sha.optional(),detail:z.string().max(4000).optional(),recordedAt:date,
}).strict();
export const forgeIntegrationSchema=z.object({
  status:z.enum(['not_started','running','awaiting_correction','ready_for_review','blocked','merged']),
  runs:z.array(forgeIntegrationRunSchema).max(100),activeRunId:id.optional(),candidates:z.array(forgeIntegrationCandidateSchema).max(100),activeCandidateId:id.optional(),staleCandidateIds:z.array(id).max(100),supersededCandidateIds:z.array(id).max(100),
  correctionRounds:z.array(forgeCorrectionRoundSchema).max(10),reviewDecisions:z.array(forgeReviewDecisionSchema).max(100),
  mergeIntent:forgeMergeIntentSchema.optional(),mergeReadbacks:z.array(forgeMergeReadbackSchema).max(100),
}).strict();
export const forgeTicketPhaseSchema=z.enum(['draft','planning','planned','running','integrating','review','merge_ready','merging','blocked','paused','cancelled','complete']);
export const forgeTicketSchema=z.object({
  schemaVersion:z.literal(1),id,projectId:z.string().uuid(),workspaceRoot:z.string().trim().min(1).max(1024),
  title:z.string().trim().min(1).max(120),description:text,acceptanceCriteria:z.array(text).max(30),
  scope:forgeScopeSchema,orchestrator:z.object({model:z.string().trim().min(1).max(200),effort:forgeEffortSchema}).strict(),
  workerProfile:forgeExecutionProfileSchema,targetBranch:z.string().trim().min(1).max(240).default('main'),approvalPolicy:z.enum(['on-request','untrusted','never']).default('on-request'),orchestratorSkills:z.array(forgeSkillSnapshotSchema).max(MAX_FORGE_SKILL_SNAPSHOTS),limits:forgeLimitsSchema,capabilities:forgeCapabilitiesSchema,
  phase:forgeTicketPhaseSchema,planRevision:z.number().int().min(0),proposedPlan:forgePlanProposalSchema.optional(),acceptedPlan:forgeAcceptedPlanSchema.optional(),
  knowledgeBudget:forgeKnowledgeBudgetSchema.default(DEFAULT_FORGE_KNOWLEDGE_BUDGET),orchestratorRuns:z.array(forgeOrchestratorRunSchema).max(100).default([]),activeOrchestratorRunId:id.optional(),
  workitems:z.array(forgeWorkitemSchema).max(MAX_FORGE_WORKITEMS),attempts:z.array(forgeAttemptSchema).max(1000),receipts:z.array(forgeStoredReceiptSchema).max(1000),integration:forgeIntegrationSchema,
  createdAt:date,updatedAt:date,startedAt:date.optional(),pausedAt:date.optional(),pausedFromPhase:forgeTicketPhaseSchema.optional(),cancelledAt:date.optional(),completedAt:date.optional(),attentionReason:z.string().max(4000).optional(),
}).strict().superRefine((ticket,ctx)=>{
  if(new Set(ticket.orchestratorSkills.map(skill=>skill.id)).size!==ticket.orchestratorSkills.length)ctx.addIssue({code:'custom',path:['orchestratorSkills'],message:'Each orchestrator skill may be snapshotted only once.'});
  const workitemIds=new Set(ticket.workitems.map(row=>row.id));
  if(workitemIds.size!==ticket.workitems.length)ctx.addIssue({code:'custom',path:['workitems'],message:'Forge workitem IDs must be unique.'});
  if(ticket.acceptedPlan&&ticket.acceptedPlan.tasks.length!==ticket.workitems.length)ctx.addIssue({code:'custom',path:['workitems'],message:'Accepted plan and live workitems must have matching task counts.'});
  const fail=(path:(string|number)[],message:string)=>ctx.addIssue({code:'custom',path,message});
  if(ticket.knowledgeBudget.defaultAllocationOperations>ticket.knowledgeBudget.maxAllocationOperations)fail(['knowledgeBudget','defaultAllocationOperations'],'The default knowledge allocation cannot exceed the per-run maximum.');
  const savedAllocations=[
    ...ticket.attempts.flatMap(attempt=>attempt.knowledgeAllocation?[{allocation:attempt.knowledgeAllocation,ownerId:attempt.claim.ownerId,threadId:attempt.threadId,turnId:attempt.turnId,path:['attempts',attempt.id,'knowledgeAllocation'] as (string|number)[]}]:[]),
    ...ticket.integration.runs.flatMap(run=>run.knowledgeAllocation?[{allocation:run.knowledgeAllocation,ownerId:run.ownerId,threadId:run.threadId,turnId:run.turnId,path:['integration','runs',run.id,'knowledgeAllocation'] as (string|number)[]}]:[]),
    ...ticket.orchestratorRuns.flatMap(run=>run.knowledgeAllocation?[{allocation:run.knowledgeAllocation,ownerId:run.ownerId,threadId:run.threadId,turnId:run.turnId,path:['orchestratorRuns',run.id,'knowledgeAllocation'] as (string|number)[]}]:[]),
  ];
  const allocatedOperations=savedAllocations.reduce((sum,row)=>sum+row.allocation.operations,0);
  if(allocatedOperations>ticket.knowledgeBudget.totalOperations)fail(['knowledgeBudget'],'Saved Forge reservations cannot exceed the ticket knowledge budget.');
  for(const row of savedAllocations){
    if(row.allocation.operations>ticket.knowledgeBudget.maxAllocationOperations)fail(row.path,'A Forge run allocation cannot exceed the configured per-run maximum.');
    if(row.ownerId!==row.allocation.ownerId)fail(row.path,'A Forge run allocation must remain bound to its original agent.');
    if(row.allocation.usage&&(!row.threadId||!row.turnId||row.allocation.usage.threadId!==row.threadId||row.allocation.usage.turnId!==row.turnId))fail([...row.path,'usage'],'Knowledge usage must match the saved provider thread and turn.');
  }
  if(ticket.acceptedPlan){
    const plannedIds=new Set(ticket.acceptedPlan.tasks.map(task=>task.id));
    if(plannedIds.size!==ticket.acceptedPlan.tasks.length||plannedIds.size!==workitemIds.size||[...plannedIds].some(id=>!workitemIds.has(id)))fail(['acceptedPlan','tasks'],'Accepted plan IDs must uniquely match the live workitems.');
    const byId=new Map(ticket.acceptedPlan.tasks.map(task=>[task.id,task]));
    for(const task of ticket.acceptedPlan.tasks){
      if(new Set(task.dependencyIds).size!==task.dependencyIds.length||task.dependencyIds.some(id=>id===task.id||!byId.has(id)))fail(['acceptedPlan','tasks'],'Accepted plan dependencies must be unique and refer to other plan tasks.');
      if(new Set(task.assignment.skillSnapshots.map(skill=>skill.id)).size!==task.assignment.skillSnapshots.length)fail(['acceptedPlan','tasks'],'Each planned task may snapshot a skill revision only once.');
    }
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(id:string):boolean=>{
      if(visiting.has(id))return false;
      if(visited.has(id))return true;
      visiting.add(id);
      const valid=(byId.get(id)?.dependencyIds||[]).every(visit);
      visiting.delete(id);if(valid)visited.add(id);return valid;
    };
    if([...plannedIds].some(id=>!visit(id)))fail(['acceptedPlan','tasks'],'Accepted plan dependencies must form an acyclic graph.');
  }
  const attemptIds=new Set<string>(),claimIds=new Set<string>(),claimTokens=new Set<string>(),attemptById=new Map<string,typeof ticket.attempts[number]>();
  for(const attempt of ticket.attempts){
    const task=ticket.workitems.find(row=>row.id===attempt.taskId);
    if(attemptIds.has(attempt.id)||claimIds.has(attempt.claim.id)||claimTokens.has(attempt.claim.token))fail(['attempts'],'Forge attempt and claim identifiers must be unique.');
    attemptIds.add(attempt.id);claimIds.add(attempt.claim.id);claimTokens.add(attempt.claim.token);attemptById.set(attempt.id,attempt);
    if(!task||attempt.claim.attemptId!==attempt.id||attempt.assignmentRevision>task.assignmentRevision||!task.attemptIds.includes(attempt.id))fail(['attempts'],'Forge attempts must remain linked to their owning workitem and claim.');
    const liveAttempt=attempt.status==='claimed'||attempt.status==='unknown_after_restart'||attempt.status==='unknown_effect';
    if(((attempt.status==='finished'||attempt.status==='failed')&&(!attempt.outcomeId||!attempt.receiptId))||(liveAttempt||attempt.status==='preflight_failed'||attempt.status==='interrupted')&&(attempt.outcomeId!==undefined||attempt.receiptId!==undefined))fail(['attempts'],'Forge attempt outcome fields must agree with its persisted status.');
    if((!!attempt.threadId)!=(!!attempt.turnId)||attempt.startedAt&&!attempt.threadId)fail(['attempts'],'Observed worker turns require paired provider IDs.');
    if(attempt.status==='preflight_failed'&&(!attempt.preflightFailure||!attempt.failureReason||!attempt.completedAt||attempt.threadId||attempt.turnId||attempt.startedAt||attempt.commitSha))fail(['attempts'],'Pre-provider failures must retain evidence without provider IDs, a commit, or a worker receipt.');
    if(attempt.status!=='preflight_failed'&&attempt.preflightFailure)fail(['attempts'],'Pre-provider failure evidence belongs only to a preflight-failed attempt.');
    if(attempt.status==='preflight_failed'&&attempt.preflightFailure?.stage==='provider_start'&&!attempt.dispatchBaselineSha)fail(['attempts'],'Provider-start preflight failures require the persisted dispatch baseline.');
    if(attempt.status==='finished'&&(!attempt.commitSha||!attempt.completedAt))fail(['attempts'],'Finished Forge attempts require a commit SHA and completion time.');
    if((attempt.status==='failed'||attempt.status==='interrupted'||attempt.status==='preflight_failed')&&(!attempt.failureReason||!attempt.completedAt))fail(['attempts'],'Failed or interrupted Forge attempts require a reason and completion time.');
  }
  const orchestratorRunIds=new Set<string>(),orchestratorRunById=new Map<string,typeof ticket.orchestratorRuns[number]>();
  for(const run of ticket.orchestratorRuns){
    if(orchestratorRunIds.has(run.id)||run.projectId!==ticket.projectId||run.workspaceRoot!==ticket.workspaceRoot)fail(['orchestratorRuns'],'Forge orchestrator runs must be unique and bound to the ticket workspace.');
    orchestratorRunIds.add(run.id);orchestratorRunById.set(run.id,run);
    if((!!run.threadId)!==(!!run.turnId))fail(['orchestratorRuns'],'Orchestrator provider thread and turn provenance must be stored together.');
    if(run.effectiveProfile&&(!run.threadId||!run.turnId))fail(['orchestratorRuns'],'An effective orchestrator profile requires observed provider runtime provenance.');
    if(run.status==='running'&&(!run.threadId||!run.turnId||!run.startedAt))fail(['orchestratorRuns'],'Running orchestrator attempts require observed provider thread and turn IDs.');
    if((run.status==='failed'||run.status==='interrupted')&&(!run.failureReason||!run.completedAt))fail(['orchestratorRuns'],'Failed or interrupted orchestrator runs require a reason and completion time.');
    if(run.purpose==='planning'&&(run.status==='completed'?!run.resultPlanId:!!run.resultPlanId))fail(['orchestratorRuns'],'Planning result IDs must agree with the run status.');
    if(run.purpose==='final_review'&&(run.status==='completed'?!run.resultReviewId:!!run.resultReviewId))fail(['orchestratorRuns'],'Final-review result IDs must agree with the run status.');
    if(run.purpose==='final_review'){
      const candidate=ticket.integration.candidates.find(row=>row.id===run.candidateId);
      if(!candidate||candidate.candidateSha!==run.candidateSha||candidate.targetMainSha!==run.targetMainSha||candidate.targetBranch!==run.targetBranch||run.targetBranch!==ticket.targetBranch||run.expectedPlanRevision!==ticket.acceptedPlan?.revision)fail(['orchestratorRuns'],'Final-review runs must pin an existing candidate, target branch, target main SHA, and accepted plan revision.');
    }
  }
  const liveOrchestratorRuns=ticket.orchestratorRuns.filter(run=>['prepared','running','unknown_after_restart'].includes(run.status));
  if(liveOrchestratorRuns.length>1||liveOrchestratorRuns.some(run=>run.id!==ticket.activeOrchestratorRunId))fail(['orchestratorRuns'],'Every live orchestrator run must be the ticket active run, with at most one live run.');
  if(ticket.activeOrchestratorRunId&&!orchestratorRunById.has(ticket.activeOrchestratorRunId))fail(['activeOrchestratorRunId'],'The active orchestrator run must be saved.');
  if(ticket.activeOrchestratorRunId&&!['prepared','running','unknown_after_restart'].includes(orchestratorRunById.get(ticket.activeOrchestratorRunId)!.status))fail(['activeOrchestratorRunId'],'Only prepared, running, or unknown orchestrator runs may remain active.');
  if(ticket.proposedPlan?.source==='model_run'){
    const run=ticket.proposedPlan.runId?orchestratorRunById.get(ticket.proposedPlan.runId):undefined;
    if(!run||run.purpose!=='planning'||run.status!=='completed'||run.resultPlanId!==ticket.proposedPlan.id||run.expectedPlanRevision!==ticket.proposedPlan.revision)fail(['proposedPlan'],'Model-generated plans must be bound to their completed planning run and expected revision.');
  }else if(ticket.proposedPlan?.runId)fail(['proposedPlan','runId'],'Only a model-run proposal can reference a planning run.');
  if(ticket.acceptedPlan?.source==='model_run'){
    const run=ticket.acceptedPlan.runId?orchestratorRunById.get(ticket.acceptedPlan.runId):undefined;
    if(!run||run.purpose!=='planning'||run.status!=='completed'||run.resultPlanId!==ticket.acceptedPlan.id||run.expectedPlanRevision!==ticket.acceptedPlan.revision)fail(['acceptedPlan'],'Model-generated accepted plans must retain their completed planning run.');
  }else if(ticket.acceptedPlan?.runId)fail(['acceptedPlan','runId'],'Only a model-run plan can reference a planning run.');
  const integrationRunIds=new Set<string>(),integrationRunById=new Map<string,typeof ticket.integration.runs[number]>();
  for(const run of ticket.integration.runs){
    if(integrationRunIds.has(run.id)||run.projectId!==ticket.projectId||run.workspaceRoot!==ticket.workspaceRoot)fail(['integration','runs'],'Integrator runs must be uniquely identified and bound to the ticket workspace.');
    if(run.targetBranch!==ticket.targetBranch)fail(['integration','runs'],'Integrator runs must use the ticket pinned local target branch.');
    integrationRunIds.add(run.id);integrationRunById.set(run.id,run);
    if(run.correctionRoundId&&!ticket.integration.correctionRounds.some(round=>round.id===run.correctionRoundId))fail(['integration','runs'],'Integrator runs must reference a saved correction round.');
    if(run.status==='completed'&&!run.candidateId||run.status!=='completed'&&run.candidateId)fail(['integration','runs'],'Integrator candidate IDs must agree with the run status.');
    if((!!run.threadId)!==(!!run.turnId))fail(['integration','runs'],'Integrator provider thread and turn provenance must be stored together.');
    if(run.effectiveProfile&&(!run.threadId||!run.turnId))fail(['integration','runs'],'An effective integrator profile requires observed provider runtime provenance.');
    if(new Set(run.skillSnapshots.map(skill=>skill.id)).size!==run.skillSnapshots.length)fail(['integration','runs'],'Each integrator run may snapshot a skill revision only once.');
    if(run.status==='running'&&(!run.threadId||!run.turnId||!run.startedAt))fail(['integration','runs'],'Running integrator attempts require observed provider thread and turn IDs.');
    if((run.status==='failed'||run.status==='interrupted')&&(!run.failureReason||!run.completedAt))fail(['integration','runs'],'Failed or interrupted integrator runs require a reason and completion time.');
  }
  const liveIntegrationRuns=ticket.integration.runs.filter(run=>['prepared','running','unknown_after_restart'].includes(run.status));
  if(liveIntegrationRuns.length>1||liveIntegrationRuns.some(run=>run.id!==ticket.integration.activeRunId))fail(['integration','runs'],'Every live integrator run must be the ticket active run, with at most one live run.');
  if(ticket.integration.activeRunId&&!integrationRunById.has(ticket.integration.activeRunId))fail(['integration','activeRunId'],'The active integrator run must be saved.');
  if(ticket.integration.activeRunId){
    const run=integrationRunById.get(ticket.integration.activeRunId)!;
    if(!['prepared','running','unknown_after_restart'].includes(run.status))fail(['integration','activeRunId'],'Only prepared, running, or unknown integrator runs may remain active.');
  }
  if(ticket.integration.status==='running'&&!ticket.integration.activeRunId)fail(['integration','activeRunId'],'A running integration requires a prepared or active integrator run.');
  const candidateIds=new Set<string>(),candidateRunIds=new Set<string>();
  for(const candidate of ticket.integration.candidates){
    const run=integrationRunById.get(candidate.integratorRunId);
    if(candidateIds.has(candidate.id)||candidateRunIds.has(candidate.integratorRunId))fail(['integration','candidates'],'Integration candidate and run IDs must be unique.');
    candidateIds.add(candidate.id);candidateRunIds.add(candidate.integratorRunId);
    if(!run||run.status!=='completed'||run.candidateId!==candidate.id||run.targetBranch!==candidate.targetBranch||candidate.targetBranch!==ticket.targetBranch||run.threadId!==candidate.provenance.threadId||run.turnId!==candidate.provenance.turnId||candidate.provenance.producerRole!=='integrator')fail(['integration','candidates'],'Integration candidates must be linked to their completed integrator run, local target branch, and observed provenance.');
  }
  for(const task of ticket.workitems){
    const taskAttempts=ticket.attempts.filter(attempt=>attempt.taskId===task.id);
    if(new Set(task.attemptIds).size!==task.attemptIds.length||task.attemptIds.length!==taskAttempts.length||task.attemptIds.some(id=>!taskAttempts.some(attempt=>attempt.id===id)))fail(['workitems'],'Workitem attempt IDs must match its saved attempt history.');
    if(task.assignmentRevision!==1+task.correctionAssignments.length||task.correctionAssignments.some((assignment,index)=>assignment.revision!==index+2||assignment.source!=='correction'||new Set(assignment.skillSnapshots.map(skill=>skill.id)).size!==assignment.skillSnapshots.length))fail(['workitems'],'Correction assignments must have a continuous immutable revision history and unique skill snapshots.');
    const active=task.activeAttemptId?attemptById.get(task.activeAttemptId):undefined;
    const liveAttempts=taskAttempts.filter(attempt=>attempt.status==='claimed'||attempt.status==='unknown_after_restart'||attempt.status==='unknown_effect');
    if(liveAttempts.length>1||liveAttempts.some(attempt=>attempt.id!==task.activeAttemptId))fail(['workitems'],'Every live Forge attempt must be the workitem active attempt, with at most one live attempt.');
    if(task.activeAttemptId&&active?.taskId!==task.id)fail(['workitems'],'An active attempt must belong to the workitem.');
    if(task.state==='claimed'&&(!active||active.status!=='claimed'||task.blockedReason))fail(['workitems'],'Claimed workitems require exactly one live claimed attempt.');
    if(task.state!=='claimed'&&task.blockedReason?.kind==='execution_issue'&&task.blockedReason.code==='unknown_after_restart'&&(!active||active.status!=='unknown_after_restart')||task.state!=='claimed'&&task.blockedReason?.kind==='execution_issue'&&task.blockedReason.code==='unknown_effect'&&(!active||active.status!=='unknown_effect'))fail(['workitems'],'Unknown workitem blocks must retain their original attempt.');
    if(task.activeAttemptId&&task.state!=='claimed'&&!(task.state==='blocked'&&task.blockedReason?.kind==='execution_issue'&&['unknown_after_restart','unknown_effect'].includes(task.blockedReason.code)))fail(['workitems'],'Only claimed or unknown-effect workitems may retain an active attempt.');
    if(task.state==='finished'){
      const finished=taskAttempts.find(attempt=>attempt.assignmentRevision===task.assignmentRevision&&attempt.status==='finished');
      const receipt=finished&&ticket.receipts.find(row=>row.id===finished.receiptId&&row.attemptId===finished.id);
      if(task.activeAttemptId||!finished||!receipt||receipt.receipt.status!=='complete'||receipt.receipt.acceptance.unmet.length||receipt.hostAttestation?.status!=='verified'||receipt.hostAttestation.scopeValidation!=='passed'||receipt.hostAttestation.commitSha!==finished.commitSha)fail(['workitems'],'Finished workitems require a saved complete receipt and matching host-attested commit.');
    }
  }
  const receiptIds=new Set<string>(),receiptAttempts=new Set<string>();
  for(const saved of ticket.receipts){
    const attempt=attemptById.get(saved.attemptId);
    if(receiptIds.has(saved.id)||receiptAttempts.has(saved.attemptId)||!attempt||attempt.receiptId!==saved.id||attempt.outcomeId!==saved.outcomeId||saved.provenance.producerRole!=='worker'||saved.provenance.workerId!==attempt.claim.ownerId||saved.provenance.threadId!==attempt.threadId||saved.provenance.turnId!==attempt.turnId)fail(['receipts'],'Saved Forge receipts must be unique and bound to their original attempt provenance.');
    receiptIds.add(saved.id);receiptAttempts.add(saved.attemptId);
    if(attempt?.status==='finished'&&(!saved.hostAttestation||saved.hostAttestation.status!=='verified'||!saved.hostAttestation.commitObserved||saved.hostAttestation.scopeValidation!=='passed'||saved.hostAttestation.commitSha!==attempt.commitSha))fail(['receipts'],'Finished attempts require matching verified host commit evidence.');
  }
  for(const attempt of ticket.attempts){
    if((attempt.outcomeId||attempt.receiptId)&&!ticket.receipts.some(saved=>saved.attemptId===attempt.id&&saved.id===attempt.receiptId&&saved.outcomeId===attempt.outcomeId))fail(['attempts'],'Recorded attempt outcomes must retain their saved receipt.');
  }
  if(ticket.integration.activeCandidateId&&!ticket.integration.candidates.some(candidate=>candidate.id===ticket.integration.activeCandidateId))fail(['integration','activeCandidateId'],'The active integration candidate must be saved.');
  for(const decision of ticket.integration.reviewDecisions){
    const candidate=ticket.integration.candidates.find(row=>row.id===decision.candidateId);
    if(!candidate||decision.targetBranch!==candidate.targetBranch||decision.targetBranch!==ticket.targetBranch)fail(['integration','reviewDecisions'],'Review decisions must retain the candidate local target branch.');
    if(decision.source==='model_run'){
      const run=decision.runId?orchestratorRunById.get(decision.runId):undefined;
      if(!run||run.purpose!=='final_review'||run.status!=='completed'||run.resultReviewId!==decision.id||run.candidateId!==decision.candidateId||run.candidateSha!==decision.candidateSha||run.targetMainSha!==decision.targetMainSha||run.targetBranch!==decision.targetBranch)fail(['integration','reviewDecisions'],'Model final-review decisions must be bound to their completed candidate-specific run and target branch.');
    }else if(decision.runId)fail(['integration','reviewDecisions'],'Only model-run decisions may reference an orchestrator run.');
  }
  for(const run of ticket.orchestratorRuns){
    if(run.purpose==='final_review'&&run.status==='completed'&&!ticket.integration.reviewDecisions.some(decision=>decision.id===run.resultReviewId&&decision.runId===run.id))fail(['orchestratorRuns'],'Completed final-review runs must retain their review decision.');
  }
  if(ticket.integration.mergeIntent&&(ticket.integration.mergeIntent.targetBranch!==ticket.targetBranch||!ticket.integration.candidates.some(candidate=>candidate.id===ticket.integration.mergeIntent!.candidateId&&candidate.targetBranch===ticket.integration.mergeIntent!.targetBranch)))fail(['integration','mergeIntent'],'Merge intent must retain the candidate local target branch.');
  for(const readback of ticket.integration.mergeReadbacks){
    if(readback.targetBranch!==ticket.targetBranch||!ticket.integration.candidates.some(candidate=>candidate.id===readback.candidateId&&candidate.targetBranch===readback.targetBranch))fail(['integration','mergeReadbacks'],'Merge readbacks must retain the candidate local target branch.');
  }
  if(ticket.phase==='merging'&&!ticket.integration.mergeIntent||ticket.integration.mergeIntent&&!['merging','paused','cancelled','blocked'].includes(ticket.phase))fail(['integration','mergeIntent'],'A durable merge intent must remain in an active or recoverable merge phase.');
  if(ticket.phase==='complete'&&(!ticket.integration.mergeReadbacks.some(readback=>readback.result==='merged'&&readback.commitReadbackSha===readback.mergeCommitSha&&readback.observedMainSha===readback.mergeCommitSha&&ticket.integration.candidates.some(candidate=>candidate.id===readback.candidateId&&candidate.candidateSha===readback.candidateSha&&candidate.targetMainSha===readback.targetMainSha&&candidate.targetBranch===readback.targetBranch))||ticket.integration.status!=='merged'))fail(['phase'],'A complete Forge ticket requires an actual matching merge readback.');
  if(ticket.integration.status==='merged'&&ticket.phase!=='complete')fail(['integration','status'],'A merged Forge integration must correspond to a completed ticket.');
});

export type ForgeActor=z.infer<typeof forgeActorSchema>;
export type ForgeEffort=z.infer<typeof forgeEffortSchema>;
export type ForgeExecutionProfile=z.infer<typeof forgeExecutionProfileSchema>;
export type ForgeLimits=z.infer<typeof forgeLimitsSchema>;
export type ForgeKnowledgeBudget=z.infer<typeof forgeKnowledgeBudgetSchema>;
export type ForgeScope=z.infer<typeof forgeScopeSchema>;
export type ForgeCapabilities=z.infer<typeof forgeCapabilitiesSchema>;
export type ForgeVisibleTaskState=z.infer<typeof forgeVisibleTaskStateSchema>;
export type ForgeTicketPhase=z.infer<typeof forgeTicketPhaseSchema>;
export type ForgeSkillSnapshot=z.infer<typeof forgeSkillSnapshotSchema>;
export function mergeForgeSkillSnapshots(...groups:ReadonlyArray<readonly ForgeSkillSnapshot[]>):ForgeSkillSnapshot[]{
  const byId=new Map<string,ForgeSkillSnapshot>();
  for(const raw of groups.flat()){
    const snapshot=forgeSkillSnapshotSchema.parse(raw),existing=byId.get(snapshot.id);
    if(existing){
      if(existing.revision!==snapshot.revision)throw new Error(`Forge skill ${snapshot.id} has conflicting immutable revisions.`);
      const sameFiles=existing.files.length===snapshot.files.length&&existing.files.every((file,index)=>file.path===snapshot.files[index]?.path&&file.size===snapshot.files[index]?.size);
      if(existing.name!==snapshot.name||existing.description!==snapshot.description||existing.source!==snapshot.source||existing.instructions!==snapshot.instructions||!sameFiles)throw new Error(`Forge skill ${snapshot.id} revision ${snapshot.revision} has conflicting snapshots.`);
      continue;
    }
    byId.set(snapshot.id,structuredClone(snapshot));
  }
  if(byId.size>MAX_FORGE_SKILL_SNAPSHOTS)throw new Error(`Forge internal skill snapshots may contain at most ${MAX_FORGE_SKILL_SNAPSHOTS} unique revisions.`);
  return [...byId.values()];
}
export type ForgeReceiptProvenance=z.infer<typeof forgeReceiptProvenanceSchema>;
export type ForgeAssignmentSnapshotInput=z.infer<typeof forgeAssignmentSnapshotInputSchema>;
export type ForgePlanTaskInput=z.infer<typeof forgePlanTaskInputSchema>;
export type ForgeAssignmentSnapshot=z.infer<typeof forgeAssignmentSnapshotSchema>;
export type ForgePlanItem=z.infer<typeof forgePlanItemSchema>;
export type ForgePlanProposal=z.infer<typeof forgePlanProposalSchema>;
export type ForgeAcceptedPlan=z.infer<typeof forgeAcceptedPlanSchema>;
export type ForgePlan=ForgeAcceptedPlan;
export type ForgeReconciliation=z.infer<typeof forgeReconciliationSchema>;
export type ForgePreflightFailure=z.infer<typeof forgePreflightFailureSchema>;
export type ForgeKnowledgeUsage=z.infer<typeof forgeKnowledgeUsageSchema>;
export type ForgeKnowledgeAllocation=z.infer<typeof forgeKnowledgeAllocationSchema>;
export type ForgeBlockReason=z.infer<typeof forgeBlockReasonSchema>;
export type ForgeWorkitem=z.infer<typeof forgeWorkitemSchema>;
export type ForgeClaim=z.infer<typeof forgeClaimSchema>;
export type ForgeAttempt=z.infer<typeof forgeAttemptSchema>;
export type ForgeHostAttestation=z.infer<typeof forgeHostAttestationSchema>;
export type ForgeStoredReceipt=z.infer<typeof forgeStoredReceiptSchema>;
export type ForgeReceipt=ForgeStoredReceipt;
export type ForgeVerification=z.infer<typeof forgeVerificationSchema>;
export type ForgeIntegrationCandidate=z.infer<typeof forgeIntegrationCandidateSchema>;
export type ForgeIntegrationRunInput=z.infer<typeof forgeIntegrationRunInputSchema>;
export type ForgeIntegrationRun=z.infer<typeof forgeIntegrationRunSchema>;
export type ForgeIntegratorRunInput=ForgeIntegrationRunInput;
export type ForgeIntegratorRun=ForgeIntegrationRun;
export type ForgeOrchestratorRunInput=z.infer<typeof forgeOrchestratorRunInputSchema>;
export type ForgeOrchestratorRun=z.infer<typeof forgeOrchestratorRunSchema>;
export type ForgeIntegrationFinding=z.infer<typeof forgeIntegrationFindingSchema>;
export type ForgeCorrectionFinding=z.infer<typeof forgeCorrectionFindingSchema>;
export type ForgeCorrectionRound=z.infer<typeof forgeCorrectionRoundSchema>;
export type ForgeReviewDecision=z.infer<typeof forgeReviewDecisionSchema>;
export type ForgeMergeIntent=z.infer<typeof forgeMergeIntentSchema>;
export type ForgeMergeReadback=z.infer<typeof forgeMergeReadbackSchema>;
export type ForgeIntegration=z.infer<typeof forgeIntegrationSchema>;
export type ForgeTicket=z.infer<typeof forgeTicketSchema>;
export type ForgeApprovalPolicy=Extract<ApprovalPolicy,'on-request'|'untrusted'|'never'>;

export type ForgeTicketCreateInput={
  id:string;projectId:string;workspaceRoot:string;title:string;description:string;acceptanceCriteria:string[];
  scope:z.infer<typeof forgeScopeSchema>;orchestrator:{model:string;effort:z.infer<typeof forgeEffortSchema>};
  workerProfile:z.infer<typeof forgeExecutionProfileSchema>;orchestratorSkills:ForgeSkillSnapshot[];targetBranch?:string;approvalPolicy?:ApprovalPolicy;
  limits?:Partial<z.infer<typeof forgeLimitsSchema>>;knowledgeBudget?:Partial<ForgeKnowledgeBudget>;
  capabilities:Omit<z.infer<typeof forgeCapabilitiesSchema>,'operationBudget'>&{operationBudget?:'enforced'|'monitored'|'instruction-only'|'unavailable'};createdAt:string;
};

export type ForgeCommand=
  | {type:'submit_manual_plan';actor:ForgeActor;planId:string;tasks:ForgePlanTaskInput[]}
  | {type:'begin_orchestrator_run';actor:ForgeActor;run:ForgeOrchestratorRunInput}
  | {type:'record_orchestrator_runtime';actor:ForgeActor;runId:string;threadId:string;turnId:string;effectiveProfile?:ForgeExecutionProfile}
  | {type:'fail_orchestrator_run';actor:ForgeActor;runId:string;failureReason:string}
  | {type:'reconcile_orchestrator_run';actor:ForgeActor;runId:string;status:'still_running';threadId:string;turnId:string;effectiveProfile?:ForgeExecutionProfile;evidence:string}
  | {type:'reconcile_orchestrator_run';actor:ForgeActor;runId:string;status:'stopped';evidence:string}
  | {type:'complete_planning';actor:ForgeActor;runId:string;expectedPlanRevision:number;threadId:string;turnId:string;planId:string;tasks:ForgePlanTaskInput[]}
  | {type:'complete_candidate_review';actor:ForgeActor;runId:string;expectedPlanRevision:number;threadId:string;turnId:string;candidateId:string;candidateSha:string;targetMainSha:string;targetBranch:string;disposition:'accept'|'request_corrections'|'block';note:string;correctionId?:string;corrections?:{taskId:string;findings:{id:string;title:string;issue:string;requiredFix:string;evidence:string[]}[];assignment:ForgeAssignmentSnapshotInput}[]}
  | {type:'record_knowledge_usage';actor:ForgeActor;targetType:'planning'|'final_review'|'worker_attempt'|'integration';targetId:string;operations:number;source:'agent_reported'|'runtime_observed';threadId:string;turnId:string;evidence:string}
  | {type:'submit_manual_candidate_review';actor:ForgeActor;candidateSha:string;targetMainSha:string;targetBranch:string;disposition:'accept'|'request_corrections'|'block';note:string;correctionId?:string;corrections?:{taskId:string;findings:{id:string;title:string;issue:string;requiredFix:string;evidence:string[]}[];assignment:ForgeAssignmentSnapshotInput}[]}
  | {type:'accept_plan';actor:ForgeActor;revision:number}
  | {type:'start';actor:ForgeActor}
  | {type:'claim_task';actor:ForgeActor;taskId:string;ownerId:string;claimId:string;attemptId:string;claimToken:string;runtimeId:string;branch:string;worktreeRoot:string;sourceBaselineSha:string;knowledgeAllocation?:number;expiresAt?:string}
  | {type:'record_attempt_dispatch_baseline';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;dispatchBaselineSha:string}
  | {type:'record_attempt_runtime';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;threadId:string;turnId:string}
  | {type:'fail_attempt_preflight';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;stage:'dependency_merge'|'workspace_prepare';failureReason:string;evidence:string[]}
  | {type:'fail_attempt_preflight';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;stage:'provider_start';effect:'confirmed_not_started';failureReason:string;evidence:string[]}
  | {type:'mark_attempt_effect_uncertain';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;evidence:string}
  | {type:'accept_worker_outcome';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;outcomeId:string;receiptId:string;receipt:Receipt;provenance:ForgeReceiptProvenance;hostAttestation?:ForgeHostAttestation;retryable:boolean;failureReason?:string}
  | {type:'recover_after_restart';actor:ForgeActor}
  | {type:'reconcile_attempt';actor:ForgeActor;taskId:string;ownerId:string;attemptId:string;claimToken:string;status:'still_running'|'stopped';threadId?:string;turnId?:string;evidence:string}
  | {type:'pause';actor:ForgeActor}
  | {type:'resume';actor:ForgeActor}
  | {type:'cancel';actor:ForgeActor}
  | {type:'begin_integration';actor:ForgeActor;run:ForgeIntegrationRunInput}
  | {type:'record_integration_runtime';actor:ForgeActor;runId:string;threadId:string;turnId:string;effectiveProfile?:ForgeExecutionProfile}
  | {type:'fail_integration_run';actor:ForgeActor;runId:string;failureReason:string}
  | {type:'reconcile_integration_run';actor:ForgeActor;runId:string;status:'still_running';threadId:string;turnId:string;effectiveProfile?:ForgeExecutionProfile;evidence:string}
  | {type:'reconcile_integration_run';actor:ForgeActor;runId:string;status:'stopped';evidence:string}
  | {type:'record_integration_candidate';actor:ForgeActor;candidate:ForgeIntegrationCandidate}
  | {type:'request_corrections';actor:ForgeActor;correctionId:string;items:{taskId:string;findingIds:string[];assignment:ForgeAssignmentSnapshotInput}[]}
  | {type:'begin_merge';actor:ForgeActor;candidateSha:string;targetMainSha:string;targetBranch:string;observedMainSha:string}
  | {type:'record_merge_readback';actor:ForgeActor;result:'merged'|'stale'|'failed';candidateSha:string;targetMainSha:string;targetBranch:string;preMergeMainSha?:string;observedMainSha:string;mergeCommitSha?:string;commitReadbackSha?:string;detail?:string};
