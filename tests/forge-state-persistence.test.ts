import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const testRoot=path.resolve('D:/programming/opnex-forge-private/forge-domain/tests');
let currentDirectory:string|undefined;
const stamp='2026-10-31T00:00:00.000Z';
const projectId='11111111-1111-4111-8111-111111111111';

async function makeDirectory(){
  await mkdir(testRoot,{recursive:true});
  currentDirectory=path.join(testRoot,randomUUID());
  expect(path.dirname(currentDirectory)).toBe(testRoot);
  await mkdir(currentDirectory,{recursive:true});
  return currentDirectory;
}
async function createForgeState(directory:string,id='forge-session-a'){
  const workspaceRoot=path.join(directory,'workspace');await mkdir(workspaceRoot);
  vi.stubEnv('OPNEX_DATA_DIR',path.join(directory,'data'));vi.resetModules();
  const state=await import('../server/state.js');
  await state.loadState();
  await state.mutate(value=>state.saveProjectInState(value,{id:projectId,name:'Forge workspace',projectRoot:workspaceRoot,needsLocation:false,pinned:false}));
  await state.createForgeSession(ticketInput(workspaceRoot,id));
  return {state,workspaceRoot};
}
function ticketInput(workspaceRoot:string,id='forge-session-a'){
  return {
    id,projectId,workspaceRoot,title:'Forge persistence',description:'Keep this ticket durable.',acceptanceCriteria:['A Forge payload is saved.'],
    scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},orchestrator:{model:'gpt-6.1-terra',effort:'low' as const},
    workerProfile:{provider:'codex' as const,model:'gpt-6-luna',effort:'max' as const},orchestratorSkills:[],
    limits:{maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},
    capabilities:{filesystemWriteScope:'instruction-only' as const,knowledgeScope:'instruction-only' as const,operationBudget:'instruction-only' as const,toolAuthorization:'instruction-only' as const,cancellation:'monitored' as const,commitScopeValidation:'enforced' as const,finalMergeGate:'enforced' as const},createdAt:stamp,
  };
}
function v5State(taskId='old-session'){
  return {version:5,revision:8,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'},tasks:[{
    id:taskId,title:'Historical Conversation',phase:'accepted',createdAt:stamp,updatedAt:stamp,userRoot:'D:/old-workspace',
    userMessages:['Keep this old message.'],messages:[{id:'message-a',role:'user',text:'Keep this old message.',createdAt:stamp}],
    passes:[{id:'pass-a',index:1,createdAt:stamp,userInput:'Keep this old message.',userInputs:['Keep this old message.'],userMessageIds:['message-a'],phase:'accepted',correctionCount:0,processedTurns:[]}],
    currentPassId:'pass-a',correctionCount:0,processedTurns:[],
  }],activeTaskId:null,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']};
}

afterEach(async()=>{
  vi.unstubAllEnvs();vi.resetModules();
  if(currentDirectory){
    const target=path.resolve(currentDirectory),relative=path.relative(testRoot,target);
    if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))await rm(target,{recursive:true,force:true});
  }
  currentDirectory=undefined;
});

describe('Forge state persistence',()=>{
  it('migrates historical sessions to Conversation without changing saved history',async()=>{
    const {upgradeStoredState}=await import('../server/state.js');
    const input=v5State();
    const migrated=upgradeStoredState(structuredClone(input));
    expect(migrated.version).toBe(7);
    expect(migrated.tasks[0]).toMatchObject({sessionType:'conversation',title:'Historical Conversation',userMessages:input.tasks[0].userMessages,messages:input.tasks[0].messages,passes:input.tasks[0].passes,currentPassId:'pass-a'});
    expect(migrated.tasks[0].forge).toBeUndefined();
    expect(migrated.tasks[0].toolCalls).toBeUndefined();
  });

  it('backs up the original version-five file before persisting the Conversation migration',async()=>{
    const directory=await makeDirectory();
    const source=JSON.stringify(v5State());
    await writeFile(path.join(directory,'state.json'),source,{encoding:'utf8'});
    vi.stubEnv('OPNEX_DATA_DIR',directory);vi.resetModules();
    const state=await import('../server/state.js');
    const loaded=await state.loadState();
    const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
    const backups=(await readdir(directory)).filter(name=>name.startsWith('state.json.pre-migration-')&&name.endsWith('.bak'));
    expect(loaded.version).toBe(7);
    expect(saved.version).toBe(7);
    expect(saved.tasks[0].sessionType).toBe('conversation');
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(directory,backups[0]),'utf8')).toBe(source);
  });

  it('preserves an unsupported Forge state file for manual repair',async()=>{
    const directory=await makeDirectory();
    const invalid={version:6,revision:0,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'},tasks:[{
      id:'broken-forge',title:'Do not overwrite',phase:'accepted',createdAt:stamp,updatedAt:stamp,userRoot:'D:/workspace',userMessages:['Keep this record.'],messages:[],correctionCount:0,processedTurns:[],sessionType:'forge',forge:{schemaVersion:1},
    }],activeTaskId:null,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']};
    const source=JSON.stringify(invalid);
    await writeFile(path.join(directory,'state.json'),source,{encoding:'utf8'});
    vi.stubEnv('OPNEX_DATA_DIR',directory);vi.resetModules();
    const state=await import('../server/state.js');
    await expect(state.loadState()).rejects.toThrow(/unsupported format/i);
    expect(await readFile(path.join(directory,'state.json'),'utf8')).toBe(source);
    expect((await readdir(directory)).filter(name=>name.endsWith('.bak'))).toHaveLength(0);
  });

  it('migrates a version-six Forge ticket to an empty top-level tool log and backs up the original',async()=>{
    const directory=await makeDirectory();
    await createForgeState(directory);
    const file=path.join(directory,'data','state.json');
    const old=JSON.parse(await readFile(file,'utf8'));
    old.version=6;delete old.tasks[0].toolCalls;delete old.tasks[0].forge.orchestratorRuns;delete old.tasks[0].forge.activeOrchestratorRunId;delete old.tasks[0].forge.targetBranch;delete old.tasks[0].forge.approvalPolicy;
    const source=JSON.stringify(old);await writeFile(file,source,'utf8');
    vi.resetModules();
    const state=await import('../server/state.js');const migrated=await state.loadState();
    expect(migrated.version).toBe(7);
    expect(migrated.tasks[0]).toMatchObject({sessionType:'forge',toolCalls:{schemaVersion:1,total:0,statusCounts:{started:0,completed:0,failed:0,interrupted:0},calls:[],seen:{},omittedCount:0}});
    expect(migrated.tasks[0].forge?.orchestratorRuns).toEqual([]);
    expect(migrated.tasks[0].forge).toMatchObject({targetBranch:'main',approvalPolicy:'on-request'});
    const backups=(await readdir(path.dirname(file))).filter(name=>name.startsWith('state.json.pre-migration-')&&name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file),backups[0]),'utf8')).toBe(source);
  });

  it('persists Forge role tool calls through the existing log reducer and does not replay them on load',async()=>{
    const directory=await makeDirectory();
    const {state}=await createForgeState(directory);
    const event={identity:{provider:'codex',agentId:'planner',threadId:'planner-thread',turnId:'planner-turn',callId:'provider-call-a'},name:'read_file',type:'function_call',source:'application' as const,lifecycle:'started' as const,timestamp:stamp,agentRole:'orchestrator'};
    await state.recordForgeToolCall('forge-session-a',event);
    await state.recordForgeToolCall('forge-session-a',{...event,source:'model'});
    const first=state.getTask('forge-session-a')?.toolCalls;
    expect(first).toMatchObject({total:1,statusCounts:{started:1,completed:0,failed:0,interrupted:0},calls:[{identity:{callId:'provider-call-a'},sources:['application','model']}]});
    expect(state.getTask('forge-session-a')?.passes).toBeUndefined();
    vi.resetModules();
    const reloaded=await import('../server/state.js');
    expect((await reloaded.loadState()).tasks[0].toolCalls).toEqual(first);
    expect(reloaded.getTask('forge-session-a')?.toolCalls?.statusCounts.started).toBe(1);
    expect(await reloaded.recoverForgeSessionsAfterRestart(stamp)).toEqual(['forge-session-a']);
    expect(reloaded.getTask('forge-session-a')?.toolCalls?.statusCounts).toEqual({started:0,completed:0,failed:0,interrupted:1});
  });

  it('rejects invalid Forge tool logs without overwriting the state file',async()=>{
    const directory=await makeDirectory();
    await createForgeState(directory);
    const file=path.join(directory,'data','state.json');
    const invalid=JSON.parse(await readFile(file,'utf8'));invalid.tasks[0].toolCalls={schemaVersion:99,total:0};
    const source=JSON.stringify(invalid);await writeFile(file,source,'utf8');
    vi.resetModules();
    const state=await import('../server/state.js');
    await expect(state.loadState()).rejects.toThrow(/unsupported format/i);
    expect(await readFile(file,'utf8')).toBe(source);
    expect((await readdir(path.dirname(file))).filter(name=>name.endsWith('.bak'))).toHaveLength(0);
  });

  it('persists Forge-owned approvals across restart and keeps them unresolved during reconciliation',async()=>{
    const directory=await makeDirectory();const {state,workspaceRoot}=await createForgeState(directory,'forge-approval-session');
    await state.mutateForgeSession('forge-approval-session',{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:{
      id:'planning-run-a',ownerId:'planner-runtime',purpose:'planning',projectId,workspaceRoot,requestedProfile:{provider:'codex',model:'gpt-6.1-terra',effort:'low'},
      scopes:{read:['src'],write:[],knowledge:['knowledge/opnex']},skillSnapshots:[],expectedPlanRevision:1,sourceBaselineSha:'c'.repeat(40),
    }},stamp);
    await state.mutateForgeSession('forge-approval-session',{type:'record_orchestrator_runtime',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',threadId:'approval-thread',turnId:'approval-turn'},stamp);
    const request={requestId:'approval-a',method:'item/commandExecution/requestApproval' as const,itemId:'approval-item-a',threadId:'approval-thread',turnId:'approval-turn',reason:'The provider needs the user to approve a command.',command:'read-only command',availableDecisions:['accept','decline'],forgeContext:{ticketId:'forge-approval-session',targetType:'planning' as const,targetId:'planning-run-a',ownerId:'planner-runtime'}};
    await state.recordForgeApprovalRequest('forge-approval-session',request,stamp);
    vi.resetModules();
    const reloaded=await import('../server/state.js');
    expect((await reloaded.loadState()).tasks[0].approvalRequests).toEqual([request]);
    expect(await reloaded.recoverForgeSessionsAfterRestart(stamp)).toEqual(['forge-approval-session']);
    expect(reloaded.getTask('forge-approval-session')?.approvalRequests).toEqual([request]);
    const recoveredTicket=reloaded.getForgeTicketInState(reloaded.getState(),'forge-approval-session')!;
    expect(recoveredTicket.orchestratorRuns[0]?.status).toBe('unknown_after_restart');
    expect(recoveredTicket.orchestratorRuns[0]?.knowledgeAllocation).toMatchObject({operations:2,ownerId:'planner-runtime',status:'reserved'});
    await expect(reloaded.resolveForgeApprovalRequest('forge-approval-session','approval-a',{...request.forgeContext,targetId:'another-run',threadId:request.threadId,turnId:request.turnId},stamp)).rejects.toThrow(/stale|different run/i);
    await reloaded.mutateForgeSession('forge-approval-session',{type:'reconcile_orchestrator_run',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',status:'still_running',threadId:'approval-thread',turnId:'approval-turn',evidence:'The same planning turn remains active.'},stamp);
    expect(await reloaded.resolveForgeApprovalRequest('forge-approval-session','approval-a',{...request.forgeContext,threadId:request.threadId,turnId:request.turnId},stamp)).toEqual(request);
    expect(reloaded.getTask('forge-approval-session')?.approvalRequests).toEqual([]);
  });

  it('rejects Forge approval metadata from a different run without overwriting the persisted state',async()=>{
    const directory=await makeDirectory();const {state,workspaceRoot}=await createForgeState(directory,'forge-invalid-approval');
    await state.mutateForgeSession('forge-invalid-approval',{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:{
      id:'planning-run-a',ownerId:'planner-runtime',purpose:'planning',projectId,workspaceRoot,requestedProfile:{provider:'codex',model:'gpt-6.1-terra',effort:'low'},
      scopes:{read:['src'],write:[],knowledge:['knowledge/opnex']},skillSnapshots:[],expectedPlanRevision:1,sourceBaselineSha:'c'.repeat(40),
    }},stamp);
    await state.mutateForgeSession('forge-invalid-approval',{type:'record_orchestrator_runtime',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',threadId:'approval-thread',turnId:'approval-turn'},stamp);
    await state.recordForgeApprovalRequest('forge-invalid-approval',{requestId:'approval-a',method:'item/permissions/requestApproval',itemId:'approval-item-a',threadId:'approval-thread',turnId:'approval-turn',forgeContext:{ticketId:'forge-invalid-approval',targetType:'planning',targetId:'planning-run-a',ownerId:'planner-runtime'}},stamp);
    const file=path.join(directory,'data','state.json');const invalid=JSON.parse(await readFile(file,'utf8'));
    invalid.tasks[0].approvalRequests[0].forgeContext.targetId='different-run';
    const source=JSON.stringify(invalid);await writeFile(file,source,'utf8');vi.resetModules();
    const reloaded=await import('../server/state.js');
    await expect(reloaded.loadState()).rejects.toThrow(/unsupported format/i);
    expect(await readFile(file,'utf8')).toBe(source);
  });

  it('creates and mutates a Forge session through the host state helper',async()=>{
    const directory=await makeDirectory();
    const workspaceRoot=path.join(directory,'workspace');await mkdir(workspaceRoot);
    vi.stubEnv('OPNEX_DATA_DIR',path.join(directory,'data'));vi.resetModules();
    const state=await import('../server/state.js');
    await state.loadState();
    await state.mutate(value=>state.saveProjectInState(value,{id:projectId,name:'Forge workspace',projectRoot:workspaceRoot,needsLocation:false,pinned:false}));
    const session=await state.createForgeSession(ticketInput(workspaceRoot));
    expect(session).toMatchObject({id:'forge-session-a',sessionType:'forge',phase:'accepted'});
    expect(session.forge?.phase).toBe('draft');
    expect(session.toolCalls?.total).toBe(0);
    expect(state.getForgeTicketInState(state.getState(),'forge-session-a')?.id).toBe('forge-session-a');

    await state.mutateForgeSession('forge-session-a',{type:'begin_orchestrator_run',actor:{role:'host',id:'planner-runtime'},run:{
      id:'planning-run-a',ownerId:'planner-runtime',purpose:'planning',projectId,workspaceRoot,requestedProfile:{provider:'codex',model:'gpt-6.1-terra',effort:'low'},
      scopes:{read:['src'],write:[],knowledge:['knowledge/opnex']},skillSnapshots:[],expectedPlanRevision:1,sourceBaselineSha:'a'.repeat(40),
    }},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'record_orchestrator_runtime',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',threadId:'planner-thread',turnId:'planner-turn'},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'complete_planning',actor:{role:'host',id:'planner-runtime'},runId:'planning-run-a',expectedPlanRevision:1,threadId:'planner-thread',turnId:'planner-turn',planId:'plan-a',tasks:[{
      id:'work-a',title:'One task',description:'Implement one task.',dependencyIds:[],assignment:{outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['The public interface must change.'],receipt_requirements:['Return a receipt.']},
      knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
    }]},stamp);
    const persisted=JSON.parse(await readFile(path.join(directory,'data','state.json'),'utf8'));
    expect(persisted.tasks[0].forge.proposedPlan).toMatchObject({id:'plan-a',revision:1,source:'model_run',runId:'planning-run-a',tasks:[{id:'work-a'}]});
    expect(persisted.tasks[0].forge.orchestratorRuns[0]).toMatchObject({id:'planning-run-a',purpose:'planning',status:'completed',threadId:'planner-thread',turnId:'planner-turn',sourceBaselineSha:'a'.repeat(40)});
    expect(persisted.tasks[0].forge.orchestratorRuns[0].knowledgeAllocation).toMatchObject({operations:2,ownerId:'planner-runtime',status:'reserved'});
    expect(state.taskDeletionBlockReason(state.getTask('forge-session-a')!)).toMatch(/pause|cancel/i);
    await state.mutateForgeSession('forge-session-a',{type:'accept_plan',actor:{role:'orchestrator',id:'root'},revision:1},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'start',actor:{role:'user',id:'user'}},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',claimId:'claim-a',attemptId:'attempt-a',claimToken:'token-a',runtimeId:'runtime-a',branch:'forge/attempt-a',worktreeRoot:path.join(directory,'worktree'),sourceBaselineSha:'a'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',dispatchBaselineSha:'b'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',threadId:'thread-a',turnId:'turn-a'},stamp);
    const beforeReload=state.getForgeTicketInState(state.getState(),'forge-session-a')!;
    expect(state.getTask('forge-session-a')?.passes).toBeUndefined();
    vi.resetModules();
    const reloadedState=await import('../server/state.js');
    const reloaded=await reloadedState.loadState();
    expect(reloaded.tasks[0].passes).toBeUndefined();
    expect(reloaded.tasks[0].forge).toEqual(beforeReload);
    expect(reloaded.tasks[0].forge?.orchestratorRuns[0]).toMatchObject({id:'planning-run-a',status:'completed',threadId:'planner-thread',turnId:'planner-turn'});
    expect(reloaded.tasks[0].forge?.knowledgeBudget).toEqual({totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8});
    expect(reloaded.tasks[0].forge?.attempts[0].status).toBe('claimed');
    expect(reloaded.tasks[0].forge?.attempts[0].knowledgeAllocation).toMatchObject({operations:2,ownerId:'worker-a',status:'reserved'});
    expect(reloaded.tasks[0].forge?.attempts[0]).toMatchObject({sourceBaselineSha:'a'.repeat(40),dispatchBaselineSha:'b'.repeat(40)});
    expect(reloaded.tasks[0].forge?.workitems[0].state).toBe('claimed');

    expect(await reloadedState.recoverForgeSessionsAfterRestart(stamp)).toEqual(['forge-session-a']);
    expect(reloadedState.getForgeTicketInState(reloadedState.getState(),'forge-session-a')?.attempts[0].status).toBe('unknown_after_restart');
    expect(await reloadedState.recoverForgeSessionsAfterRestart(stamp)).toEqual([]);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',status:'still_running',evidence:'The original worker turn is confirmed live.'},stamp);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',outcomeId:'outcome-a',receiptId:'receipt-a',receipt:{status:'complete',result:'The task is implemented.',changes:['src/change.ts'],acceptance:{met:['A Forge payload is saved.'],unmet:[]},verification:[{check:'Focused tests',result:'passed',evidence:'passed'}],risks:[],knowledge:{consulted:['forge-sessions-design'],updated:[]},decision_required:null},provenance:{producerRole:'worker',threadId:'thread-a',turnId:'turn-a',recordedAt:stamp,artifactRefs:['src/change.ts'],workerId:'worker-a'},hostAttestation:{status:'verified',commitObserved:true,scopeValidation:'passed',commitSha:'d'.repeat(40),observedAt:stamp,evidenceRefs:['host git readback']},retryable:true},stamp);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:{id:'integration-run-a',ownerId:'integrator-a',projectId,workspaceRoot,requestedProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},branch:'forge/integrator/integration-run-a',targetBranch:'main',worktreeRoot:path.join(directory,'integration-run-a'),sourceBaselineSha:'c'.repeat(40),scopes:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},skillSnapshots:[]}},stamp);
    const beforeIntegrationReload=reloadedState.getForgeTicketInState(reloadedState.getState(),'forge-session-a')!;
    expect(beforeIntegrationReload.integration.runs[0]).toMatchObject({id:'integration-run-a',status:'prepared',projectId,workspaceRoot,requestedProfile:{model:'gpt-6-luna'},sourceBaselineSha:'c'.repeat(40)});
    expect(beforeIntegrationReload.integration.runs[0]?.targetBranch).toBe('main');
    expect(beforeIntegrationReload.integration.runs[0]).not.toHaveProperty('threadId');
    vi.resetModules();
    const integrationReloadModule=await import('../server/state.js');
    const integrationReload=await integrationReloadModule.loadState();
    expect(integrationReload.tasks[0].forge?.integration.runs).toEqual(beforeIntegrationReload.integration.runs);
    expect(integrationReload.tasks[0].forge?.integration.runs[0].status).toBe('prepared');
    expect(await integrationReloadModule.recoverForgeSessionsAfterRestart(stamp)).toEqual(['forge-session-a']);
    expect(integrationReloadModule.getForgeTicketInState(integrationReloadModule.getState(),'forge-session-a')?.integration.runs[0].status).toBe('unknown_after_restart');
    await integrationReloadModule.mutateForgeSession('forge-session-a',{type:'reconcile_integration_run',actor:{role:'host',id:'integrator-runtime'},runId:'integration-run-a',status:'still_running',threadId:'integrator-thread-a',turnId:'integrator-turn-a',evidence:'The same integrator turn is confirmed live.'},stamp);
    const recovered=JSON.parse(await readFile(path.join(directory,'data','state.json'),'utf8'));
    expect(recovered.tasks[0].forge.integration.runs[0]).toMatchObject({id:'integration-run-a',status:'running',threadId:'integrator-thread-a',turnId:'integrator-turn-a'});
  });

  it('persists a host-attested pre-provider failure without synthetic provider or receipt provenance',async()=>{
    const directory=await makeDirectory();
    const {state}=await createForgeState(directory,'forge-preflight-session');
    await state.mutateForgeSession('forge-preflight-session',{type:'submit_manual_plan',actor:{role:'user',id:'user'},planId:'plan-a',tasks:[{
      id:'work-a',title:'One task',description:'Implement one task.',dependencyIds:[],assignment:{outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['The public interface must change.'],receipt_requirements:['Return a receipt.']},
      knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
    }]},stamp);
    await state.mutateForgeSession('forge-preflight-session',{type:'accept_plan',actor:{role:'user',id:'user'},revision:1},stamp);
    await state.mutateForgeSession('forge-preflight-session',{type:'start',actor:{role:'user',id:'user'}},stamp);
    await state.mutateForgeSession('forge-preflight-session',{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',claimId:'claim-a',attemptId:'attempt-a',claimToken:'token-a',runtimeId:'runtime-a',branch:'forge/work-a',worktreeRoot:path.join(directory,'worktree'),sourceBaselineSha:'a'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-preflight-session',{type:'fail_attempt_preflight',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',stage:'dependency_merge',failureReason:'Dependency preparation failed before provider dispatch.',evidence:['The host merge adapter returned a deterministic conflict.']},stamp);
    vi.resetModules();
    const reloaded=await import('../server/state.js');
    const ticket=reloaded.getForgeTicketInState(await reloaded.loadState(),'forge-preflight-session')!;
    expect(ticket.attempts[0]).toMatchObject({status:'preflight_failed',sourceBaselineSha:'a'.repeat(40),failureReason:'Dependency preparation failed before provider dispatch.',preflightFailure:{stage:'dependency_merge',evidence:['The host merge adapter returned a deterministic conflict.']}});
    expect(ticket.attempts[0]).not.toHaveProperty('threadId');
    expect(ticket.attempts[0]).not.toHaveProperty('receiptId');
    expect(ticket.receipts).toEqual([]);
  });

  it('persists an uncertain turn start as a blocked owner until host reconciliation',async()=>{
    const directory=await makeDirectory();
    const {state}=await createForgeState(directory,'forge-uncertain-session');
    await state.mutateForgeSession('forge-uncertain-session',{type:'submit_manual_plan',actor:{role:'user',id:'user'},planId:'plan-a',tasks:[{
      id:'work-a',title:'One task',description:'Implement one task.',dependencyIds:[],assignment:{outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['The public interface must change.'],receipt_requirements:['Return a receipt.']},
      knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
    }]},stamp);
    await state.mutateForgeSession('forge-uncertain-session',{type:'accept_plan',actor:{role:'user',id:'user'},revision:1},stamp);
    await state.mutateForgeSession('forge-uncertain-session',{type:'start',actor:{role:'user',id:'user'}},stamp);
    await state.mutateForgeSession('forge-uncertain-session',{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',claimId:'claim-a',attemptId:'attempt-a',claimToken:'token-a',runtimeId:'runtime-a',branch:'forge/work-a',worktreeRoot:path.join(directory,'worktree'),sourceBaselineSha:'a'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-uncertain-session',{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',dispatchBaselineSha:'b'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-uncertain-session',{type:'mark_attempt_effect_uncertain',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',evidence:'Turn-start was sent but disconnected before an ID was observed.'},stamp);
    vi.resetModules();
    const reloaded=await import('../server/state.js');
    const ticket=reloaded.getForgeTicketInState(await reloaded.loadState(),'forge-uncertain-session')!;
    expect(ticket).toMatchObject({phase:'blocked',workitems:[{state:'blocked',activeAttemptId:'attempt-a',blockedReason:{kind:'execution_issue',code:'unknown_effect'}}],attempts:[{status:'unknown_effect',dispatchBaselineSha:'b'.repeat(40)}]});
    expect(await reloaded.recoverForgeSessionsAfterRestart(stamp)).toEqual([]);
    await expect(reloaded.mutateForgeSession('forge-uncertain-session',{type:'fail_attempt_preflight',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',stage:'provider_start',effect:'confirmed_not_started',failureReason:'No turn was started.',evidence:['Uncertain disconnect.']},stamp)).rejects.toThrow(/known no-effect|uncertain/i);
    await reloaded.mutateForgeSession('forge-uncertain-session',{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',status:'stopped',evidence:'The provider confirms no turn remains live.'},stamp);
    expect(reloaded.getForgeTicketInState(reloaded.getState(),'forge-uncertain-session')?.attempts[0]?.status).toBe('interrupted');
  });

  it('snapshots the selected Settings approval policy and keeps it after later Settings changes',async()=>{
    const directory=await makeDirectory();
    const {state,workspaceRoot}=await createForgeState(directory);
    await state.mutate(value=>{value.settings.approvalPolicy='untrusted';});
    const created=await state.createForgeSession(ticketInput(workspaceRoot,'forge-untrusted'));
    expect(created.forge?.approvalPolicy).toBe('untrusted');
    await state.mutate(value=>{value.settings.approvalPolicy='never';});
    expect(state.getForgeTicketInState(state.getState(),'forge-untrusted')?.approvalPolicy).toBe('untrusted');
    vi.resetModules();
    const reloaded=await import('../server/state.js');
    expect((await reloaded.loadState()).tasks.find(task=>task.id==='forge-untrusted')?.forge?.approvalPolicy).toBe('untrusted');
  });

  it('rejects Full Access for strict Forge creation instead of downgrading the selected policy',async()=>{
    const directory=await makeDirectory();
    const workspaceRoot=path.join(directory,'workspace');await mkdir(workspaceRoot);
    vi.stubEnv('OPNEX_DATA_DIR',path.join(directory,'data'));vi.resetModules();
    const state=await import('../server/state.js');
    await state.loadState();
    await state.mutate(value=>state.saveProjectInState(value,{id:projectId,name:'Forge workspace',projectRoot:workspaceRoot,needsLocation:false,pinned:false}));
    await state.mutate(value=>{value.settings.approvalPolicy='full-access';});
    await expect(state.createForgeSession(ticketInput(workspaceRoot))).rejects.toThrow(/cannot use the Full Access approval policy/i);
    expect(state.getState().tasks).toHaveLength(0);
  });

  it('serializes concurrent Forge claims through the existing atomic state owner',async()=>{
    const directory=await makeDirectory();
    const workspaceRoot=path.join(directory,'workspace');await mkdir(workspaceRoot);
    vi.stubEnv('OPNEX_DATA_DIR',path.join(directory,'data'));vi.resetModules();
    const state=await import('../server/state.js');
    await state.loadState();
    await state.mutate(value=>state.saveProjectInState(value,{id:projectId,name:'Forge workspace',projectRoot:workspaceRoot,needsLocation:false,pinned:false}));
    await state.createForgeSession({...ticketInput(workspaceRoot,'forge-race'),limits:{maxActiveWorkers:1,maxExecutionAttempts:2,maxCorrectionRounds:3}});
    const assignment={outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['A public interface change is needed.'],receipt_requirements:['Return a receipt.']};
    await state.mutateForgeSession('forge-race',{type:'submit_manual_plan',actor:{role:'user',id:'root'},planId:'race-plan',tasks:['work-a','work-b'].map(id=>({id,title:id,description:'Implement a task.',dependencyIds:[],assignment,knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex' as const,model:'gpt-6-luna',effort:'max' as const},skillSnapshots:[]}))},stamp);
    await state.mutateForgeSession('forge-race',{type:'accept_plan',actor:{role:'orchestrator',id:'root'},revision:1},stamp);
    await state.mutateForgeSession('forge-race',{type:'start',actor:{role:'user',id:'user'}},stamp);
    const makeClaim=(taskId:string,attemptId:string)=>state.mutateForgeSession('forge-race',{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId,ownerId:`worker-${taskId}`,claimId:`claim-${attemptId}`,attemptId,claimToken:`token-${attemptId}`,runtimeId:`runtime-${attemptId}`,branch:`forge/${attemptId}`,worktreeRoot:path.join(directory,attemptId),sourceBaselineSha:'a'.repeat(40)},stamp);
    const outcomes=await Promise.allSettled([makeClaim('work-a','attempt-a'),makeClaim('work-b','attempt-b')]);
    expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row=>row.status==='rejected')).toHaveLength(1);
    const persisted=JSON.parse(await readFile(path.join(directory,'data','state.json'),'utf8'));
    expect(persisted.tasks[0].forge.attempts).toHaveLength(1);
    expect(persisted.tasks[0].forge.workitems.filter((row:any)=>row.state==='claimed')).toHaveLength(1);
  });
});
