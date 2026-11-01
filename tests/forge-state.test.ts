import { describe, expect, it } from 'vitest';
import { applyForgeCommand, createForgeTicket, forgeKnowledgeBudgetBalance } from '../server/forge-state.js';
import { forgeTicketInputSchema, MAX_FORGE_WORKITEMS } from '../server/contracts.js';
import { forgeAssignmentSnapshotInputSchema, forgeIntegrationRunInputSchema, forgeOrchestratorRunInputSchema, forgePlanTaskInputSchema, forgeTicketSchema, mergeForgeSkillSnapshots, type ForgeIntegrationCandidate, type ForgePlanTaskInput, type ForgeTicket } from '../server/forge-contracts.js';

const at='2026-10-31T00:00:00.000Z';
const assignment=(write_scope:string[]=['src'])=>({
  outcome:'Implement the assigned change.',deliverable:'Changed source files.',read_scope:['src'],write_scope,
  exclusions:[],constraints:[],context_refs:[],acceptance:['The behavior works.'],verification:['Focused tests pass.'],
  ordinary_authority:['Make ordinary local implementation decisions.'],escalation_conditions:['A public contract must change.'],receipt_requirements:['Return a complete receipt.'],
});
const skillSnapshot=(index:number,id=`skill-${index}`,revision='revision-1')=>({id,revision,name:`Skill ${index}`,description:`Skill description ${index}.`,source:`saved:${id}`,instructions:`Use skill ${index}.`,files:[] as {path:string;size:number}[]});
const ticket=(knowledgeBudget={totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8})=>createForgeTicket({
  id:'ticket-a',projectId:'11111111-1111-4111-8111-111111111111',workspaceRoot:'D:/workspace/demo',
  title:'Forge lifecycle',description:'Implement the requested lifecycle.',acceptanceCriteria:['Persist valid state.'],
  scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},
  orchestrator:{model:'gpt-6.1-terra',effort:'low'},
  workerProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},
  orchestratorSkills:[],limits:{maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},
  capabilities:{filesystemWriteScope:'instruction-only',knowledgeScope:'instruction-only',toolAuthorization:'instruction-only',cancellation:'monitored',commitScopeValidation:'enforced',finalMergeGate:'enforced'},
  knowledgeBudget,createdAt:at,
});
const planTask=(id:string,dependencyIds:string[]=[]):ForgePlanTaskInput=>({
  id,title:id,description:`Implement ${id}.`,dependencyIds,assignment:assignment(),
  knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
});
const receipt=(status:'complete'|'incomplete'|'failed'='complete')=>({
  status,result:'The assigned work was reviewed.',changes:['src/change.ts'],acceptance:{met:['The behavior works.'],unmet:[]},
  verification:[{check:'Focused tests',result:'passed' as const,evidence:'2 passed'}],risks:[],knowledge:{consulted:['forge-sessions-design'],updated:[]},decision_required:null,
});
const provenance=(workerId='worker-1',attemptId='attempt-a')=>({producerRole:'worker' as const,threadId:`thread-${attemptId}`,turnId:`turn-${attemptId}`,recordedAt:at,artifactRefs:['src/change.ts'],workerId});
const attestation=(sha='a'.repeat(40))=>({status:'verified' as const,commitObserved:true,scopeValidation:'passed' as const,commitSha:sha,observedAt:at,evidenceRefs:['git show --stat']});
const integrationProvenance=(runId='integration-run-a')=>({producerRole:'integrator' as const,threadId:`thread-${runId}`,turnId:`turn-${runId}`,recordedAt:at,artifactRefs:['integration receipt']});
const runningTicket=(limits={maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},tasks:ForgePlanTaskInput[]=[planTask('task-a'),planTask('task-b',['task-a'])],knowledgeBudget={totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8}):ForgeTicket=>{
  const created=createForgeTicket({
    id:'ticket-a',projectId:'11111111-1111-4111-8111-111111111111',workspaceRoot:'D:/workspace/demo',
    title:'Forge lifecycle',description:'Implement the requested lifecycle.',acceptanceCriteria:['Persist valid state.'],
    scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},orchestrator:{model:'gpt-6.1-terra',effort:'low'},
    workerProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},orchestratorSkills:[],limits,
    capabilities:{filesystemWriteScope:'instruction-only',knowledgeScope:'instruction-only',toolAuthorization:'instruction-only',cancellation:'monitored',commitScopeValidation:'enforced',finalMergeGate:'enforced'},knowledgeBudget,createdAt:at,
  });
  const proposed=applyForgeCommand(created,{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'plan-a',tasks},at);
  const accepted=applyForgeCommand(proposed,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
  return applyForgeCommand(accepted,{type:'start',actor:{role:'user',id:'user-1'}},at);
};
const claim=(ticket:ForgeTicket,taskId='task-a',ownerId='worker-1',attemptId='attempt-a')=>{
  const claimed=applyForgeCommand(ticket,{
    type:'claim_task',actor:{role:'host',id:'scheduler'},taskId,ownerId,claimId:`claim-${attemptId}`,attemptId,claimToken:`token-${attemptId}`,
    runtimeId:`runtime-${attemptId}`,branch:`forge/${taskId}/${attemptId}`,worktreeRoot:`D:/workspace/demo/.forge/${taskId}`,sourceBaselineSha:'c'.repeat(40),
  } as Extract<Parameters<typeof applyForgeCommand>[1],{type:'claim_task'}>,at);
  const prepared=applyForgeCommand(claimed,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId,ownerId,attemptId,claimToken:`token-${attemptId}`,dispatchBaselineSha:'d'.repeat(40)},at);
  return applyForgeCommand(prepared,{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId,ownerId,attemptId,claimToken:`token-${attemptId}`,threadId:`thread-${attemptId}`,turnId:`turn-${attemptId}`} as Extract<Parameters<typeof applyForgeCommand>[1],{type:'record_attempt_runtime'}>,at);
};
const acceptOutcome=(ticket:ForgeTicket,patch:Partial<Extract<Parameters<typeof applyForgeCommand>[1],{type:'accept_worker_outcome'}>>={})=>applyForgeCommand(ticket,{
  type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-1',attemptId:'attempt-a',claimToken:'token-attempt-a',
  outcomeId:'outcome-a',receiptId:'receipt-a',receipt:receipt(),provenance:provenance(),hostAttestation:attestation(),retryable:true,...patch,
} as Extract<Parameters<typeof applyForgeCommand>[1],{type:'accept_worker_outcome'}>,at);
const readyForIntegration=(limits={maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},knowledgeBudget={totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8})=>{
  const started=runningTicket(limits,[planTask('task-a')],knowledgeBudget);
  return acceptOutcome(claim(started));
};
const integrationRunInput=(ticket:ForgeTicket,id='integration-run-a')=>({
  id,ownerId:`owner-${id}`,projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,requestedProfile:ticket.workerProfile,
  branch:`forge/${ticket.id}/integration/${id}`,targetBranch:ticket.targetBranch,worktreeRoot:`${ticket.workspaceRoot}/.forge/integration/${id}`,sourceBaselineSha:'c'.repeat(40),
  scopes:structuredClone(ticket.scope),skillSnapshots:[],...(ticket.integration.correctionRounds.length?{correctionRoundId:ticket.integration.correctionRounds.at(-1)!.id}:{}),
});
const beginIntegration=(ticket:ForgeTicket,runId='integration-run-a')=>{
  const prepared=applyForgeCommand(ticket,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(ticket,runId)},at);
  return applyForgeCommand(prepared,{type:'record_integration_runtime',actor:{role:'host',id:'integrator-runtime'},runId,threadId:`thread-${runId}`,turnId:`turn-${runId}`},at);
};
const planningRunInput=(ticket:ForgeTicket,id='planning-run-a')=>({
  id,ownerId:'planner-runtime',purpose:'planning' as const,projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,
  requestedProfile:{provider:'codex' as const,model:ticket.orchestrator.model,effort:ticket.orchestrator.effort},
  scopes:{read:[...ticket.scope.read],write:[],knowledge:[...ticket.scope.knowledge]},skillSnapshots:[],expectedPlanRevision:ticket.planRevision+1,sourceBaselineSha:'c'.repeat(40),
});
const finalReviewRunInput=(ticket:ForgeTicket,id='review-run-a')=>{
  const value=ticket.integration.candidates.find(row=>row.id===ticket.integration.activeCandidateId)!;
  return {id,ownerId:'review-runtime',purpose:'final_review' as const,projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,
    requestedProfile:{provider:'codex' as const,model:ticket.orchestrator.model,effort:ticket.orchestrator.effort},
    scopes:{read:[...ticket.scope.read],write:[],knowledge:[...ticket.scope.knowledge]},skillSnapshots:[],expectedPlanRevision:ticket.acceptedPlan!.revision,
    candidateId:value.id,candidateSha:value.candidateSha,targetMainSha:value.targetMainSha,targetBranch:value.targetBranch};
};
const readyForFinalReview=(knowledgeBudget={totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8})=>recordCandidate(beginIntegration(readyForIntegration({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},knowledgeBudget)));
const candidate=(ticket:ForgeTicket,patch:Partial<ForgeIntegrationCandidate>={}):ForgeIntegrationCandidate=>({
  id:'candidate-a',integratorRunId:ticket.integration.activeRunId!,candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:ticket.targetBranch,
  workerCommits:[{taskId:'task-a',attemptId:ticket.attempts.at(-1)!.id,receiptId:ticket.attempts.at(-1)!.receiptId!,commitSha:ticket.attempts.at(-1)!.commitSha!}],
  scopeValidation:{status:'passed',evidence:['all changed paths were in the approved write scope']},
  verification:[{check:'Focused tests',result:'passed',evidence:'passed'}],combinedReceipt:receipt(),provenance:integrationProvenance(ticket.integration.activeRunId!),findings:[],createdAt:at,...patch,
});
const recordCandidate=(ticket:ForgeTicket,value=candidate(ticket))=>applyForgeCommand(ticket,{type:'record_integration_candidate',actor:{role:'host',id:'git-adapter'},candidate:value},at);
const correctionAssignment=(patch:Partial<Extract<Parameters<typeof applyForgeCommand>[1],{type:'request_corrections'}>['items'][number]['assignment']>={})=>({
  assignment:assignment(),executionProfile:{provider:'codex' as const,model:'gpt-6-luna',effort:'max' as const},skillSnapshots:[],knowledgeScope:['knowledge/opnex'],...patch,
});

describe('Forge plan acceptance',()=>{
  it('applies finite Forge defaults to ticket input and validates configured limits',()=>{
    const parsed=forgeTicketInputSchema.parse({
      projectId:'11111111-1111-4111-8111-111111111111',
      title:'Ticket',description:'Build it.',acceptanceCriteria:['It works.'],scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},
      orchestrator:{model:'gpt-6.1-terra',effort:'low'},workerProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},
    });
    expect(parsed.limits).toEqual({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3});
    expect(parsed.knowledgeBudget).toEqual({totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8});
    expect(ticket().capabilities.operationBudget).toBe('instruction-only');
    expect(parsed.skillIds).toEqual([]);
    const allowed={projectId:'11111111-1111-4111-8111-111111111111',title:'Ticket',description:'Build it.',acceptanceCriteria:['It works.'],scope:{read:[],write:[],knowledge:[]},orchestrator:{model:'orch',effort:'low' as const},workerProfile:{provider:'codex' as const,model:'worker',effort:'max' as const}};
    expect(()=>forgeTicketInputSchema.parse({...allowed,limits:{maxActiveWorkers:33}})).toThrow();
    expect(()=>forgeTicketInputSchema.parse({...allowed,limits:{maxActiveWorkers:4,maxExecutionAttempts:3,maxCorrectionRounds:4}})).toThrow();
    expect(()=>createForgeTicket({...ticket(),scope:{read:['src'],write:['../outside'],knowledge:['knowledge/opnex']}})).toThrow(/scope|traversal/i);
  });

  it('accepts a ticket input with only a task description and fills safe defaults',()=>{
    const parsed=forgeTicketInputSchema.parse({projectId:'11111111-1111-4111-8111-111111111111',description:'# Fix the cache\nKeep existing behavior.'});
    expect(parsed.title).toBe('Fix the cache');
    expect(parsed.acceptanceCriteria).toEqual([]);
    expect(parsed.scope).toEqual({read:['.'],write:['.'],knowledge:[]});
    expect(parsed.orchestrator).toBeUndefined();
    expect(parsed.limits).toEqual({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3});
    expect(parsed.knowledgeBudget).toEqual({totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8});
    const created=createForgeTicket({...ticket(),title:parsed.title,acceptanceCriteria:parsed.acceptanceCriteria});
    expect(created.acceptanceCriteria).toEqual([]);
  });

  it('accepts a valid single-task plan and starts the task open',()=>{
    const proposed=applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
    const accepted=applyForgeCommand(proposed,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);

    expect(accepted.acceptedPlan?.revision).toBe(1);
    expect(accepted.workitems).toMatchObject([{id:'task-a',state:'open',dependencyIds:[]}]);
    expect(accepted.acceptedPlan?.tasks[0].assignment).toMatchObject({revision:1,executionProfile:{model:'gpt-6-luna',effort:'max'}});
  });

  it('exposes and enforces the separate v1 total work-item limit',()=>{
    expect(MAX_FORGE_WORKITEMS).toBe(16);
    const tasks=Array.from({length:MAX_FORGE_WORKITEMS},(_,index)=>planTask(`task-${index+1}`));
    const accepted=applyForgeCommand(applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'sixteen-tasks',tasks},at),{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
    expect(accepted.workitems).toHaveLength(16);
    expect(()=>applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'seventeen-tasks',tasks:[...tasks,planTask('task-17')]},at)).toThrow(/at most 16 work items/i);
  });

  it('rejects a plan with a missing dependency before it can be accepted',()=>{
    expect(()=>applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'plan-a',tasks:[planTask('task-a',['missing'])]},at)).toThrow(/depend/i);
  });

  it('rejects dependency cycles and scope expansion in a proposed plan',()=>{
    expect(()=>applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'cycle',tasks:[planTask('task-a',['task-b']),planTask('task-b',['task-a'])]},at)).toThrow(/acyclic|cycle/i);
    expect(()=>applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'scope',tasks:[{...planTask('task-a'),assignment:assignment(['outside'])}]},at)).toThrow(/scope/i);
    expect(()=>applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'substitution',tasks:[{...planTask('task-a'),executionProfile:{provider:'deepseek',model:'other-model',effort:'high'}}]},at)).toThrow(/selected/i);
  });

  it('treats the relative workspace root as a valid bounded scope',()=>{
    const withinWorkspace=ticket();withinWorkspace.scope={read:['.'],write:['.'],knowledge:['knowledge/opnex']};
    expect(()=>applyForgeCommand(withinWorkspace,{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'workspace-root',tasks:[planTask('task-a')]},at)).not.toThrow();
  });

  it('keeps accepted plan snapshots immutable and rejects worker plan approval',()=>{
    const plan=applyForgeCommand(ticket(),{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
    expect(()=>applyForgeCommand(plan,{type:'accept_plan',actor:{role:'worker',id:'worker-1'},revision:1},at)).toThrow(/actor/i);
    const accepted=applyForgeCommand(plan,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
    expect(()=>applyForgeCommand(accepted,{type:'submit_manual_plan',actor:{role:'user',id:'orch-1'},planId:'plan-b',tasks:[planTask('task-b')]},at)).toThrow(/changed|immutable/i);
    expect(accepted.acceptedPlan?.tasks.map(row=>row.id)).toEqual(['task-a']);
  });

  it('rejects persisted workitems marked finished without matching host-attested receipt evidence',()=>{
    const planned=runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a')]);
    const forged=structuredClone(planned);forged.workitems[0].state='finished';
    expect(()=>forgeTicketSchema.parse(forged)).toThrow(/complete receipt|attested commit/i);
    expect(()=>applyForgeCommand(forged,{type:'pause',actor:{role:'user',id:'user-1'}},at)).toThrow(/complete receipt|attested commit/i);
  });

  it('rejects persisted live attempts that are detached from their workitem active-attempt pointer',()=>{
    const detached=claim(runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a')]));
    detached.workitems[0].state='open';delete detached.workitems[0].activeAttemptId;
    expect(()=>forgeTicketSchema.parse(detached)).toThrow(/live Forge attempt/i);
  });
});

describe('Forge internal skill snapshots',()=>{
  it('keeps user selection at twelve while allowing one required internal snapshot and deduplicating immutable revisions',()=>{
    const selected=Array.from({length:12},(_,index)=>skillSnapshot(index));
    const additional=skillSnapshot(12,'agentmem-external','agentmem-r4');
    const userInput={projectId:'11111111-1111-4111-8111-111111111111',title:'Ticket',description:'Build it.',acceptanceCriteria:['It works.'],scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},orchestrator:{model:'orch',effort:'low' as const},workerProfile:{provider:'codex' as const,model:'worker',effort:'max' as const}};
    const selectedIds=Array.from({length:12},(_,index)=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
    expect(forgeTicketInputSchema.parse({...userInput,skillIds:selectedIds}).skillIds).toHaveLength(12);
    expect(()=>forgeTicketInputSchema.parse({...userInput,skillIds:[...selectedIds,'00000000-0000-4000-8000-000000000013']})).toThrow();

    expect(mergeForgeSkillSnapshots(selected,[{...selected[0],role:'worker',loadedAt:at}])).toHaveLength(12);
    expect(mergeForgeSkillSnapshots(selected,[additional])).toHaveLength(13);
    expect(()=>mergeForgeSkillSnapshots([...selected,additional],[skillSnapshot(13,'agentmem-external','agentmem-r5')])).toThrow(/conflicting immutable revisions/i);
    expect(()=>mergeForgeSkillSnapshots([...selected,additional],[skillSnapshot(13)])).toThrow(/at most 13/i);

    expect(forgeTicketSchema.parse({...ticket(),orchestratorSkills:[...selected,additional]}).orchestratorSkills).toHaveLength(13);
    expect(()=>forgeTicketSchema.parse({...ticket(),orchestratorSkills:[...selected,additional,skillSnapshot(13)]})).toThrow();
    expect(forgeAssignmentSnapshotInputSchema.parse({assignment:assignment(),executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[...selected,additional],knowledgeScope:['knowledge/opnex']}).skillSnapshots).toHaveLength(13);
    expect(forgePlanTaskInputSchema.parse({...planTask('skill-task'),skillSnapshots:[...selected,additional]}).skillSnapshots).toHaveLength(13);

    const planning=planningRunInput(ticket());
    expect(forgeOrchestratorRunInputSchema.parse({...planning,skillSnapshots:[...selected,additional]}).skillSnapshots).toHaveLength(13);
    expect(forgeIntegrationRunInputSchema.parse({...integrationRunInput(ticket()),skillSnapshots:[...selected,additional]}).skillSnapshots).toHaveLength(13);

    const claimed=claim(runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[{...planTask('task-a'),skillSnapshots:[...selected,additional]}]));
    expect(claimed.attempts[0]?.skillSnapshots).toHaveLength(13);
  });
});

describe('Forge orchestrator dispatch recovery',()=>{
  it('persists planning context before dispatch and binds the returned plan to the observed run and revision',()=>{
    const prepared=applyForgeCommand(ticket(),{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:planningRunInput(ticket())},at);
    expect(prepared.phase).toBe('planning');
    expect(prepared.activeOrchestratorRunId).toBe('planning-run-a');
    expect(prepared.orchestratorRuns[0]).toMatchObject({id:'planning-run-a',purpose:'planning',status:'prepared',expectedPlanRevision:1,sourceBaselineSha:'c'.repeat(40),scopes:{read:['src'],write:[],knowledge:['knowledge/opnex']}});
    expect(prepared.orchestratorRuns[0]).not.toHaveProperty('threadId');
    expect(()=>applyForgeCommand(prepared,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'manual-plan',tasks:[planTask('task-a')]},at)).toThrow(/model run|planning attempt/i);

    const observed=applyForgeCommand(prepared,{type:'record_orchestrator_runtime',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',threadId:'planner-thread',turnId:'planner-turn',effectiveProfile:{provider:'codex',model:'gpt-6.1-terra',effort:'low'}},at);
    expect(()=>applyForgeCommand(observed,{type:'complete_planning',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',expectedPlanRevision:1,threadId:'other-thread',turnId:'planner-turn',planId:'model-plan',tasks:[planTask('task-a')]},at)).toThrow(/provenance|thread|turn/i);
    expect(()=>applyForgeCommand(observed,{type:'complete_planning',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',expectedPlanRevision:2,threadId:'planner-thread',turnId:'planner-turn',planId:'stale-plan',tasks:[planTask('task-a')]},at)).toThrow(/revision/i);

    const completed=applyForgeCommand(observed,{type:'complete_planning',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',expectedPlanRevision:1,threadId:'planner-thread',turnId:'planner-turn',planId:'model-plan',tasks:[planTask('task-a')]},at);
    expect(completed.orchestratorRuns[0]).toMatchObject({status:'completed',resultPlanId:'model-plan',threadId:'planner-thread',turnId:'planner-turn'});
    expect(completed.proposedPlan).toMatchObject({id:'model-plan',revision:1,source:'model_run',runId:'planning-run-a'});
    expect(completed.activeOrchestratorRunId).toBeUndefined();
    expect(applyForgeCommand(applyForgeCommand(completed,{type:'accept_plan',actor:{role:'user',id:'user-1'},revision:1},at),{type:'start',actor:{role:'user',id:'user-1'}},at).phase).toBe('running');
  });

  it('blocks prepared dispatches after restart and reconciles the exact original run without duplicate relaunch',()=>{
    const prepared=applyForgeCommand(ticket(),{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:planningRunInput(ticket())},at);
    const recovered=applyForgeCommand(prepared,{type:'recover_after_restart',actor:{role:'host',id:'state-recovery'}},at);
    expect(recovered.phase).toBe('blocked');
    expect(recovered.orchestratorRuns[0]).toMatchObject({id:'planning-run-a',status:'unknown_after_restart'});
    expect(recovered.orchestratorRuns[0]?.knowledgeAllocation).toEqual(prepared.orchestratorRuns[0]?.knowledgeAllocation);
    expect(recovered.orchestratorRuns[0]).not.toHaveProperty('threadId');
    expect(()=>applyForgeCommand(recovered,{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:planningRunInput(recovered,'duplicate-run')},at)).toThrow(/reconcil|active/i);
    const reconciled=applyForgeCommand(recovered,{type:'reconcile_orchestrator_run',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',status:'still_running',threadId:'observed-thread',turnId:'observed-turn',evidence:'The original planning turn is still running.'},at);
    expect(reconciled.orchestratorRuns[0]).toMatchObject({status:'running',threadId:'observed-thread',turnId:'observed-turn',reconciliation:{status:'still_running',evidence:'The original planning turn is still running.'}});
    expect(reconciled.orchestratorRuns[0]).not.toHaveProperty('effectiveProfile');
    const completed=applyForgeCommand(reconciled,{type:'complete_planning',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',expectedPlanRevision:1,threadId:'observed-thread',turnId:'observed-turn',planId:'plan-after-reconcile',tasks:[planTask('task-a')]},at);
    expect(completed.proposedPlan?.runId).toBe('planning-run-a');
  });

  it('pins final review to the candidate, target main, and accepted plan revision',()=>{
    const ready=readyForFinalReview();
    const prepared=applyForgeCommand(ready,{type:'begin_orchestrator_run',actor:{role:'host',id:'review-runtime'},run:finalReviewRunInput(ready)},at);
    expect(prepared.phase).toBe('review');
    expect(prepared.orchestratorRuns[0]).toMatchObject({purpose:'final_review',status:'prepared',candidateId:'candidate-a',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',expectedPlanRevision:1});
    const observed=applyForgeCommand(prepared,{type:'record_orchestrator_runtime',actor:{role:'host',id:'review-runtime'},runId:'review-run-a',threadId:'review-thread',turnId:'review-turn'},at);
    const reviewCommand={type:'complete_candidate_review' as const,actor:{role:'host' as const,id:'review-runtime'},runId:'review-run-a',expectedPlanRevision:1,threadId:'review-thread',turnId:'review-turn',candidateId:'candidate-a',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept' as const,note:'The candidate review passed.'};
    expect(()=>applyForgeCommand(observed,{...reviewCommand,candidateSha:'d'.repeat(40)},at)).toThrow(/candidate|main sha/i);
    expect(()=>applyForgeCommand(observed,{...reviewCommand,expectedPlanRevision:2},at)).toThrow(/revision/i);
    const reviewed=applyForgeCommand(observed,reviewCommand,at);
    expect(reviewed.phase).toBe('merge_ready');
    expect(reviewed.integration.reviewDecisions[0]).toMatchObject({source:'model_run',runId:'review-run-a',candidateId:'candidate-a',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40)});
    expect(reviewed.orchestratorRuns[0]).toMatchObject({status:'completed',resultReviewId:reviewed.integration.reviewDecisions[0]?.id});
  });
});

describe('Forge immutable local target branch',()=>{
  it('rejects target-branch substitutions at integration, final review, approval, and merge readback',()=>{
    const integrationReady=readyForIntegration();
    expect(()=>applyForgeCommand(integrationReady,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:{...integrationRunInput(integrationReady),targetBranch:'origin/main'}},at)).toThrow(/pinned local target branch/i);

    const ready=readyForFinalReview();
    expect(()=>applyForgeCommand(ready,{type:'begin_orchestrator_run',actor:{role:'host',id:'review-runtime'},run:{...finalReviewRunInput(ready),targetBranch:'origin/main'}},at)).toThrow(/target branch/i);
    expect(()=>applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'origin/main',disposition:'accept',note:'Reviewed the remote ref.'},at)).toThrow(/local target branch/i);

    const reviewed=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Reviewed the pinned local branch.'},at);
    expect(()=>applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'origin/main',observedMainSha:'c'.repeat(40)},at)).toThrow(/pinned local target branch/i);
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    expect(()=>applyForgeCommand(merging,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'failed',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'origin/main',preMergeMainSha:'c'.repeat(40),observedMainSha:'c'.repeat(40)},at)).toThrow(/local target branch/i);
  });
});

describe('Forge shared knowledge budget',()=>{
  it('reserves before planning dispatch, retains failed reservations, records actual usage without clamping, and rejects stale reports',()=>{
    const configured={totalOperations:3,defaultAllocationOperations:2,maxAllocationOperations:8};
    const prepared=applyForgeCommand(ticket(configured),{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:planningRunInput(ticket(configured))},at);
    expect(prepared.orchestratorRuns[0]?.knowledgeAllocation).toMatchObject({operations:2,ownerId:'planner-runtime',reservedBy:'planner-runtime',status:'reserved'});
    expect(forgeKnowledgeBudgetBalance(prepared)).toEqual({totalOperations:3,allocatedOperations:2,remainingOperations:1});
    expect(()=>applyForgeCommand(ticket(configured),{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:{...planningRunInput(ticket(configured)),id:'too-large',knowledgeAllocation:9}},at)).toThrow(/per-run maximum|allocation/i);

    const observed=applyForgeCommand(prepared,{type:'record_orchestrator_runtime',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',threadId:'planner-thread',turnId:'planner-turn'},at);
    const usage={type:'record_knowledge_usage' as const,actor:{role:'host' as const,id:'planner-runtime'},targetType:'planning' as const,targetId:'planning-run-a',operations:11,source:'runtime_observed' as const,threadId:'planner-thread',turnId:'planner-turn',evidence:'Provider event stream reported eleven knowledge operations.'};
    expect(()=>applyForgeCommand(observed,{...usage,threadId:'stale-thread'},at)).toThrow(/exact observed provider/i);
    const reported=applyForgeCommand(observed,usage,at);
    expect(reported.orchestratorRuns[0]?.knowledgeAllocation).toMatchObject({status:'reported',operations:2,usage:{operations:11,source:'runtime_observed',threadId:'planner-thread',turnId:'planner-turn'}});
    expect(reported.orchestratorRuns[0]?.knowledgeAllocation?.usage?.operations).toBe(11);
    expect(applyForgeCommand(reported,usage,at)).toEqual(reported);
    expect(()=>applyForgeCommand(reported,{...usage,operations:12},at)).toThrow(/different knowledge usage/i);
    const failed=applyForgeCommand(reported,{type:'fail_orchestrator_run',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',failureReason:'The planner provider failed.'},at);
    expect(failed.orchestratorRuns[0]?.knowledgeAllocation?.operations).toBe(2);
    expect(forgeKnowledgeBudgetBalance(failed)).toEqual({totalOperations:3,allocatedOperations:2,remainingOperations:1});
    expect(()=>applyForgeCommand(failed,{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:{...planningRunInput(failed,'planning-run-b'),knowledgeAllocation:2}},at)).toThrow(/insufficient unallocated/i);
  });

  it('shares reservations across worker, integrator, and final-review dispatches',()=>{
    const ready=readyForFinalReview({totalOperations:5,defaultAllocationOperations:2,maxAllocationOperations:2});
    expect(forgeKnowledgeBudgetBalance(ready)).toEqual({totalOperations:5,allocatedOperations:4,remainingOperations:1});
    expect(ready.attempts[0]?.knowledgeAllocation).toMatchObject({operations:2,ownerId:'worker-1',status:'reserved'});
    expect(ready.integration.runs[0]?.knowledgeAllocation).toMatchObject({operations:2,ownerId:'owner-integration-run-a',status:'reserved'});
    expect(()=>applyForgeCommand(ready,{type:'begin_orchestrator_run',actor:{role:'host',id:'review-runtime'},run:finalReviewRunInput(ready)},at)).toThrow(/insufficient unallocated/i);
  });
});

describe('Forge durable worker attempts',()=>{
  it('persists the dependency-merged dispatch baseline without rewriting the original claim source',()=>{
    const started=runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a')]);
    const claimed=applyForgeCommand(started,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',claimId:'claim-baseline',attemptId:'attempt-baseline',claimToken:'token-baseline',runtimeId:'runtime-baseline',branch:'forge/task-a/attempt-baseline',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'a'.repeat(40)},at);
    expect(claimed.attempts[0]).toMatchObject({sourceBaselineSha:'a'.repeat(40)});
    expect(claimed.attempts[0]).not.toHaveProperty('dispatchBaselineSha');
    expect(()=>applyForgeCommand(claimed,{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-baseline',claimToken:'token-baseline',threadId:'thread-baseline',turnId:'turn-baseline'},at)).toThrow(/dispatch baseline/i);

    const prepared=applyForgeCommand(claimed,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-baseline',claimToken:'token-baseline',dispatchBaselineSha:'b'.repeat(40)},at);
    expect(prepared.attempts[0]).toMatchObject({sourceBaselineSha:'a'.repeat(40),dispatchBaselineSha:'b'.repeat(40)});
    expect(()=>applyForgeCommand(prepared,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-baseline',claimToken:'token-baseline',dispatchBaselineSha:'c'.repeat(40)},at)).toThrow(/immutable/i);
    const observed=applyForgeCommand(prepared,{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-baseline',claimToken:'token-baseline',threadId:'thread-baseline',turnId:'turn-baseline'},at);
    expect(observed.attempts[0]).toMatchObject({dispatchBaselineSha:'b'.repeat(40),threadId:'thread-baseline',turnId:'turn-baseline'});
  });

  it('retains proved pre-provider failures without synthetic provider or receipt IDs and consumes finite attempts',()=>{
    const started=runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a')]);
    const firstClaim=applyForgeCommand(started,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',claimId:'claim-preflight-a',attemptId:'attempt-preflight-a',claimToken:'token-preflight-a',runtimeId:'runtime-preflight-a',branch:'forge/task-a/first',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'a'.repeat(40)},at);
    const firstFailure={type:'fail_attempt_preflight' as const,actor:{role:'host' as const,id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-preflight-a',claimToken:'token-preflight-a',stage:'dependency_merge' as const,failureReason:'A dependency commit could not be prepared.',evidence:['The merge adapter rejected the dependency tree before provider dispatch.']};
    const retriable=applyForgeCommand(firstClaim,firstFailure,at);
    expect(retriable.workitems[0]).toMatchObject({state:'open'});
    expect(retriable.attempts[0]).toMatchObject({status:'preflight_failed',sourceBaselineSha:'a'.repeat(40),preflightFailure:{stage:'dependency_merge',reason:firstFailure.failureReason,evidence:firstFailure.evidence}});
    expect(retriable.attempts[0]).not.toHaveProperty('threadId');
    expect(retriable.attempts[0]).not.toHaveProperty('outcomeId');
    expect(retriable.attempts[0]).not.toHaveProperty('receiptId');
    expect(retriable.receipts).toHaveLength(0);
    expect(retriable.attempts[0]?.knowledgeAllocation).toMatchObject({operations:2,status:'reserved'});
    expect(applyForgeCommand(retriable,firstFailure,at)).toEqual(retriable);

    const secondClaim=applyForgeCommand(retriable,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-b',claimId:'claim-preflight-b',attemptId:'attempt-preflight-b',claimToken:'token-preflight-b',runtimeId:'runtime-preflight-b',branch:'forge/task-a/second',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'a'.repeat(40)},at);
    const prepared=applyForgeCommand(secondClaim,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-b',attemptId:'attempt-preflight-b',claimToken:'token-preflight-b',dispatchBaselineSha:'b'.repeat(40)},at);
    const providerStartFailure={type:'fail_attempt_preflight' as const,actor:{role:'host' as const,id:'scheduler'},taskId:'task-a',ownerId:'worker-b',attemptId:'attempt-preflight-b',claimToken:'token-preflight-b',stage:'provider_start' as const,effect:'confirmed_not_started' as const,failureReason:'The provider explicitly rejected the start request.',evidence:['The adapter confirmed no provider turn was created.']};
    const blocked=applyForgeCommand(prepared,providerStartFailure,at);
    expect(blocked.workitems[0]).toMatchObject({state:'blocked',blockedReason:{kind:'execution_issue',code:'preflight_failed',attemptId:'attempt-preflight-b'}});
    expect(blocked.attempts.map(row=>row.status)).toEqual(['preflight_failed','preflight_failed']);
    expect(blocked.receipts).toHaveLength(0);
  });

  it('keeps uncertain in-process provider starts blocked until their exact claim is reconciled',()=>{
    const started=runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a')]);
    const claimed=applyForgeCommand(started,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',claimId:'claim-uncertain',attemptId:'attempt-uncertain',claimToken:'token-uncertain',runtimeId:'runtime-uncertain',branch:'forge/task-a/uncertain',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'a'.repeat(40)},at);
    const prepared=applyForgeCommand(claimed,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-uncertain',claimToken:'token-uncertain',dispatchBaselineSha:'b'.repeat(40)},at);
    const uncertain=applyForgeCommand(prepared,{type:'mark_attempt_effect_uncertain',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-uncertain',claimToken:'token-uncertain',evidence:'The turn-start request was sent but the connection ended before an ID was observed.'},at);
    expect(uncertain).toMatchObject({phase:'blocked',workitems:[{state:'blocked',activeAttemptId:'attempt-uncertain',blockedReason:{kind:'execution_issue',code:'unknown_effect'}}],attempts:[{status:'unknown_effect'}]});
    expect(()=>applyForgeCommand(uncertain,{type:'fail_attempt_preflight',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-uncertain',claimToken:'token-uncertain',stage:'provider_start',effect:'confirmed_not_started',failureReason:'No provider turn was created.',evidence:['Uncertain error.']},at)).toThrow(/known no-effect|uncertain/i);
    expect(()=>applyForgeCommand(uncertain,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-b',claimId:'claim-duplicate',attemptId:'attempt-duplicate',claimToken:'token-duplicate',runtimeId:'runtime-duplicate',branch:'forge/task-a/duplicate',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'a'.repeat(40)},at)).toThrow(/accept|claim/i);
    expect(()=>applyForgeCommand(uncertain,{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-uncertain',claimToken:'token-uncertain',status:'still_running',evidence:'The exact provider actor is live.'},at)).toThrow(/observed provider IDs/i);
    const reconciled=applyForgeCommand(uncertain,{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-uncertain',claimToken:'token-uncertain',status:'still_running',threadId:'thread-observed',turnId:'turn-observed',evidence:'The exact original provider actor is live.'},at);
    expect(reconciled).toMatchObject({phase:'running',workitems:[{state:'claimed',activeAttemptId:'attempt-uncertain'}],attempts:[{status:'claimed',threadId:'thread-observed',turnId:'turn-observed'}]});
  });

  it('atomically claims a ready task, rejects stale owners, and accepts the outcome once',()=>{
    const started=runningTicket();
    expect(started.workitems.find(row=>row.id==='task-b')).toMatchObject({state:'blocked',blockedReason:{kind:'dependencies',taskIds:['task-a']}});
    expect(()=>applyForgeCommand(started,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'task-b',ownerId:'worker-2',claimId:'claim-b',attemptId:'attempt-b',claimToken:'token-b',runtimeId:'runtime-b',branch:'forge/task-b',worktreeRoot:'D:/workspace/demo/.forge/task-b',sourceBaselineSha:'c'.repeat(40)},at)).toThrow(/open|ready|depend/i);
    const claimed=claim(started);
    expect(claimed.workitems[0]).toMatchObject({state:'claimed',activeAttemptId:'attempt-a'});
    expect(claimed.attempts[0].claim).toMatchObject({attemptId:'attempt-a',ownerId:'worker-1',token:'token-attempt-a'});
    expect(claimed.attempts[0]).toMatchObject({runtimeId:'runtime-attempt-a',threadId:'thread-attempt-a',turnId:'turn-attempt-a',branch:'forge/task-a/attempt-a',worktreeRoot:'D:/workspace/demo/.forge/task-a',sourceBaselineSha:'c'.repeat(40),scopes:{read:['src'],write:['src'],knowledge:['knowledge/opnex']}});
    expect(()=>acceptOutcome(claimed,{ownerId:'worker-2'})).toThrow(/claim|owner|attempt/i);

    const finished=acceptOutcome(claimed);
    expect(finished.workitems.find(row=>row.id==='task-a')?.state).toBe('finished');
    expect(finished.workitems.find(row=>row.id==='task-b')?.state).toBe('open');
    expect(finished.receipts).toHaveLength(1);
    expect(finished.phase).toBe('running');
    expect(acceptOutcome(finished)).toEqual(finished);
    expect(()=>acceptOutcome(finished,{outcomeId:'late-outcome'})).toThrow(/claim|attempt|stale/i);
  });

  it('does not finish a task from a complete worker receipt without host commit and scope attestation',()=>{
    const claimed=claim(runningTicket());
    const saved=acceptOutcome(claimed,{hostAttestation:undefined});
    expect(saved.workitems.find(row=>row.id==='task-a')).toMatchObject({state:'open',assignmentRevision:1});
    expect(saved.attempts[0]).toMatchObject({status:'failed',outcomeId:'outcome-a',receiptId:'receipt-a'});
    expect(saved.receipts[0].receipt.status).toBe('complete');
  });

  it('requires a worker receipt provenance to match its attached attempt thread and turn',()=>{
    const claimed=claim(runningTicket());
    expect(()=>acceptOutcome(claimed,{provenance:provenance('worker-1','other-attempt')})).toThrow(/provenance|attempt|thread/i);
  });

  it('blocks after the configured execution-attempt limit',()=>{
    const firstClaim=claim(runningTicket({maxActiveWorkers:3,maxExecutionAttempts:1,maxCorrectionRounds:3}));
    const failed=acceptOutcome(firstClaim,{receipt:receipt('failed'),hostAttestation:undefined,failureReason:'The worker could not apply the patch.'});
    expect(failed.workitems.find(row=>row.id==='task-a')).toMatchObject({state:'blocked',blockedReason:{kind:'execution_issue',code:'retry_limit'}});
    expect(()=>claim(failed)).toThrow(/claim/i);
  });

  it('allows one transient retry on the same assignment and counts the replacement attempt',()=>{
    const started=runningTicket();
    const failedOnce=acceptOutcome(claim(started),{receipt:receipt('failed'),hostAttestation:undefined,failureReason:'Temporary provider error.'});
    expect(failedOnce.workitems[0].state).toBe('open');
    const secondClaim=claim(failedOnce,'task-a','replacement-worker','attempt-b');
    expect(secondClaim.attempts).toHaveLength(2);
    const failedTwice=applyForgeCommand(secondClaim,{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'replacement-worker',attemptId:'attempt-b',claimToken:'token-attempt-b',outcomeId:'outcome-b',receiptId:'receipt-b',receipt:receipt('failed'),provenance:provenance('replacement-worker','attempt-b'),retryable:true,failureReason:'The retry also failed.'},at);
    expect(failedTwice.workitems[0]).toMatchObject({state:'blocked',blockedReason:{kind:'execution_issue',code:'retry_limit'}});
    expect(failedTwice.receipts).toHaveLength(2);
  });

  it('limits simultaneous claims even for otherwise open independent tasks',()=>{
    const started=runningTicket({maxActiveWorkers:1,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-c'),planTask('task-d')]);
    const first=claim(started,'task-c','worker-1','attempt-c');
    expect(()=>claim(first,'task-d','worker-2','attempt-d')).toThrow(/active|concurr/i);
  });

  it('counts unknown possibly-live attempts against the worker concurrency limit until reconciliation',()=>{
    const started=runningTicket({maxActiveWorkers:2,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-a'),planTask('task-b'),planTask('task-c'),planTask('task-d')]);
    const twoActive=claim(claim(started,'task-a','worker-a','attempt-a'),'task-b','worker-b','attempt-b');
    const recovered=applyForgeCommand(twoActive,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    const stopped=applyForgeCommand(recovered,{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-attempt-a',status:'stopped',evidence:'The first provider process has exited.'},at);
    expect(stopped.phase).toBe('running');
    expect(()=>claim(stopped,'task-b','worker-b','attempt-b')).toThrow(/reconcile/i);
    const third=claim(stopped,'task-c','worker-c','attempt-c');
    expect(()=>claim(third,'task-d','worker-d','attempt-d')).toThrow(/active|concurr/i);
    expect(third.attempts.find(row=>row.id==='attempt-b')?.status).toBe('unknown_after_restart');
  });
});

describe('Forge pause, cancellation, and restart recovery',()=>{
  it('blocks an unknown live claim after restart and resumes it only after host reconciliation',()=>{
    const claimed=claim(runningTicket());
    const recovered=applyForgeCommand(claimed,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    expect(recovered.workitems.find(row=>row.id==='task-a')).toMatchObject({state:'blocked',activeAttemptId:'attempt-a',blockedReason:{kind:'execution_issue',code:'unknown_after_restart'}});
    expect(recovered.attempts[0].status).toBe('unknown_after_restart');
    expect(applyForgeCommand(recovered,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at)).toEqual(recovered);
    expect(()=>claim(recovered)).toThrow(/claim/i);

    const reconciled=applyForgeCommand(recovered,{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-1',attemptId:'attempt-a',claimToken:'token-attempt-a',status:'still_running',evidence:'Provider confirmed the original turn is still live.'},at);
    expect(reconciled.workitems.find(row=>row.id==='task-a')).toMatchObject({state:'claimed',activeAttemptId:'attempt-a'});
    expect(reconciled.attempts[0]?.reconciliation).toMatchObject({status:'still_running',actorId:'scheduler',evidence:'Provider confirmed the original turn is still live.'});
    expect(reconciled.attempts).toHaveLength(1);
    expect(acceptOutcome(reconciled).workitems.find(row=>row.id==='task-a')?.state).toBe('finished');
  });

  it('does not dispatch while paused or cancelled and keeps claims and receipts',()=>{
    const started=runningTicket({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},[planTask('task-c'),planTask('task-d')]);
    const claimed=claim(started,'task-c','worker-1','attempt-c');
    const paused=applyForgeCommand(claimed,{type:'pause',actor:{role:'user',id:'user-1'}},at);
    expect(paused.phase).toBe('paused');
    expect(()=>claim(paused,'task-d','worker-2','attempt-d')).toThrow(/accept|claim/i);
    const resumed=applyForgeCommand(paused,{type:'resume',actor:{role:'user',id:'user-1'}},at);
    expect(resumed.phase).toBe('running');
    const second=claim(resumed,'task-d','worker-2','attempt-d');
    const cancelled=applyForgeCommand(second,{type:'cancel',actor:{role:'user',id:'user-1'}},at);
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.attempts).toHaveLength(2);
    expect(cancelled.workitems.map(row=>row.state)).toEqual(['claimed','claimed']);
    expect(()=>claim(cancelled,'task-c','worker-3','attempt-c2')).toThrow(/accept|claim/i);
  });

  it('releases a stopped unknown attempt only after host evidence and consumes its attempt allowance',()=>{
    const claimed=claim(runningTicket({maxActiveWorkers:3,maxExecutionAttempts:1,maxCorrectionRounds:3}));
    const recovered=applyForgeCommand(claimed,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    const stopped=applyForgeCommand(recovered,{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-1',attemptId:'attempt-a',claimToken:'token-attempt-a',status:'stopped',evidence:'Provider confirmed the original turn exited.'},at);
    expect(stopped.attempts[0].status).toBe('interrupted');
    expect(stopped.workitems.find(row=>row.id==='task-a')).toMatchObject({state:'blocked',blockedReason:{kind:'execution_issue',code:'retry_limit'}});
    expect(stopped.attempts).toHaveLength(1);
  });
});

describe('Forge integration and main merge',()=>{
  it('requires observed runtime provenance before an integrator effective profile is persisted',()=>{
    const ticket=readyForIntegration();
    const prepared=applyForgeCommand(ticket,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(ticket)},at);
    prepared.integration.runs[0].effectiveProfile={provider:'codex',model:'gpt-6-luna',effort:'max'};
    expect(()=>forgeTicketSchema.parse(prepared)).toThrow(/observed provider runtime/i);
  });

  it('persists a scoped integrator snapshot before start and only records runtime provenance when observed',()=>{
    const ready=readyForIntegration();
    expect(()=>applyForgeCommand(ready,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:{...integrationRunInput(ready),scopes:{read:['src'],write:['outside'],knowledge:['knowledge/opnex']}}},at)).toThrow(/scope/i);
    expect(()=>applyForgeCommand(ready,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:{...integrationRunInput(ready),workspaceRoot:'D:/other-workspace'}},at)).toThrow(/workspace/i);
    const prepared=applyForgeCommand(ready,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(ready)},at);
    expect(prepared.integration.runs[0]).toMatchObject({status:'prepared',branch:'forge/ticket-a/integration/integration-run-a',scopes:ready.scope,requestedProfile:ready.workerProfile});
    expect(prepared.integration.runs[0]?.targetBranch).toBe('main');
    expect(prepared.integration.runs[0]).not.toHaveProperty('threadId');
    expect(()=>applyForgeCommand(prepared,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(ready)},at)).toThrow(/already exists|reconcile/i);
    const running=applyForgeCommand(prepared,{type:'record_integration_runtime',actor:{role:'host',id:'integrator-runtime'},runId:'integration-run-a',threadId:'integrator-thread',turnId:'integrator-turn',effectiveProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'}},at);
    expect(running.integration.runs[0]).toMatchObject({status:'running',threadId:'integrator-thread',turnId:'integrator-turn',effectiveProfile:{model:'gpt-6-luna'}});
  });

  it('retains failed integrator attempts and binds late candidates to the active run',()=>{
    const ready=readyForIntegration();
    const first=beginIntegration(ready,'run-one');
    const failed=applyForgeCommand(first,{type:'fail_integration_run',actor:{role:'host',id:'integrator-runtime'},runId:'run-one',failureReason:'The provider failed before returning a candidate.'},at);
    expect(failed.integration.runs[0]).toMatchObject({status:'failed',failureReason:'The provider failed before returning a candidate.'});
    const second=beginIntegration(failed,'run-two');
    expect(second.integration.runs).toHaveLength(2);
    expect(()=>recordCandidate(second,candidate(second,{id:'late-from-run-one',integratorRunId:'run-one'}))).toThrow(/active integrator run/i);
    const exhausted=applyForgeCommand(second,{type:'fail_integration_run',actor:{role:'host',id:'integrator-runtime'},runId:'run-two',failureReason:'A second provider failure.'},at);
    expect(exhausted.phase).toBe('blocked');
    expect(()=>applyForgeCommand(exhausted,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(failed,'run-three')},at)).toThrow(/can start|ready|limit/i);
    expect(exhausted.integration.runs.map(run=>run.id)).toEqual(['run-one','run-two']);
  });

  it('blocks a prepared integrator run after restart and reconciles without fabricating provenance',()=>{
    const prepared=applyForgeCommand(readyForIntegration(),{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:integrationRunInput(readyForIntegration())},at);
    const recovered=applyForgeCommand(prepared,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    expect(recovered.phase).toBe('blocked');
    expect(recovered.integration.runs[0]).toMatchObject({status:'unknown_after_restart'});
    expect(recovered.integration.runs[0]).not.toHaveProperty('threadId');
    const reconciled=applyForgeCommand(recovered,{type:'reconcile_integration_run',actor:{role:'host',id:'integrator-runtime'},runId:'integration-run-a',status:'still_running',threadId:'integrator-thread',turnId:'integrator-turn',evidence:'The original provider turn is still live.'},at);
    expect(reconciled.phase).toBe('integrating');
    expect(reconciled.integration.runs[0]).toMatchObject({status:'running',threadId:'integrator-thread',turnId:'integrator-turn'});
    expect(reconciled.integration.runs[0]?.reconciliation).toMatchObject({status:'still_running',actorId:'integrator-runtime',evidence:'The original provider turn is still live.'});
  });

  it('saves an active integration result received after the user pauses the ticket',()=>{
    const running=beginIntegration(readyForIntegration());
    const paused=applyForgeCommand(running,{type:'pause',actor:{role:'user',id:'user-1'}},at);
    const saved=recordCandidate(paused);
    expect(saved.phase).toBe('paused');
    expect(saved.pausedFromPhase).toBe('review');
    expect(saved.integration.status).toBe('ready_for_review');
    expect(saved.integration.runs[0]).toMatchObject({status:'completed',candidateId:'candidate-a'});
    expect(applyForgeCommand(saved,{type:'resume',actor:{role:'user',id:'user-1'}},at).phase).toBe('review');
  });

  it('keeps worker completion provisional until candidate review and a matching merge readback',()=>{
    const integrated=recordCandidate(beginIntegration(readyForIntegration()));
    expect(integrated.phase).toBe('review');
    expect(integrated.integration.status).toBe('ready_for_review');
    expect(integrated.integration.candidates[0]?.targetBranch).toBe('main');
    const reviewed=applyForgeCommand(integrated,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Receipt, diff, scopes, and checks are accepted.'},at);
    expect(reviewed.phase).toBe('merge_ready');
    expect(reviewed.integration.reviewDecisions[0]?.targetBranch).toBe('main');
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    expect(merging.phase).toBe('merging');
    expect(merging.integration.mergeIntent?.targetBranch).toBe('main');
    expect(()=>applyForgeCommand(merging,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at)).toThrow(/durable intent|reconcile/i);
    const recovered=applyForgeCommand(merging,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    expect(recovered.phase).toBe('blocked');
    expect(recovered.attentionReason).toMatch(/merge status is unknown/i);
    const complete=applyForgeCommand(recovered,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'merged',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',preMergeMainSha:'c'.repeat(40),observedMainSha:'d'.repeat(40),mergeCommitSha:'d'.repeat(40),commitReadbackSha:'d'.repeat(40)},at);
    expect(complete.phase).toBe('complete');
    expect(complete.integration.mergeReadbacks.at(-1)?.targetBranch).toBe('main');
    expect(complete.completedAt).toBe(at);
    expect(complete.integration.status).toBe('merged');
  });

  it('invalidates review when main changes before the guarded merge',()=>{
    const candidateReady=recordCandidate(beginIntegration(readyForIntegration()));
    const reviewed=applyForgeCommand(candidateReady,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved candidate.'},at);
    const stale=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'e'.repeat(40)},at);
    expect(stale.phase).toBe('integrating');
    expect(stale.integration.activeCandidateId).toBeUndefined();
    expect(stale.integration.staleCandidateIds).toContain('candidate-a');
    expect(stale.integration.status).toBe('not_started');
    expect(stale.phase).not.toBe('complete');
  });

  it('invalidates the candidate if main moves between merge approval and the merge operation',()=>{
    const ready=recordCandidate(beginIntegration(readyForIntegration()));
    const reviewed=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved candidate.'},at);
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    const stale=applyForgeCommand(merging,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'stale',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',preMergeMainSha:'e'.repeat(40),observedMainSha:'e'.repeat(40),detail:'Final pre-merge SHA check rejected the stale target.'},at);
    expect(stale.phase).toBe('integrating');
    expect(stale.integration.staleCandidateIds).toContain('candidate-a');
    expect(stale.integration.mergeReadbacks.at(-1)).toMatchObject({result:'stale',preMergeMainSha:'e'.repeat(40)});
  });

  it('uses the post-check main readback when main moves during merge preflight',()=>{
    const ready=recordCandidate(beginIntegration(readyForIntegration()));
    const reviewed=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved candidate.'},at);
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    const stale=applyForgeCommand(merging,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'stale',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',preMergeMainSha:'c'.repeat(40),observedMainSha:'e'.repeat(40),detail:'Main moved during guarded merge preflight.'},at);
    expect(stale.phase).toBe('integrating');
    expect(stale.integration.staleCandidateIds).toContain('candidate-a');
    expect(stale.integration.mergeReadbacks.at(-1)).toMatchObject({preMergeMainSha:'c'.repeat(40),observedMainSha:'e'.repeat(40)});
  });

  it('releases a recovered merge intent only after readback confirms main did not move',()=>{
    const ready=recordCandidate(beginIntegration(readyForIntegration()));
    const reviewed=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved candidate.'},at);
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    const recovered=applyForgeCommand(merging,{type:'recover_after_restart',actor:{role:'host',id:'scheduler'}},at);
    expect(()=>applyForgeCommand(recovered,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at)).toThrow(/accept|reconcile|merge/i);
    const confirmedNoMerge=applyForgeCommand(recovered,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'failed',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',preMergeMainSha:'c'.repeat(40),observedMainSha:'c'.repeat(40),detail:'Recovery verified that main still points at the approved target.'},at);
    expect(confirmedNoMerge.phase).toBe('merge_ready');
    expect(confirmedNoMerge.integration.mergeIntent).toBeUndefined();
    expect(confirmedNoMerge.integration.mergeReadbacks.at(-1)?.result).toBe('failed');
    expect(applyForgeCommand(confirmedNoMerge,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at).phase).toBe('merging');
  });

  it('resumes paused candidate review and merge approval at the same decision phase',()=>{
    const ready=recordCandidate(beginIntegration(readyForIntegration()));
    const pausedReview=applyForgeCommand(ready,{type:'pause',actor:{role:'user',id:'user-1'}},at);
    expect(applyForgeCommand(pausedReview,{type:'resume',actor:{role:'user',id:'user-1'}},at).phase).toBe('review');
    const accepted=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved candidate.'},at);
    const pausedMerge=applyForgeCommand(accepted,{type:'pause',actor:{role:'user',id:'user-1'}},at);
    expect(applyForgeCommand(pausedMerge,{type:'resume',actor:{role:'user',id:'user-1'}},at).phase).toBe('merge_ready');
  });

  it('reopens only finding-linked tasks within their original scopes and preserves earlier receipts',()=>{
    const ready=beginIntegration(readyForIntegration());
    const finding={id:'finding-a',taskId:'task-a',title:'Missing edge handling',issue:'The input guard is incomplete.',requiredFix:'Handle the empty input.',evidence:['repro from integrator tests']};
    const withFinding=recordCandidate(ready,candidate(ready,{findings:[finding]}));
    expect(withFinding.integration.status).toBe('awaiting_correction');
    const corrected=applyForgeCommand(withFinding,{type:'request_corrections',actor:{role:'integrator',id:'integrator-1'},correctionId:'correction-a',items:[{taskId:'task-a',findingIds:['finding-a'],assignment:correctionAssignment()}]},at);
    expect(corrected.workitems[0]).toMatchObject({state:'open',assignmentRevision:2});
    expect(corrected.integration.correctionRounds).toHaveLength(1);
    expect(corrected.integration.activeCandidateId).toBeUndefined();
    expect(corrected.receipts).toHaveLength(1);
    const correctionClaim=claim(corrected,'task-a','worker-2','attempt-b');
    const correctionDone=applyForgeCommand(correctionClaim,{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-2',attemptId:'attempt-b',claimToken:'token-attempt-b',outcomeId:'outcome-b',receiptId:'receipt-b',receipt:receipt(),provenance:provenance('worker-2','attempt-b'),hostAttestation:attestation('d'.repeat(40)),retryable:true},at);
    expect(correctionDone.phase).toBe('integrating');
    expect(correctionDone.integration.status).toBe('not_started');
    expect(correctionDone.receipts).toHaveLength(2);
    expect(correctionDone.acceptedPlan?.tasks[0].assignment.revision).toBe(1);
    expect(correctionDone.workitems[0].assignmentRevision).toBe(2);
    expect(()=>applyForgeCommand(withFinding,{type:'request_corrections',actor:{role:'integrator',id:'integrator-1'},correctionId:'bad-scope',items:[{taskId:'task-a',findingIds:['finding-a'],assignment:correctionAssignment({assignment:{...assignment(),write_scope:['outside']}})}]},at)).toThrow(/scope/i);
  });

  it('blocks unassigned integration findings and requires each correction round to cover all findings',()=>{
    const ready=beginIntegration(readyForIntegration());
    const unassigned=recordCandidate(ready,candidate(ready,{findings:[{id:'global-finding',title:'Cross-task issue',issue:'The root behavior is inconsistent.',requiredFix:'Resolve ownership.',evidence:['integrator diff review']}]}));
    expect(unassigned.phase).toBe('blocked');
    expect(unassigned.attentionReason).toMatch(/identify an affected Forge task/i);

    const findings=[
      {id:'finding-a',taskId:'task-a',title:'Issue A',issue:'A is incomplete.',requiredFix:'Complete A.',evidence:['test A']},
      {id:'finding-b',taskId:'task-a',title:'Issue B',issue:'B is incomplete.',requiredFix:'Complete B.',evidence:['test B']},
    ];
    const awaiting=recordCandidate(ready,candidate(ready,{id:'candidate-with-two-findings',findings}));
    expect(()=>applyForgeCommand(awaiting,{type:'request_corrections',actor:{role:'integrator',id:'integrator-1'},correctionId:'partial-correction',items:[{taskId:'task-a',findingIds:['finding-a'],assignment:correctionAssignment()}]},at)).toThrow(/every finding/i);
  });

  it('lets final review request a bounded correction and preserves candidate and review findings',()=>{
    const integrated=recordCandidate(beginIntegration(readyForIntegration()));
    const corrected=applyForgeCommand(integrated,{
      type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'request_corrections',note:'The final diff review found a task-level gap.',correctionId:'review-correction-a',
      corrections:[{taskId:'task-a',findings:[{id:'review-finding-a',title:'Missing guard',issue:'The reviewed change misses an input case.',requiredFix:'Handle the empty input.',evidence:['reviewed candidate diff']}],assignment:correctionAssignment()}],
    },at);
    expect(corrected.phase).toBe('running');
    expect(corrected.workitems[0]).toMatchObject({state:'open',assignmentRevision:2});
    expect(corrected.integration.candidates[0].candidateSha).toBe('b'.repeat(40));
    expect(corrected.integration.supersededCandidateIds).toContain('candidate-a');
    expect(corrected.integration.correctionRounds[0]).toMatchObject({source:'final_review',candidateId:'candidate-a',findings:[{id:'review-finding-a',taskId:'task-a'}]});
    expect(corrected.integration.reviewDecisions[0]).toMatchObject({disposition:'request_corrections',correctionRoundId:'review-correction-a'});
  });

  it('blocks correction dispatch when the ticket correction allowance is exhausted',()=>{
    const ready=beginIntegration(readyForIntegration({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:0}));
    const finding={id:'finding-a',taskId:'task-a',title:'Missing edge handling',issue:'The input guard is incomplete.',requiredFix:'Handle the empty input.',evidence:['integrator test']};
    const withFinding=recordCandidate(ready,candidate(ready,{findings:[finding]}));
    const blocked=applyForgeCommand(withFinding,{type:'request_corrections',actor:{role:'integrator',id:'integrator-1'},correctionId:'correction-a',items:[{taskId:'task-a',findingIds:['finding-a'],assignment:correctionAssignment()}]},at);
    expect(blocked.phase).toBe('blocked');
    expect(blocked.integration.status).toBe('blocked');
    expect(blocked.workitems[0].assignmentRevision).toBe(1);
  });

  it('refuses to complete when main does not read back the actual merge commit',()=>{
    const ready=recordCandidate(beginIntegration(readyForIntegration()));
    const reviewed=applyForgeCommand(ready,{type:'submit_manual_candidate_review',actor:{role:'user',id:'root-orchestrator'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',disposition:'accept',note:'Approved.'},at);
    const merging=applyForgeCommand(reviewed,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',observedMainSha:'c'.repeat(40)},at);
    expect(()=>applyForgeCommand(merging,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'merged',candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:'main',preMergeMainSha:'c'.repeat(40),observedMainSha:'e'.repeat(40),mergeCommitSha:'d'.repeat(40),commitReadbackSha:'f'.repeat(40)},at)).toThrow(/read back/i);
    expect(merging.phase).toBe('merging');
  });
});
