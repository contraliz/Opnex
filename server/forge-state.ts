import {
  forgeAssignmentSnapshotInputSchema,
  forgeIntegrationCandidateSchema,
  forgeIntegrationRunInputSchema,
  forgeOrchestratorRunInputSchema,
  forgePlanTaskInputSchema,
  forgeHostAttestationSchema,
  mergeForgeSkillSnapshots,
  forgeReceiptProvenanceSchema,
  forgeKnowledgeUsageSchema,
  forgeStoredReceiptSchema,
  forgeTicketSchema,
  type ForgeAcceptedPlan,
  type ForgeAttempt,
  type ForgeActor,
  type ForgeCommand,
  type ForgeHostAttestation,
  type ForgeIntegrationCandidate,
  type ForgeIntegrationRun,
  type ForgeIntegration,
  type ForgeKnowledgeAllocation,
  type ForgeKnowledgeUsage,
  type ForgeOrchestratorRun,
  type ForgePlanTaskInput,
  type ForgeReviewDecision,
  type ForgeStoredReceipt,
  type ForgeTicket,
  type ForgeTicketCreateInput,
} from './forge-contracts.js';
import { DEFAULT_FORGE_KNOWLEDGE_BUDGET, DEFAULT_FORGE_LIMITS, MAX_FORGE_WORKITEMS } from './contracts.js';

function requireActor(actor:ForgeActor,...roles:ForgeActor['role'][]){
  if(!roles.includes(actor.role))throw new Error(`A ${roles.join(' or ')} actor is required for this Forge command.`);
}
function validTime(value:string){if(!Number.isFinite(Date.parse(value)))throw new Error('Forge transitions require a valid timestamp.');}
function canonicalScopePath(value:string){
  const normalized=value.trim().replaceAll('\\','/').replace(/\/{2,}/g,'/');
  const prefix=normalized.startsWith('/')?'/':normalized.match(/^[a-z]:/i)?.[0]||'';
  const remainder=normalized.slice(prefix.length);
  const absoluteDrive=!!prefix&&prefix!=='/'&&remainder.startsWith('/');
  const body=remainder.split('/').filter(part=>part&&part!=='.').join('/');
  return `${prefix}${absoluteDrive&&body?'/':''}${body}`.toLocaleLowerCase('en-US');
}
function scopePathIsSafe(value:string){return !!value.trim()&&!value.includes('\0')&&!/^[a-z]:[^/]/i.test(value.trim().replaceAll('\\','/'))&&!canonicalScopePath(value).split('/').includes('..');}
function isWithinScope(value:string,allowed:string[]){
  if(!scopePathIsSafe(value))return false;
  const candidate=canonicalScopePath(value);
  return allowed.some(root=>{
    if(!scopePathIsSafe(root))return false;
    const base=canonicalScopePath(root);
    if(!base)return !candidate.startsWith('/')&&!/^[a-z]:\//i.test(candidate);
    return candidate===base||candidate.startsWith(base.endsWith('/')?base:`${base}/`);
  });
}
function validatePlan(ticket:ForgeTicket,tasks:ForgePlanTaskInput[]){
  if(tasks.length>MAX_FORGE_WORKITEMS)throw new Error(`A Forge plan may contain at most ${MAX_FORGE_WORKITEMS} work items in v1.`);
  const ids=new Set(tasks.map(task=>task.id));
  if(ids.size!==tasks.length)throw new Error('Forge plan task IDs must be unique.');
  for(const task of tasks){
    const dependencies=new Set(task.dependencyIds);
    if(dependencies.size!==task.dependencyIds.length)throw new Error(`Forge task ${task.id} has duplicate dependencies.`);
    if(task.dependencyIds.some(dependency=>dependency===task.id||!ids.has(dependency)))throw new Error(`Forge task ${task.id} has a missing or self dependency.`);
    if(task.executionProfile.provider!==ticket.workerProfile.provider||task.executionProfile.model!==ticket.workerProfile.model||task.executionProfile.effort!==ticket.workerProfile.effort)
      throw new Error(`Forge task ${task.id} must use the worker provider, model, and effort selected for this ticket.`);
    if(new Set(task.skillSnapshots.map(skill=>skill.id)).size!==task.skillSnapshots.length)throw new Error(`Forge task ${task.id} cannot snapshot one skill more than once.`);
    if(!task.assignment.read_scope.every(path=>isWithinScope(path,[...ticket.scope.read,...ticket.scope.write]))||
      !task.assignment.write_scope.every(path=>isWithinScope(path,ticket.scope.write))||
      !task.knowledgeScope.every(path=>isWithinScope(path,ticket.scope.knowledge)))
      throw new Error(`Forge task ${task.id} exceeds the ticket's approved scope.`);
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(taskId:string):boolean=>{
    if(visiting.has(taskId))return false;
    if(visited.has(taskId))return true;
    visiting.add(taskId);
    const acyclic=tasks.find(task=>task.id===taskId)!.dependencyIds.every(visit);
    visiting.delete(taskId);
    if(acyclic)visited.add(taskId);
    return acyclic;
  };
  if(!tasks.every(task=>visit(task.id)))throw new Error('Forge plan dependencies must form an acyclic graph.');
}
function refreshDependencyStates(ticket:ForgeTicket,now:string){
  const finished=new Set(ticket.workitems.filter(task=>task.state==='finished').map(task=>task.id));
  for(const task of ticket.workitems){
    if(task.state==='finished'||task.state==='claimed')continue;
    const planTask=ticket.acceptedPlan?.tasks.find(row=>row.id===task.id);
    if(!planTask)continue;
    const unmet=planTask.dependencyIds.filter(id=>!finished.has(id));
    if(unmet.length){
      task.state='blocked';task.blockedReason={kind:'dependencies',taskIds:unmet};task.updatedAt=now;
    }else if(task.state==='blocked'&&task.blockedReason?.kind==='dependencies'){
      task.state='open';delete task.blockedReason;task.updatedAt=now;
    }
  }
}
function workitemFor(ticket:ForgeTicket,taskId:string){
  const task=ticket.workitems.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge task not found.');
  return task;
}
function taskPlanFor(ticket:ForgeTicket,taskId:string){
  const task=ticket.acceptedPlan?.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge plan task not found.');
  return task;
}
function activeCount(ticket:ForgeTicket){return ticket.attempts.filter(attempt=>attempt.status==='claimed'||attempt.status==='unknown_after_restart').length;}
function requireClaim(attempt:ForgeAttempt,command:{ownerId:string;claimToken:string;attemptId:string}){
  if(attempt.id!==command.attemptId||attempt.claim.ownerId!==command.ownerId||attempt.claim.token!==command.claimToken)
    throw new Error('This Forge result does not match the active claim owner and token.');
}
function updateTicketPhaseAfterOutcome(ticket:ForgeTicket,now:string){
  if(ticket.phase==='paused'||ticket.phase==='cancelled'||ticket.phase==='complete'){ticket.updatedAt=now;return;}
  if(ticket.workitems.length&&ticket.workitems.every(task=>task.state==='finished')){
    ticket.phase='integrating';ticket.integration.status='not_started';delete ticket.attentionReason;ticket.updatedAt=now;return;
  }
  if(ticket.workitems.some(task=>task.state==='open'||task.state==='claimed')){
    if(ticket.phase==='blocked')ticket.phase='running';delete ticket.attentionReason;ticket.updatedAt=now;return;
  }
  if(ticket.workitems.some(task=>task.state==='blocked')){
    ticket.phase='blocked';ticket.attentionReason='All remaining Forge tasks are blocked. Reconcile or correct the recorded task issues.';ticket.updatedAt=now;
  }
}

export function createForgeTicket(input:ForgeTicketCreateInput):ForgeTicket{
  if(Object.values(input.scope).some(paths=>paths.some(path=>!scopePathIsSafe(path))))throw new Error('Forge ticket scopes must use safe relative or absolute paths without traversal.');
  const {limits,knowledgeBudget,...fields}=structuredClone(input);
  const ticket:ForgeTicket={
    schemaVersion:1,...fields,orchestratorSkills:mergeForgeSkillSnapshots(input.orchestratorSkills),capabilities:{...fields.capabilities,operationBudget:fields.capabilities.operationBudget??'instruction-only'},limits:{...DEFAULT_FORGE_LIMITS,...limits},knowledgeBudget:{...DEFAULT_FORGE_KNOWLEDGE_BUDGET,...knowledgeBudget},updatedAt:input.createdAt,phase:'draft',planRevision:0,orchestratorRuns:[],workitems:[],attempts:[],receipts:[],
    integration:{status:'not_started',runs:[],candidates:[],staleCandidateIds:[],supersededCandidateIds:[],correctionRounds:[],reviewDecisions:[],mergeReadbacks:[]},
  };
  return forgeTicketSchema.parse(ticket);
}

function allocatedKnowledgeOperations(ticket:ForgeTicket){
  return [
    ...ticket.attempts.map(attempt=>attempt.knowledgeAllocation?.operations||0),
    ...ticket.integration.runs.map(run=>run.knowledgeAllocation?.operations||0),
    ...ticket.orchestratorRuns.map(run=>run.knowledgeAllocation?.operations||0),
  ].reduce((sum,operations)=>sum+operations,0);
}
export function forgeKnowledgeBudgetBalance(ticket:ForgeTicket){
  const allocatedOperations=allocatedKnowledgeOperations(ticket);
  return {totalOperations:ticket.knowledgeBudget.totalOperations,allocatedOperations,remainingOperations:ticket.knowledgeBudget.totalOperations-allocatedOperations};
}
function reserveKnowledgeAllocation(ticket:ForgeTicket,ownerId:string,reservedBy:string,requestedOperations:number|undefined,now:string):ForgeKnowledgeAllocation{
  const operations=requestedOperations??ticket.knowledgeBudget.defaultAllocationOperations;
  if(!Number.isSafeInteger(operations)||operations<0||operations>ticket.knowledgeBudget.maxAllocationOperations)throw new Error('A Forge knowledge allocation must be a finite nonnegative amount within the configured per-run maximum.');
  if(allocatedKnowledgeOperations(ticket)+operations>ticket.knowledgeBudget.totalOperations)throw new Error('The shared Forge knowledge budget has insufficient unallocated operations.');
  return {operations,ownerId,reservedBy,reservedAt:now,status:'reserved'};
}
function recordKnowledgeUsage(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_knowledge_usage'}>,now:string){
  requireActor(command.actor,'host');
  let allocation:ForgeKnowledgeAllocation|undefined,ownerId:string|undefined,threadId:string|undefined,turnId:string|undefined;
  if(command.targetType==='planning'||command.targetType==='final_review'){
    const run=ticket.orchestratorRuns.find(row=>row.id===command.targetId&&row.purpose===command.targetType);
    allocation=run?.knowledgeAllocation;ownerId=run?.ownerId;threadId=run?.threadId;turnId=run?.turnId;
  }else if(command.targetType==='worker_attempt'){
    const attempt=ticket.attempts.find(row=>row.id===command.targetId);
    allocation=attempt?.knowledgeAllocation;ownerId=attempt?.claim.ownerId;threadId=attempt?.threadId;turnId=attempt?.turnId;
  }else{
    const run=ticket.integration.runs.find(row=>row.id===command.targetId);
    allocation=run?.knowledgeAllocation;ownerId=run?.ownerId;threadId=run?.threadId;turnId=run?.turnId;
  }
  if(!allocation||!ownerId)throw new Error('This Forge knowledge report does not match a saved allocated run or attempt.');
  const usage:ForgeKnowledgeUsage=forgeKnowledgeUsageSchema.parse({operations:command.operations,source:command.source,ownerId,recordedBy:command.actor.id,threadId:command.threadId,turnId:command.turnId,recordedAt:now,evidence:command.evidence});
  if(!threadId||!turnId||threadId!==usage.threadId||turnId!==usage.turnId)throw new Error('Forge knowledge usage must match the exact observed provider thread and turn for its run or attempt.');
  if(allocation.usage){
    if(JSON.stringify(allocation.usage)===JSON.stringify(usage))return;
    throw new Error('A Forge run or attempt already has a different knowledge usage report.');
  }
  allocation.usage=usage;allocation.status='reported';ticket.updatedAt=now;
}

function recordPlanProposal(ticket:ForgeTicket,actor:ForgeActor,planId:string,rawTasks:ForgePlanTaskInput[],source:'manual'|'model_run',runId:string|undefined,revision:number,now:string){
  if(ticket.acceptedPlan||ticket.phase==='cancelled'||ticket.phase==='complete')throw new Error('The Forge plan can no longer be changed.');
  if(rawTasks.length>MAX_FORGE_WORKITEMS)throw new Error(`A Forge plan may contain at most ${MAX_FORGE_WORKITEMS} work items in v1.`);
  const tasks=rawTasks.map(task=>forgePlanTaskInputSchema.parse({...task,skillSnapshots:mergeForgeSkillSnapshots(task.skillSnapshots)}));
  validatePlan(ticket,tasks);
  const proposal={
    id:planId,revision,proposedAt:now,proposedBy:actor.id,source,...(runId?{runId}:{}),
    tasks:tasks.map(task=>({
      id:task.id,title:task.title,description:task.description,dependencyIds:[...task.dependencyIds],
      assignment:{assignment:structuredClone(task.assignment),executionProfile:structuredClone(task.executionProfile),skillSnapshots:structuredClone(task.skillSnapshots),knowledgeScope:[...task.knowledgeScope],revision:1,source:'plan' as const,createdAt:now},
    })),
  };
  const existing=ticket.proposedPlan;
  if(existing?.id===proposal.id){
    const {revision:_revision,proposedAt:_proposedAt,proposedBy:_proposedBy,...before}=existing;
    const {revision:_nextRevision,proposedAt:_nextAt,proposedBy:_nextBy,...after}=proposal;
    if(JSON.stringify(before)===JSON.stringify(after))return;
    throw new Error('A Forge plan ID cannot be reused for different content.');
  }
  ticket.planRevision=proposal.revision;ticket.proposedPlan=proposal;ticket.phase='planning';ticket.updatedAt=now;
}
function submitManualPlan(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'submit_manual_plan'}>,now:string){
  requireActor(command.actor,'user');
  if(ticket.acceptedPlan)throw new Error('The accepted Forge plan is immutable.');
  if(ticket.orchestratorRuns.some(run=>run.purpose==='planning'))throw new Error('A manual plan cannot bypass a prior model planning attempt.');
  if(ticket.activeOrchestratorRunId)throw new Error('Reconcile the active model run before submitting a manual plan.');
  if(!['draft','planning'].includes(ticket.phase))throw new Error('Manual planning is only available before Forge execution starts.');
  recordPlanProposal(ticket,command.actor,command.planId,command.tasks,'manual',undefined,ticket.planRevision+1,now);
}
function beginOrchestratorRun(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'begin_orchestrator_run'}>,now:string){
  requireActor(command.actor,'host');
  const input=forgeOrchestratorRunInputSchema.parse({...command.run,skillSnapshots:mergeForgeSkillSnapshots(command.run.skillSnapshots)});
  const previous=ticket.orchestratorRuns.find(run=>run.id===input.id);
  if(previous){
    if(ticket.activeOrchestratorRunId===previous.id&&previous.status==='unknown_after_restart')throw new Error('Reconcile the unknown orchestrator run before dispatching another model call.');
    throw new Error('This Forge orchestrator run ID already exists; do not replay its model effect.');
  }
  if(ticket.activeOrchestratorRunId)throw new Error('Reconcile the active Forge orchestrator run before starting another model call.');
  if(input.projectId!==ticket.projectId||input.workspaceRoot!==ticket.workspaceRoot)throw new Error('The orchestrator run must use the ticket workspace identity and root.');
  if(input.scopes.write.length||!input.scopes.read.every(path=>isWithinScope(path,[...ticket.scope.read,...ticket.scope.write]))||!input.scopes.knowledge.every(path=>isWithinScope(path,ticket.scope.knowledge)))throw new Error('The orchestrator run must stay within the ticket read and knowledge scopes and cannot write workspace files.');
  if(new Set(input.skillSnapshots.map(skill=>skill.id)).size!==input.skillSnapshots.length)throw new Error('An orchestrator run cannot snapshot one skill revision more than once.');
  if(input.purpose==='planning'){
    if(ticket.acceptedPlan||!['draft','planning'].includes(ticket.phase)||input.expectedPlanRevision!==ticket.planRevision+1)throw new Error('The planning run must target the next unaccepted plan revision.');
    if(ticket.orchestratorRuns.filter(run=>run.purpose==='planning').length>=ticket.limits.maxExecutionAttempts)throw new Error('The configured model planning attempt limit has been reached.');
  }else{
    const candidate=currentCandidate(ticket);
    if(ticket.phase!=='review'||ticket.integration.status!=='ready_for_review'||input.expectedPlanRevision!==ticket.acceptedPlan?.revision||input.candidateId!==candidate.id||input.candidateSha!==candidate.candidateSha||input.targetMainSha!==candidate.targetMainSha)throw new Error('The final-review run must pin the current candidate, target main SHA, and accepted plan revision.');
    if(ticket.orchestratorRuns.filter(run=>run.purpose==='final_review'&&run.candidateId===candidate.id).length>=ticket.limits.maxExecutionAttempts)throw new Error('The configured final-review attempt limit has been reached for this candidate.');
  }
  const {knowledgeAllocation:requestedKnowledgeOperations,...runInput}=structuredClone(input);
  const run:ForgeOrchestratorRun={...runInput,knowledgeAllocation:reserveKnowledgeAllocation(ticket,input.ownerId,command.actor.id,requestedKnowledgeOperations,now),status:'prepared',createdAt:now};
  ticket.orchestratorRuns.push(run);ticket.activeOrchestratorRunId=run.id;ticket.phase=run.purpose==='planning'?'planning':'review';delete ticket.attentionReason;ticket.updatedAt=now;
}
function orchestratorRunFor(ticket:ForgeTicket,runId:string){
  const run=ticket.orchestratorRuns.find(row=>row.id===runId);
  if(!run)throw new Error('Forge orchestrator run not found.');
  return run;
}
function recordOrchestratorRuntime(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_orchestrator_runtime'}>,now:string){
  requireActor(command.actor,'host');
  const run=orchestratorRunFor(ticket,command.runId);
  if(ticket.activeOrchestratorRunId!==run.id||!['prepared','running'].includes(run.status))throw new Error('Runtime provenance can only be attached to the active prepared orchestrator run.');
  if((run.threadId||run.turnId)&&(run.threadId!==command.threadId||run.turnId!==command.turnId))throw new Error('An orchestrator run cannot be rebound to another provider thread or turn.');
  if(run.effectiveProfile&&command.effectiveProfile&&JSON.stringify(run.effectiveProfile)!==JSON.stringify(command.effectiveProfile))throw new Error('An orchestrator run effective profile cannot be replaced.');
  if(!run.threadId){run.threadId=command.threadId;run.turnId=command.turnId;run.startedAt=now;run.status='running';}
  if(command.effectiveProfile&&!run.effectiveProfile)run.effectiveProfile=structuredClone(command.effectiveProfile);
  ticket.updatedAt=now;
}
function orchestratorRetryCount(ticket:ForgeTicket,run:ForgeOrchestratorRun){
  return ticket.orchestratorRuns.filter(row=>run.purpose==='planning'?row.purpose==='planning':row.purpose==='final_review'&&row.candidateId===run.candidateId).length;
}
function finishOrchestratorRun(ticket:ForgeTicket,run:ForgeOrchestratorRun,now:string,reason:string,status:'failed'|'interrupted'){
  run.status=status;run.completedAt=now;run.failureReason=reason.slice(0,4000);delete ticket.activeOrchestratorRunId;
  const retryPhase=run.purpose==='planning'?'draft':'review';
  const exhausted=orchestratorRetryCount(ticket,run)>=ticket.limits.maxExecutionAttempts;
  if(ticket.phase==='paused')ticket.pausedFromPhase=exhausted?'blocked':retryPhase;
  else if(ticket.phase==='cancelled'){}
  else if(exhausted){ticket.phase='blocked';ticket.attentionReason=`The configured ${run.purpose==='planning'?'planning':'final-review'} attempt limit has been reached.`;}
  else if(ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('An orchestrator run is unknown after restart.')){ticket.phase=retryPhase;delete ticket.attentionReason;}
  else ticket.phase=retryPhase;
  ticket.updatedAt=now;
}
function failOrchestratorRun(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'fail_orchestrator_run'}>,now:string){
  requireActor(command.actor,'host');
  const run=orchestratorRunFor(ticket,command.runId);
  if(run.status==='failed'&&run.failureReason===command.failureReason)return;
  if(ticket.activeOrchestratorRunId!==run.id||!['prepared','running'].includes(run.status))throw new Error('Only the active prepared or running orchestrator attempt can fail.');
  if(!command.failureReason.trim())throw new Error('A failed orchestrator run requires a reason.');
  finishOrchestratorRun(ticket,run,now,command.failureReason,'failed');
}
function reconcileOrchestratorRun(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'reconcile_orchestrator_run'}>,now:string){
  requireActor(command.actor,'host');
  const run=orchestratorRunFor(ticket,command.runId);
  if(ticket.activeOrchestratorRunId!==run.id||run.status!=='unknown_after_restart')throw new Error('Only the unknown active orchestrator run can be reconciled.');
  if(!command.evidence.trim())throw new Error('Orchestrator run reconciliation requires host evidence.');
  if(command.status==='still_running'){
    if(run.threadId&&(run.threadId!==command.threadId||run.turnId!==command.turnId))throw new Error('Orchestrator reconciliation must retain the persisted provider thread and turn.');
    if(run.effectiveProfile&&command.effectiveProfile&&JSON.stringify(run.effectiveProfile)!==JSON.stringify(command.effectiveProfile))throw new Error('Orchestrator reconciliation cannot replace the previously observed effective profile.');
    run.reconciliation={status:command.status,evidence:command.evidence,actorId:command.actor.id,recordedAt:now};
    run.threadId=command.threadId;run.turnId=command.turnId;run.startedAt??=now;run.status='running';
    if(command.effectiveProfile&&!run.effectiveProfile)run.effectiveProfile=structuredClone(command.effectiveProfile);
    if(ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('An orchestrator run is unknown after restart.'))ticket.phase=run.purpose==='planning'?'planning':'review';
    delete ticket.attentionReason;ticket.updatedAt=now;return;
  }
  run.reconciliation={status:command.status,evidence:command.evidence,actorId:command.actor.id,recordedAt:now};
  finishOrchestratorRun(ticket,run,now,`Restart reconciliation confirmed the orchestrator run stopped: ${command.evidence}`,'interrupted');
}
function completePlanning(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'complete_planning'}>,now:string){
  requireActor(command.actor,'host');
  const run=orchestratorRunFor(ticket,command.runId);
  if(run.purpose!=='planning'||run.expectedPlanRevision!==command.expectedPlanRevision)throw new Error('The planning result targets a stale or different plan revision.');
  if(run.threadId!==command.threadId||run.turnId!==command.turnId)throw new Error('The planning result provenance does not match the observed orchestrator thread and turn.');
  if(run.status==='completed'&&run.resultPlanId===command.planId&&ticket.proposedPlan?.runId===run.id&&ticket.proposedPlan.id===command.planId){
    const repeat=command.tasks.map(task=>forgePlanTaskInputSchema.parse({...task,skillSnapshots:mergeForgeSkillSnapshots(task.skillSnapshots)}));validatePlan(ticket,repeat);
    const existing=ticket.proposedPlan.tasks.map(task=>({id:task.id,title:task.title,description:task.description,dependencyIds:task.dependencyIds,assignment:{assignment:task.assignment.assignment,executionProfile:task.assignment.executionProfile,skillSnapshots:task.assignment.skillSnapshots,knowledgeScope:task.assignment.knowledgeScope}}));
    if(JSON.stringify(existing)===JSON.stringify(repeat.map(task=>({id:task.id,title:task.title,description:task.description,dependencyIds:task.dependencyIds,assignment:{assignment:task.assignment,executionProfile:task.executionProfile,skillSnapshots:task.skillSnapshots,knowledgeScope:task.knowledgeScope}}))))return;
  }
  if(command.expectedPlanRevision!==ticket.planRevision+1)throw new Error('The planning result targets a stale or different plan revision.');
  if(ticket.activeOrchestratorRunId!==run.id||run.status!=='running'||ticket.phase!=='planning'||ticket.acceptedPlan)throw new Error('Only the active observed planning run may provide this Forge plan.');
  if(!run.threadId||!run.turnId)throw new Error('Planning results require persisted provider thread and turn provenance.');
  const tasks=command.tasks.map(task=>forgePlanTaskInputSchema.parse({...task,skillSnapshots:mergeForgeSkillSnapshots(task.skillSnapshots)}));validatePlan(ticket,tasks);
  recordPlanProposal(ticket,{role:'orchestrator',id:run.ownerId},command.planId,tasks,'model_run',run.id,command.expectedPlanRevision,now);
  run.status='completed';run.completedAt=now;run.resultPlanId=command.planId;delete ticket.activeOrchestratorRunId;ticket.updatedAt=now;
}
function acceptPlan(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'accept_plan'}>,now:string){
  requireActor(command.actor,'orchestrator','user');
  if(ticket.acceptedPlan){
    if(ticket.acceptedPlan.revision===command.revision)return;
    throw new Error('The accepted Forge plan is immutable.');
  }
  if(ticket.orchestratorRuns.some(run=>run.id===ticket.activeOrchestratorRunId&&run.purpose==='planning'))throw new Error('Wait for or reconcile the active planning run before accepting a plan.');
  if(ticket.phase!=='planning'||!ticket.proposedPlan||ticket.proposedPlan.revision!==command.revision)throw new Error('The selected Forge plan revision is unavailable.');
  const accepted:ForgeAcceptedPlan={...structuredClone(ticket.proposedPlan),acceptedAt:now,acceptedBy:command.actor.id};
  ticket.acceptedPlan=accepted;
  ticket.workitems=accepted.tasks.map(task=>({
    id:task.id,state:task.dependencyIds.length?'blocked':'open',dependencyIds:[...task.dependencyIds],
    ...(task.dependencyIds.length?{blockedReason:{kind:'dependencies' as const,taskIds:[...task.dependencyIds]}}:{}),
    attemptIds:[],assignmentRevision:1,correctionAssignments:[],updatedAt:now,
  }));
  ticket.phase='planned';ticket.updatedAt=now;
  refreshDependencyStates(ticket,now);
}
function startTicket(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'start'}>,now:string){
  requireActor(command.actor,'orchestrator','user');
  if(ticket.phase==='running')return;
  if(ticket.phase!=='planned'||!ticket.acceptedPlan)throw new Error('Accept a Forge plan before starting execution.');
  ticket.phase='running';ticket.startedAt=now;ticket.updatedAt=now;
}
function claimTask(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'claim_task'}>,now:string){
  requireActor(command.actor,'host');
  if(ticket.phase!=='running')throw new Error('Forge is not accepting new task claims.');
  const task=workitemFor(ticket,command.taskId);
  const previous=ticket.attempts.find(row=>row.id===command.attemptId);
  if(previous&&task.activeAttemptId===previous.id&&previous.claim.ownerId===command.ownerId&&previous.claim.token===command.claimToken&&previous.status==='claimed'&&task.state==='claimed'){
    const requested=command.knowledgeAllocation??ticket.knowledgeBudget.defaultAllocationOperations;
    if(previous.knowledgeAllocation?.operations!==requested)throw new Error('A repeated Forge claim cannot change its reserved knowledge allocation.');
    return;
  }
  if(previous&&task.activeAttemptId===previous.id&&previous.status==='unknown_after_restart')throw new Error('Reconcile this unknown Forge claim before starting or resuming its writer.');
  if(previous||ticket.attempts.some(row=>row.claim.id===command.claimId)||ticket.attempts.some(row=>row.claim.token===command.claimToken))throw new Error('Forge attempt or claim identifiers must be unique.');
  if(task.state!=='open')throw new Error('Only an open Forge task can be claimed.');
  const planTask=taskPlanFor(ticket,task.id);
  if(planTask.dependencyIds.some(id=>ticket.workitems.find(row=>row.id===id)?.state!=='finished'))throw new Error('Forge task dependencies are not finished.');
  if(activeCount(ticket)>=ticket.limits.maxActiveWorkers)throw new Error('Forge active worker limit has been reached.');
  const attempts=ticket.attempts.filter(row=>row.taskId===task.id&&row.assignmentRevision===task.assignmentRevision);
  if(attempts.length>=ticket.limits.maxExecutionAttempts){
    task.state='blocked';task.blockedReason={kind:'execution_issue',code:'retry_limit',detail:'The execution attempt limit for this assignment revision has been reached.'};task.updatedAt=now;
    updateTicketPhaseAfterOutcome(ticket,now);return;
  }
  const claim={id:command.claimId,token:command.claimToken,ownerId:command.ownerId,attemptId:command.attemptId,claimedAt:now,...(command.expiresAt?{expiresAt:command.expiresAt}:{})};
  const assignment=task.correctionAssignments.at(-1)||taskPlanFor(ticket,task.id).assignment;
  const attempt:ForgeAttempt={
    id:command.attemptId,taskId:task.id,ordinal:ticket.attempts.filter(row=>row.taskId===task.id).length+1,assignmentRevision:task.assignmentRevision,status:'claimed',claim,
    runtimeId:command.runtimeId,branch:command.branch,worktreeRoot:command.worktreeRoot,sourceBaselineSha:command.sourceBaselineSha,
    executionProfile:structuredClone(assignment.executionProfile),scopes:{read:[...assignment.assignment.read_scope],write:[...assignment.assignment.write_scope],knowledge:[...assignment.knowledgeScope]},skillSnapshots:structuredClone(assignment.skillSnapshots),
    knowledgeAllocation:reserveKnowledgeAllocation(ticket,command.ownerId,command.actor.id,command.knowledgeAllocation,now),
  };
  ticket.attempts.push(attempt);task.attemptIds.push(attempt.id);task.activeAttemptId=attempt.id;task.state='claimed';delete task.blockedReason;task.updatedAt=now;
}
function recordAttemptRuntime(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_attempt_runtime'}>,now:string){
  requireActor(command.actor,'host');
  const attempt=ticket.attempts.find(row=>row.id===command.attemptId&&row.taskId===command.taskId);
  if(!attempt)throw new Error('Forge attempt not found.');
  requireClaim(attempt,command);
  const task=workitemFor(ticket,command.taskId);
  if(attempt.status!=='claimed'||task.state!=='claimed'||task.activeAttemptId!==attempt.id)throw new Error('Runtime identifiers can only be attached to the active Forge attempt.');
  if(attempt.threadId||attempt.turnId){
    if(attempt.threadId===command.threadId&&attempt.turnId===command.turnId)return;
    throw new Error('A Forge attempt runtime cannot be rebound to another provider thread or turn.');
  }
  attempt.threadId=command.threadId;attempt.turnId=command.turnId;attempt.startedAt=now;ticket.updatedAt=now;
}
function sameSavedOutcome(existing:ForgeStoredReceipt,command:Extract<ForgeCommand,{type:'accept_worker_outcome'}>,attestation:ForgeHostAttestation|undefined){
  return existing.id===command.receiptId&&existing.outcomeId===command.outcomeId&&
    JSON.stringify(existing.receipt)===JSON.stringify(command.receipt)&&JSON.stringify(existing.provenance)===JSON.stringify(command.provenance)&&
    JSON.stringify(existing.hostAttestation)===JSON.stringify(attestation);
}
function acceptWorkerOutcome(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'accept_worker_outcome'}>,now:string){
  requireActor(command.actor,'host');
  const attempt=ticket.attempts.find(row=>row.id===command.attemptId);
  if(!attempt||attempt.taskId!==command.taskId)throw new Error('Forge attempt not found.');
  requireClaim(attempt,command);
  const task=workitemFor(ticket,command.taskId);
  const validatedProvenance=forgeReceiptProvenanceSchema.parse(command.provenance);
  const validatedAttestation=command.hostAttestation?forgeHostAttestationSchema.parse(command.hostAttestation):undefined;
  if(validatedProvenance.producerRole!=='worker'||validatedProvenance.workerId!==attempt.claim.ownerId||validatedProvenance.threadId!==attempt.threadId||validatedProvenance.turnId!==attempt.turnId)
    throw new Error('Worker receipt provenance must match the owner, provider thread, and turn attached to this attempt.');
  if(attempt.outcomeId){
    const saved=ticket.receipts.find(row=>row.attemptId===attempt.id);
    if(attempt.outcomeId===command.outcomeId&&saved&&sameSavedOutcome(saved,command,validatedAttestation))return;
    throw new Error('A different or late Forge outcome cannot replace the saved attempt result.');
  }
  if(task.activeAttemptId!==attempt.id||task.state!=='claimed'||attempt.status!=='claimed')throw new Error('This Forge attempt is no longer active.');
  if(ticket.receipts.some(row=>row.id===command.receiptId))throw new Error('Forge receipt IDs must be unique.');
  const receipt=forgeStoredReceiptSchema.shape.receipt.parse(command.receipt);
  const saved:ForgeStoredReceipt={id:command.receiptId,attemptId:attempt.id,outcomeId:command.outcomeId,receipt,provenance:validatedProvenance,...(validatedAttestation?{hostAttestation:validatedAttestation}:{}),savedAt:now};
  ticket.receipts.push(saved);attempt.outcomeId=command.outcomeId;attempt.receiptId=saved.id;attempt.completedAt=now;
  const attestedComplete=receipt.status==='complete'&&receipt.acceptance.unmet.length===0&&validatedAttestation?.status==='verified'&&validatedAttestation.commitObserved&&validatedAttestation.scopeValidation==='passed'&&!!validatedAttestation.commitSha;
  task.activeAttemptId=undefined;
  if(attestedComplete){
    attempt.status='finished';attempt.commitSha=validatedAttestation!.commitSha!;task.state='finished';delete task.blockedReason;
    refreshDependencyStates(ticket,now);
  }else{
    attempt.status='failed';
    const detail=command.failureReason?.trim()||(!attestedComplete&&receipt.status==='complete'?'The complete receipt lacks verified host commit and scope evidence.':receipt.result);
    attempt.failureReason=detail.slice(0,4000);
    const sameRevisionAttempts=ticket.attempts.filter(row=>row.taskId===task.id&&row.assignmentRevision===task.assignmentRevision).length;
    if(command.retryable&&sameRevisionAttempts<ticket.limits.maxExecutionAttempts){
      task.state='open';delete task.blockedReason;
    }else{
      task.state='blocked';task.blockedReason={kind:'execution_issue',code:sameRevisionAttempts>=ticket.limits.maxExecutionAttempts?'retry_limit':'attempt_failed',detail:attempt.failureReason,attemptId:attempt.id};
    }
  }
  task.updatedAt=now;updateTicketPhaseAfterOutcome(ticket,now);
}
function recoverAfterRestart(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'recover_after_restart'}>,now:string){
  requireActor(command.actor,'host');
  const uncertain:string[]=[];
  for(const task of ticket.workitems){
    if(task.state!=='claimed'||!task.activeAttemptId)continue;
    const attempt=ticket.attempts.find(row=>row.id===task.activeAttemptId&&row.taskId===task.id);
    if(!attempt||attempt.status!=='claimed')continue;
    attempt.status='unknown_after_restart';
    task.state='blocked';task.blockedReason={kind:'execution_issue',code:'unknown_after_restart',detail:'The persisted owner may still be live. Reconcile the original attempt before dispatching another writer.',attemptId:attempt.id};
    task.updatedAt=now;uncertain.push(attempt.id);
  }
  if(uncertain.length&&ticket.phase!=='paused'&&ticket.phase!=='cancelled'&&ticket.phase!=='complete'){
    ticket.phase='blocked';ticket.attentionReason=`A live Forge attempt requires reconciliation: ${uncertain.join(', ')}.`;
  }
  if(ticket.integration.mergeIntent&&['merging','paused','cancelled','blocked'].includes(ticket.phase)){
    if(ticket.phase==='merging')ticket.phase='blocked';
    ticket.attentionReason='The final merge status is unknown after restart. Read main and the candidate commit before recording a result or retrying.';
  }
  const activeRun=ticket.integration.runs.find(run=>run.id===ticket.integration.activeRunId);
  if(activeRun&&(activeRun.status==='prepared'||activeRun.status==='running')){
    activeRun.status='unknown_after_restart';
    ticket.integration.status='blocked';
    if(ticket.phase!=='paused'&&ticket.phase!=='cancelled'&&ticket.phase!=='complete')ticket.phase='blocked';
    ticket.attentionReason='The integrator status is unknown after restart. Reconcile the original run before starting another integration attempt.';
  }
  const activeOrchestratorRun=ticket.orchestratorRuns.find(run=>run.id===ticket.activeOrchestratorRunId);
  if(activeOrchestratorRun&&(activeOrchestratorRun.status==='prepared'||activeOrchestratorRun.status==='running')){
    activeOrchestratorRun.status='unknown_after_restart';
    if(ticket.phase!=='paused'&&ticket.phase!=='cancelled'&&ticket.phase!=='complete')ticket.phase='blocked';
    ticket.attentionReason='An orchestrator run is unknown after restart. Reconcile the exact run before starting another model call.';
  }
  ticket.updatedAt=now;
}
function reconcileAttempt(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'reconcile_attempt'}>,now:string){
  requireActor(command.actor,'host');
  const attempt=ticket.attempts.find(row=>row.id===command.attemptId&&row.taskId===command.taskId);
  if(!attempt)throw new Error('Forge attempt not found.');
  requireClaim(attempt,command);
  const task=workitemFor(ticket,command.taskId);
  if(attempt.status!=='unknown_after_restart'||task.activeAttemptId!==attempt.id||task.blockedReason?.kind!=='execution_issue'||task.blockedReason.code!=='unknown_after_restart')
    throw new Error('Only an unknown post-restart Forge attempt can be reconciled.');
  if(!command.evidence.trim())throw new Error('Forge attempt reconciliation requires host evidence.');
  attempt.reconciliation={status:command.status,evidence:command.evidence,actorId:command.actor.id,recordedAt:now};
  if(command.status==='still_running'){
    attempt.status='claimed';task.state='claimed';delete task.blockedReason;task.updatedAt=now;
    const remainsUnknown=ticket.attempts.some(row=>row.status==='unknown_after_restart');
    if(!remainsUnknown&&ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('A live Forge attempt requires reconciliation:')){
      ticket.phase='running';delete ticket.attentionReason;
    }
    return;
  }
  attempt.status='interrupted';attempt.completedAt=now;attempt.failureReason=`Restart reconciliation confirmed the attempt stopped: ${command.evidence}`.slice(0,4000);
  task.activeAttemptId=undefined;
  const sameRevisionAttempts=ticket.attempts.filter(row=>row.taskId===task.id&&row.assignmentRevision===task.assignmentRevision).length;
  if(sameRevisionAttempts<ticket.limits.maxExecutionAttempts){task.state='open';delete task.blockedReason;}
  else{task.state='blocked';task.blockedReason={kind:'execution_issue',code:'retry_limit',detail:'The execution attempt limit for this assignment revision has been reached.',attemptId:attempt.id};}
  task.updatedAt=now;updateTicketPhaseAfterOutcome(ticket,now);
}
function pauseTicket(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'pause'}>,now:string){
  requireActor(command.actor,'orchestrator','user');
  if(ticket.phase==='paused'||ticket.phase==='cancelled'||ticket.phase==='complete')return;
  ticket.pausedFromPhase=ticket.phase;ticket.phase='paused';ticket.pausedAt=now;ticket.updatedAt=now;
}
function phaseAfterResume(ticket:ForgeTicket):ForgeTicket['phase']{
  if(ticket.attempts.some(attempt=>attempt.status==='unknown_after_restart')||ticket.integration.mergeIntent)throw new Error('Reconcile unknown Forge attempts and merge effects before resuming dispatch.');
  const activeOrchestratorRun=ticket.orchestratorRuns.find(run=>run.id===ticket.activeOrchestratorRunId);
  if(activeOrchestratorRun?.status==='unknown_after_restart')throw new Error('Reconcile the unknown orchestrator run before resuming.');
  if(activeOrchestratorRun&&(activeOrchestratorRun.status==='prepared'||activeOrchestratorRun.status==='running'))return activeOrchestratorRun.purpose==='planning'?'planning':'review';
  const activeRun=ticket.integration.runs.find(run=>run.id===ticket.integration.activeRunId);
  if(activeRun?.status==='unknown_after_restart')throw new Error('Reconcile the unknown integrator run before resuming.');
  if(activeRun&&(activeRun.status==='prepared'||activeRun.status==='running'))return 'integrating';
  if(ticket.integration.status==='blocked')return 'blocked';
  if(ticket.integration.status==='ready_for_review'&&ticket.integration.activeCandidateId){
    const candidate=currentCandidate(ticket);
    if(ticket.orchestratorRuns.filter(run=>run.purpose==='final_review'&&run.candidateId===candidate.id).length>=ticket.limits.maxExecutionAttempts&&!ticket.integration.reviewDecisions.some(row=>row.candidateId===candidate.id))return 'blocked';
    return ticket.integration.reviewDecisions.some(row=>row.candidateId===candidate.id&&row.candidateSha===candidate.candidateSha&&row.targetMainSha===candidate.targetMainSha&&row.disposition==='accept')?'merge_ready':'review';
  }
  if(ticket.workitems.length&&ticket.workitems.every(task=>task.state==='finished'))return 'integrating';
  if(ticket.workitems.some(task=>task.state==='open'||task.state==='claimed'))return 'running';
  if(ticket.workitems.some(task=>task.state==='blocked'))return 'blocked';
  if(ticket.proposedPlan&&!ticket.acceptedPlan)return 'planning';
  if(!ticket.acceptedPlan&&ticket.orchestratorRuns.filter(run=>run.purpose==='planning').length>=ticket.limits.maxExecutionAttempts)return 'blocked';
  return ticket.acceptedPlan?'planned':'draft';
}
function resumeTicket(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'resume'}>,now:string){
  requireActor(command.actor,'orchestrator','user');
  if(ticket.phase!=='paused'){
    if(ticket.phase!=='cancelled'&&ticket.phase!=='complete')throw new Error('Only a paused Forge ticket can be resumed.');
    return;
  }
  ticket.phase=phaseAfterResume(ticket);delete ticket.pausedFromPhase;delete ticket.pausedAt;ticket.updatedAt=now;
}
function cancelTicket(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'cancel'}>,now:string){
  requireActor(command.actor,'orchestrator','user');
  if(ticket.phase==='cancelled'||ticket.phase==='complete')return;
  ticket.phase='cancelled';ticket.cancelledAt=now;delete ticket.pausedAt;delete ticket.pausedFromPhase;ticket.updatedAt=now;
}
function beginIntegration(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'begin_integration'}>,now:string){
  requireActor(command.actor,'host');
  if(ticket.phase!=='integrating'||ticket.workitems.some(task=>task.state!=='finished'))throw new Error('Integration can start only after every Forge task is finished.');
  const input=forgeIntegrationRunInputSchema.parse({...command.run,skillSnapshots:mergeForgeSkillSnapshots(command.run.skillSnapshots)});
  const duplicate=ticket.integration.runs.find(run=>run.id===input.id);
  if(duplicate){
    if(ticket.integration.activeRunId===duplicate.id&&duplicate.status==='unknown_after_restart')throw new Error('Reconcile the unknown Forge integrator run before dispatching or starting it again.');
    throw new Error('This Forge integrator run ID already exists. Read or reconcile that durable run instead of dispatching it again.');
  }
  if(ticket.integration.status!=='not_started')throw new Error('The current Forge integration state is not ready to start.');
  if(ticket.integration.activeRunId)throw new Error('Reconcile the active Forge integrator run before starting another one.');
  if(input.projectId!==ticket.projectId||input.workspaceRoot!==ticket.workspaceRoot)throw new Error('The integrator run must use the ticket workspace identity and root.');
  const latestCorrection=ticket.integration.correctionRounds.at(-1)?.id;
  if(input.correctionRoundId!==latestCorrection)throw new Error('The integrator run must link to the latest correction round.');
  if(ticket.integration.runs.filter(run=>run.correctionRoundId===latestCorrection).length>=ticket.limits.maxExecutionAttempts){
    ticket.integration.status='blocked';ticket.phase='blocked';ticket.attentionReason='The configured integration attempt limit has been reached for this ticket revision.';ticket.updatedAt=now;return;
  }
  if(new Set(input.skillSnapshots.map(skill=>skill.id)).size!==input.skillSnapshots.length)throw new Error('The integrator cannot snapshot one skill revision more than once.');
  if(!input.scopes.read.every(path=>isWithinScope(path,[...ticket.scope.read,...ticket.scope.write]))||
    !input.scopes.write.every(path=>isWithinScope(path,ticket.scope.write))||
    !input.scopes.knowledge.every(path=>isWithinScope(path,ticket.scope.knowledge)))throw new Error('The integrator run exceeds the ticket scope.');
  const {knowledgeAllocation:requestedKnowledgeOperations,...runInput}=structuredClone(input);
  const run:ForgeIntegrationRun={...runInput,knowledgeAllocation:reserveKnowledgeAllocation(ticket,input.ownerId,command.actor.id,requestedKnowledgeOperations,now),status:'prepared',createdAt:now};
  ticket.integration.runs.push(run);ticket.integration.activeRunId=run.id;ticket.integration.status='running';ticket.updatedAt=now;
}
function integrationRunFor(ticket:ForgeTicket,runId:string){
  const run=ticket.integration.runs.find(row=>row.id===runId);
  if(!run)throw new Error('Forge integrator run not found.');
  return run;
}
function recordIntegrationRuntime(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_integration_runtime'}>,now:string){
  requireActor(command.actor,'host');
  const run=integrationRunFor(ticket,command.runId);
  if(ticket.integration.activeRunId!==run.id||!['prepared','running'].includes(run.status))throw new Error('Runtime provenance can only be attached to the active prepared integrator run.');
  if(run.threadId||run.turnId){
    if(run.threadId===command.threadId&&run.turnId===command.turnId&&(!command.effectiveProfile||JSON.stringify(run.effectiveProfile)===JSON.stringify(command.effectiveProfile)))return;
    throw new Error('An integrator run cannot be rebound to a different provider thread, turn, or observed profile.');
  }
  if(run.effectiveProfile&&command.effectiveProfile&&JSON.stringify(run.effectiveProfile)!==JSON.stringify(command.effectiveProfile))throw new Error('An integrator run effective profile cannot be replaced.');
  run.threadId=command.threadId;run.turnId=command.turnId;run.startedAt=now;run.status='running';
  if(command.effectiveProfile)run.effectiveProfile=structuredClone(command.effectiveProfile);
  ticket.updatedAt=now;
}
function finishIntegrationRun(ticket:ForgeTicket,run:ForgeIntegrationRun,now:string,reason:string,status:'failed'|'interrupted'){
  run.status=status;run.completedAt=now;run.failureReason=reason.slice(0,4000);delete ticket.integration.activeRunId;
  const count=ticket.integration.runs.filter(row=>row.correctionRoundId===run.correctionRoundId).length;
  if(count>=ticket.limits.maxExecutionAttempts){ticket.integration.status='blocked';if(ticket.phase==='paused')ticket.pausedFromPhase='blocked';else if(ticket.phase!=='cancelled')ticket.phase='blocked';ticket.attentionReason='The configured integration attempt limit has been reached for this ticket revision.';}
  else{ticket.integration.status='not_started';if(ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('The integrator status is unknown after restart.'))ticket.phase='integrating';if(ticket.phase==='paused')ticket.pausedFromPhase='integrating';delete ticket.attentionReason;}
  ticket.updatedAt=now;
}
function failIntegrationRun(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'fail_integration_run'}>,now:string){
  requireActor(command.actor,'host');
  const run=integrationRunFor(ticket,command.runId);
  if(run.status==='failed'&&run.failureReason===command.failureReason)return;
  if(ticket.integration.activeRunId!==run.id||!['prepared','running'].includes(run.status))throw new Error('Only the active prepared or running integrator attempt can fail.');
  if(!command.failureReason.trim())throw new Error('A failed integrator run requires a reason.');
  finishIntegrationRun(ticket,run,now,command.failureReason,'failed');
}
function reconcileIntegrationRun(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'reconcile_integration_run'}>,now:string){
  requireActor(command.actor,'host');
  const run=integrationRunFor(ticket,command.runId);
  if(ticket.integration.activeRunId!==run.id||run.status!=='unknown_after_restart')throw new Error('Only the unknown active integrator run can be reconciled.');
  if(!command.evidence.trim())throw new Error('Integrator run reconciliation requires host evidence.');
  if(command.status==='still_running'){
    if(run.threadId&&(run.threadId!==command.threadId||run.turnId!==command.turnId))throw new Error('Integrator reconciliation must retain the persisted provider thread and turn.');
    if(run.effectiveProfile&&command.effectiveProfile&&JSON.stringify(run.effectiveProfile)!==JSON.stringify(command.effectiveProfile))throw new Error('Integrator reconciliation cannot replace the previously observed effective profile.');
    run.reconciliation={status:command.status,evidence:command.evidence,actorId:command.actor.id,recordedAt:now};
    run.threadId=command.threadId;run.turnId=command.turnId;run.startedAt??=now;run.status='running';
    if(command.effectiveProfile&&!run.effectiveProfile)run.effectiveProfile=structuredClone(command.effectiveProfile);
    ticket.integration.status='running';
    if(ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('The integrator status is unknown after restart.'))ticket.phase='integrating';
    delete ticket.attentionReason;ticket.updatedAt=now;return;
  }
  run.reconciliation={status:command.status,evidence:command.evidence,actorId:command.actor.id,recordedAt:now};
  finishIntegrationRun(ticket,run,now,`Restart reconciliation confirmed the integrator run stopped: ${command.evidence}`,'interrupted');
}
function expectedWorkerCommits(ticket:ForgeTicket){
  return ticket.workitems.map(task=>{
    const attempt=ticket.attempts.filter(row=>row.taskId===task.id&&row.assignmentRevision===task.assignmentRevision&&row.status==='finished').at(-1);
    if(!attempt?.commitSha)throw new Error(`Forge task ${task.id} has no finished host-attested commit.`);
    if(!attempt.receiptId)throw new Error(`Forge task ${task.id} has no saved receipt for its finished attempt.`);
    const receipt=ticket.receipts.find(row=>row.id===attempt.receiptId&&row.attemptId===attempt.id);
    if(!receipt||receipt.receipt.status!=='complete'||receipt.receipt.acceptance.unmet.length||receipt.hostAttestation?.status!=='verified'||receipt.hostAttestation.commitSha!==attempt.commitSha)
      throw new Error(`Forge task ${task.id} is missing its saved host-attested complete receipt.`);
    return {taskId:task.id,attemptId:attempt.id,receiptId:attempt.receiptId,commitSha:attempt.commitSha};
  });
}
function recordIntegrationCandidate(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_integration_candidate'}>,now:string){
  requireActor(command.actor,'host');
  const candidate=forgeIntegrationCandidateSchema.parse(command.candidate);
  const existing=ticket.integration.candidates.find(row=>row.id===candidate.id);
  if(existing){
    if(JSON.stringify(existing)===JSON.stringify(candidate)&&ticket.integration.activeCandidateId===candidate.id)return;
    throw new Error('Forge candidate IDs must be unique.');
  }
  const run=integrationRunFor(ticket,candidate.integratorRunId);
  const phaseAcceptsResult=ticket.phase==='integrating'||ticket.phase==='paused'||ticket.phase==='cancelled';
  if(!phaseAcceptsResult||ticket.integration.status!=='running'||ticket.integration.activeRunId!==run.id||run.status!=='running'||ticket.workitems.some(task=>task.state!=='finished'))throw new Error('The ticket is not ready to record an integration candidate for its active integrator run.');
  if(candidate.provenance.producerRole!=='integrator')throw new Error('Integration evidence must be attributed to the integrator.');
  if(candidate.provenance.threadId!==run.threadId||candidate.provenance.turnId!==run.turnId)throw new Error('Integration candidate provenance must match the observed active integrator run.');
  const actual=expectedWorkerCommits(ticket);
  if(candidate.workerCommits.length!==actual.length||actual.some(expected=>!candidate.workerCommits.some(commit=>commit.taskId===expected.taskId&&commit.attemptId===expected.attemptId&&commit.receiptId===expected.receiptId&&commit.commitSha===expected.commitSha)))
    throw new Error('Integration candidate worker commits and receipts do not match the finished host-attested task attempts.');
  if(new Set(candidate.findings.map(finding=>finding.id)).size!==candidate.findings.length)throw new Error('Integration finding IDs must be unique within a candidate.');
  ticket.integration.candidates.push(candidate);ticket.integration.activeCandidateId=candidate.id;
  run.status='completed';run.completedAt=now;run.candidateId=candidate.id;delete ticket.integration.activeRunId;
  if(candidate.findings.some(finding=>!finding.taskId||!ticket.workitems.some(task=>task.id===finding.taskId))){
    ticket.integration.status='blocked';if(ticket.phase==='paused')ticket.pausedFromPhase='blocked';else if(ticket.phase!=='cancelled')ticket.phase='blocked';ticket.attentionReason='Integration findings must identify an affected Forge task before bounded worker correction can be assigned.';
  }else if(candidate.findings.length){
    ticket.integration.status='awaiting_correction';if(ticket.phase==='paused')ticket.pausedFromPhase='integrating';else if(ticket.phase!=='cancelled')ticket.phase='integrating';
  }else if(candidate.scopeValidation.status==='passed'&&candidate.verification.every(row=>row.result==='passed')&&candidate.combinedReceipt.status==='complete'&&candidate.combinedReceipt.acceptance.unmet.length===0){
    ticket.integration.status='ready_for_review';if(ticket.phase==='paused')ticket.pausedFromPhase='review';else if(ticket.phase!=='cancelled')ticket.phase='review';
  }else{
    ticket.integration.status='blocked';if(ticket.phase==='paused')ticket.pausedFromPhase='blocked';else if(ticket.phase!=='cancelled')ticket.phase='blocked';ticket.attentionReason='Integration evidence did not pass scope, checks, or the combined receipt acceptance criteria.';
  }
  ticket.updatedAt=now;
}
function currentCandidate(ticket:ForgeTicket){
  const candidate=ticket.integration.candidates.find(row=>row.id===ticket.integration.activeCandidateId);
  if(!candidate)throw new Error('There is no active Forge integration candidate.');
  return candidate;
}
function correctionIsWithinOriginalScope(ticket:ForgeTicket,taskId:string,input:Extract<ForgeCommand,{type:'request_corrections'}>['items'][number]['assignment']){
  const planned=taskPlanFor(ticket,taskId).assignment;
  if(!input.assignment.read_scope.every(path=>isWithinScope(path,[...planned.assignment.read_scope,...planned.assignment.write_scope]))||
    !input.assignment.write_scope.every(path=>isWithinScope(path,planned.assignment.write_scope))||
    !input.knowledgeScope.every(path=>isWithinScope(path,planned.knowledgeScope)))
    throw new Error(`Correction assignment for ${taskId} exceeds the task's approved scope.`);
  if(JSON.stringify(input.executionProfile)!==JSON.stringify(planned.executionProfile))throw new Error(`Correction assignment for ${taskId} changes the snapshotted execution profile.`);
  const selectedSkills=new Map(input.skillSnapshots.map(skill=>[skill.id,skill.revision]));
  if(selectedSkills.size!==input.skillSnapshots.length||selectedSkills.size!==planned.skillSnapshots.length||planned.skillSnapshots.some(skill=>selectedSkills.get(skill.id)!==skill.revision))
    throw new Error(`Correction assignment for ${taskId} must preserve the accepted skill revision set.`);
}
type CorrectionItemInput={taskId:string;findingIds:string[];assignment:Extract<ForgeCommand,{type:'request_corrections'}>['items'][number]['assignment']};
type CorrectionFinding={id:string;taskId:string;title:string;issue:string;requiredFix:string;evidence:string[]};
function recordCorrectionRound(ticket:ForgeTicket,requestedBy:string,correctionId:string,items:CorrectionItemInput[],findings:CorrectionFinding[],source:'integrator'|'final_review',now:string){
  const candidate=currentCandidate(ticket);
  if(items.length>MAX_FORGE_WORKITEMS)throw new Error(`A Forge correction round may reopen at most ${MAX_FORGE_WORKITEMS} work items in v1.`);
  if(ticket.integration.correctionRounds.length>=ticket.limits.maxCorrectionRounds){
    ticket.integration.status='blocked';ticket.phase='blocked';ticket.attentionReason='The configured Forge integration correction limit has been reached.';ticket.updatedAt=now;return false;
  }
  if(ticket.integration.correctionRounds.some(round=>round.id===correctionId))throw new Error('Forge correction IDs must be unique.');
  if(!items.length||new Set(items.map(item=>item.taskId)).size!==items.length)throw new Error('A correction round must contain unique affected tasks.');
  if(!findings.length||new Set(findings.map(finding=>finding.id)).size!==findings.length||findings.some(finding=>!ticket.workitems.some(task=>task.id===finding.taskId)))throw new Error('Correction findings must be unique and identify existing Forge tasks.');
  const plannedCorrections=items.map(item=>{
    const task=workitemFor(ticket,item.taskId);
    if(task.state!=='finished'||task.activeAttemptId)throw new Error(`Only a finished Forge task can be reopened for correction: ${task.id}.`);
    if(!item.findingIds.length||new Set(item.findingIds).size!==item.findingIds.length||item.findingIds.some(id=>!findings.some(finding=>finding.id===id&&finding.taskId===task.id)))throw new Error(`Correction for ${task.id} must cite its recorded findings.`);
    const assignment=forgeAssignmentSnapshotInputSchema.parse({...item.assignment,skillSnapshots:mergeForgeSkillSnapshots(item.assignment.skillSnapshots)});
    correctionIsWithinOriginalScope(ticket,task.id,assignment);
    const revision=task.assignmentRevision+1;
    const snapshot={...assignment,revision,source:'correction' as const,createdAt:now,findingIds:[...item.findingIds]};
    return {task,snapshot,record:{taskId:task.id,findingIds:[...item.findingIds],assignmentRevision:revision}};
  });
  const requestedFindings=new Set(plannedCorrections.flatMap(row=>row.record.findingIds));
  if(requestedFindings.size!==findings.length||findings.some(finding=>!requestedFindings.has(finding.id)))throw new Error('A correction round must assign every finding recorded for rework.');
  const index=ticket.integration.correctionRounds.length+1;
  ticket.integration.correctionRounds.push({id:correctionId,index,source,candidateId:candidate.id,requestedAt:now,requestedBy,findings:structuredClone(findings),items:plannedCorrections.map(row=>row.record)});
  for(const {task,snapshot} of plannedCorrections){
    task.correctionAssignments.push(snapshot);task.assignmentRevision=snapshot.revision;task.state='open';delete task.blockedReason;task.updatedAt=now;
  }
  ticket.integration.supersededCandidateIds.push(candidate.id);delete ticket.integration.activeCandidateId;ticket.integration.status='not_started';ticket.phase='running';delete ticket.attentionReason;ticket.updatedAt=now;
  return true;
}
function requestCorrections(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'request_corrections'}>,now:string){
  requireActor(command.actor,'integrator');
  if(ticket.phase!=='integrating'||ticket.integration.status!=='awaiting_correction')throw new Error('No integration findings are awaiting a correction assignment.');
  const candidate=currentCandidate(ticket);
  const findings=candidate.findings.map(finding=>{
    if(!finding.taskId||!ticket.workitems.some(task=>task.id===finding.taskId))throw new Error('Every integration correction finding must identify an affected Forge task.');
    return {...finding,taskId:finding.taskId};
  });
  recordCorrectionRound(ticket,command.actor.id,command.correctionId,command.items,findings,'integrator',now);
}
type CandidateReviewCommand=Extract<ForgeCommand,{type:'submit_manual_candidate_review'}>|Extract<ForgeCommand,{type:'complete_candidate_review'}>;
function applyCandidateReview(ticket:ForgeTicket,command:CandidateReviewCommand,now:string,source:'manual'|'model_run',runId?:string,reviewedBy=command.actor.id):ForgeReviewDecision{
  const candidate=currentCandidate(ticket);
  if(ticket.phase!=='review'||ticket.integration.status!=='ready_for_review'||candidate.candidateSha!==command.candidateSha||candidate.targetMainSha!==command.targetMainSha)
    throw new Error('Review must refer to the current verified integration candidate and target main SHA.');
  const existing=ticket.integration.reviewDecisions.find(row=>row.candidateId===candidate.id&&row.candidateSha===candidate.candidateSha&&row.targetMainSha===candidate.targetMainSha&&row.disposition===command.disposition&&row.source===source&&row.runId===runId);
  if(existing){
    if(existing.note===command.note&&existing.reviewedBy===reviewedBy)return existing;
    throw new Error('This candidate already has a different final review decision.');
  }
  const id=`review:${candidate.id}:${ticket.integration.reviewDecisions.length+1}`;
  let decision:ForgeReviewDecision;
  if(command.disposition==='request_corrections'){
    if(!command.correctionId||!command.corrections?.length)throw new Error('A final review correction requires a bounded correction ID and complete task assignments.');
    const findings=command.corrections.flatMap(item=>item.findings.map(finding=>({...finding,taskId:item.taskId})));
    const items=command.corrections.map(item=>({taskId:item.taskId,findingIds:item.findings.map(finding=>finding.id),assignment:item.assignment}));
    const created=recordCorrectionRound(ticket,reviewedBy,command.correctionId,items,findings,'final_review',now);
    decision={id,candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,disposition:command.disposition,note:command.note,reviewedAt:now,reviewedBy,source,...(runId?{runId}:{}),...(created?{correctionRoundId:command.correctionId}:{})};
  }else{
    if(command.correctionId||command.corrections)throw new Error('Only a correction review may include correction assignments.');
    decision={id,candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,disposition:command.disposition,note:command.note,reviewedAt:now,reviewedBy,source,...(runId?{runId}:{})};
    if(command.disposition==='accept')ticket.phase='merge_ready';
    else{ticket.integration.status='blocked';ticket.phase='blocked';ticket.attentionReason=command.note||'The final candidate review blocked this Forge ticket.';}
  }
  ticket.integration.reviewDecisions.push(decision);
  ticket.updatedAt=now;
  return decision;
}
function submitManualCandidateReview(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'submit_manual_candidate_review'}>,now:string){
  requireActor(command.actor,'user');
  const candidate=currentCandidate(ticket);
  if(ticket.orchestratorRuns.some(run=>run.purpose==='final_review'&&run.candidateId===candidate.id))throw new Error('A manual review cannot bypass an attempted model final-review run.');
  applyCandidateReview(ticket,command,now,'manual');
}
function completeCandidateReview(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'complete_candidate_review'}>,now:string){
  requireActor(command.actor,'host');
  const run=orchestratorRunFor(ticket,command.runId);
  if(run.purpose!=='final_review'||run.expectedPlanRevision!==command.expectedPlanRevision||command.expectedPlanRevision!==ticket.acceptedPlan?.revision||run.candidateId!==command.candidateId||run.candidateSha!==command.candidateSha||run.targetMainSha!==command.targetMainSha)throw new Error('The final-review result targets a different candidate, target main SHA, or accepted plan revision.');
  if(run.threadId!==command.threadId||run.turnId!==command.turnId)throw new Error('The final-review result provenance does not match the observed orchestrator thread and turn.');
  if(run.status==='completed'&&run.resultReviewId){
    const saved=ticket.integration.reviewDecisions.find(decision=>decision.id===run.resultReviewId&&decision.runId===run.id);
    if(saved&&saved.disposition===command.disposition&&saved.note===command.note&&saved.candidateId===command.candidateId&&saved.candidateSha===command.candidateSha&&saved.targetMainSha===command.targetMainSha&&saved.correctionRoundId===command.correctionId)return;
  }
  if(ticket.activeOrchestratorRunId!==run.id||run.status!=='running'||ticket.phase!=='review'||!run.threadId||!run.turnId)throw new Error('Only the active observed final-review run may provide this candidate decision.');
  const decision=applyCandidateReview(ticket,command,now,'model_run',run.id,run.ownerId);
  run.status='completed';run.completedAt=now;run.resultReviewId=decision.id;delete ticket.activeOrchestratorRunId;ticket.updatedAt=now;
}
function invalidateCurrentCandidate(ticket:ForgeTicket,candidate:ForgeIntegrationCandidate,observedMainSha:string,now:string,detail:string,readback?:ForgeIntegration['mergeReadbacks'][number]){
  if(!ticket.integration.staleCandidateIds.includes(candidate.id))ticket.integration.staleCandidateIds.push(candidate.id);
  ticket.integration.mergeReadbacks.push(readback||{id:`stale:${candidate.id}:${observedMainSha}`,candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,result:'stale',observedMainSha,detail,recordedAt:now});
  delete ticket.integration.activeCandidateId;delete ticket.integration.mergeIntent;ticket.integration.status='not_started';
  if(ticket.phase==='paused')ticket.pausedFromPhase='integrating';
  else if(ticket.phase!=='cancelled')ticket.phase='integrating';
  ticket.attentionReason=detail;ticket.updatedAt=now;
}
function beginMerge(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'begin_merge'}>,now:string){
  requireActor(command.actor,'host');
  const candidate=currentCandidate(ticket);
  if(ticket.phase==='merging'&&ticket.integration.mergeIntent?.candidateId===candidate.id)throw new Error('A Forge merge already has a durable intent. Reconcile its main readback before starting another Git effect.');
  const accepted=ticket.integration.reviewDecisions.some(row=>row.candidateId===candidate.id&&row.candidateSha===command.candidateSha&&row.targetMainSha===command.targetMainSha&&row.disposition==='accept');
  if(ticket.phase!=='merge_ready'||!accepted||candidate.candidateSha!==command.candidateSha||candidate.targetMainSha!==command.targetMainSha)
    throw new Error('A matching orchestrator approval is required before final merge.');
  if(command.observedMainSha!==candidate.targetMainSha){invalidateCurrentCandidate(ticket,candidate,command.observedMainSha,now,'The target main SHA changed after review; rebuild and recheck the integration candidate.');return;}
  ticket.integration.mergeIntent={candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,startedAt:now,startedBy:command.actor.id};
  ticket.phase='merging';ticket.updatedAt=now;
}
function recordMergeReadback(ticket:ForgeTicket,command:Extract<ForgeCommand,{type:'record_merge_readback'}>,now:string){
  requireActor(command.actor,'host');
  const intent=ticket.integration.mergeIntent;
  const recovering=ticket.phase==='blocked'&&ticket.attentionReason?.startsWith('The final merge status is unknown after restart.');
  if(!intent||!(ticket.phase==='merging'||recovering||ticket.phase==='paused'||ticket.phase==='cancelled'))throw new Error('Forge has no authorized merge operation to verify.');
  if(intent.candidateSha!==command.candidateSha||intent.targetMainSha!==command.targetMainSha)throw new Error('Merge readback does not match the approved candidate and target SHA.');
  const candidate=ticket.integration.candidates.find(row=>row.id===intent.candidateId);
  if(!candidate)throw new Error('Approved Forge candidate evidence is missing.');
  const readback={id:`merge:${candidate.id}:${ticket.integration.mergeReadbacks.length+1}`,candidateId:candidate.id,candidateSha:intent.candidateSha,targetMainSha:intent.targetMainSha,...(command.preMergeMainSha?{preMergeMainSha:command.preMergeMainSha}:{}),result:command.result,observedMainSha:command.observedMainSha,...(command.mergeCommitSha?{mergeCommitSha:command.mergeCommitSha}:{}),...(command.commitReadbackSha?{commitReadbackSha:command.commitReadbackSha}:{}),...(command.detail?{detail:command.detail}:{}),recordedAt:now};
  if(command.result==='stale'){
    const changedSha=command.preMergeMainSha&&command.preMergeMainSha!==intent.targetMainSha?command.preMergeMainSha:command.observedMainSha;
    if(changedSha===intent.targetMainSha)throw new Error('A stale merge result requires evidence that main moved from the verified target.');
    invalidateCurrentCandidate(ticket,candidate,changedSha,now,command.detail||'Main changed before merge; rebuild and recheck the candidate.',readback);return;
  }
  if(command.result==='failed'){
    if(command.preMergeMainSha!==intent.targetMainSha||command.observedMainSha!==intent.targetMainSha)throw new Error('A failed merge can be released for retry only when host readback confirms main is still at the approved target.');
    ticket.integration.mergeReadbacks.push(readback);delete ticket.integration.mergeIntent;ticket.integration.status='ready_for_review';
    if(recovering){ticket.phase='merge_ready';delete ticket.attentionReason;}
    else if(ticket.phase==='paused')ticket.pausedFromPhase='merge_ready';
    else if(ticket.phase!=='cancelled')ticket.phase='merge_ready';
    if(ticket.phase==='paused'||ticket.phase==='cancelled')delete ticket.attentionReason;
    ticket.updatedAt=now;return;
  }
  if(command.preMergeMainSha!==intent.targetMainSha)throw new Error('Main changed from the verified target before the final merge.');
  if(!command.mergeCommitSha||command.commitReadbackSha!==command.mergeCommitSha||command.observedMainSha!==command.mergeCommitSha)
    throw new Error('A Forge ticket can complete only after the merged commit SHA is read back from main.');
  ticket.integration.mergeReadbacks.push(readback);delete ticket.integration.mergeIntent;ticket.integration.status='merged';ticket.phase='complete';ticket.completedAt=now;delete ticket.attentionReason;delete ticket.pausedAt;delete ticket.pausedFromPhase;ticket.updatedAt=now;
}

export function applyForgeCommand(ticket:ForgeTicket,command:ForgeCommand,now:string):ForgeTicket{
  validTime(now);
  const next=forgeTicketSchema.parse(structuredClone(ticket));
  switch(command.type){
    case 'submit_manual_plan':submitManualPlan(next,command,now);break;
    case 'begin_orchestrator_run':beginOrchestratorRun(next,command,now);break;
    case 'record_orchestrator_runtime':recordOrchestratorRuntime(next,command,now);break;
    case 'fail_orchestrator_run':failOrchestratorRun(next,command,now);break;
    case 'reconcile_orchestrator_run':reconcileOrchestratorRun(next,command,now);break;
    case 'complete_planning':completePlanning(next,command,now);break;
    case 'submit_manual_candidate_review':submitManualCandidateReview(next,command,now);break;
    case 'complete_candidate_review':completeCandidateReview(next,command,now);break;
    case 'record_knowledge_usage':recordKnowledgeUsage(next,command,now);break;
    case 'accept_plan':acceptPlan(next,command,now);break;
    case 'start':startTicket(next,command,now);break;
    case 'claim_task':claimTask(next,command,now);break;
    case 'record_attempt_runtime':recordAttemptRuntime(next,command,now);break;
    case 'accept_worker_outcome':acceptWorkerOutcome(next,command,now);break;
    case 'recover_after_restart':recoverAfterRestart(next,command,now);break;
    case 'reconcile_attempt':reconcileAttempt(next,command,now);break;
    case 'pause':pauseTicket(next,command,now);break;
    case 'resume':resumeTicket(next,command,now);break;
    case 'cancel':cancelTicket(next,command,now);break;
    case 'begin_integration':beginIntegration(next,command,now);break;
    case 'record_integration_runtime':recordIntegrationRuntime(next,command,now);break;
    case 'fail_integration_run':failIntegrationRun(next,command,now);break;
    case 'reconcile_integration_run':reconcileIntegrationRun(next,command,now);break;
    case 'record_integration_candidate':recordIntegrationCandidate(next,command,now);break;
    case 'request_corrections':requestCorrections(next,command,now);break;
    case 'begin_merge':beginMerge(next,command,now);break;
    case 'record_merge_readback':recordMergeReadback(next,command,now);break;
    default:throw new Error('Unsupported Forge command.');
  }
  next.updatedAt=now;
  return forgeTicketSchema.parse(next);
}
