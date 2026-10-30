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
    expect(migrated.version).toBe(6);
    expect(migrated.tasks[0]).toMatchObject({sessionType:'conversation',title:'Historical Conversation',userMessages:input.tasks[0].userMessages,messages:input.tasks[0].messages,passes:input.tasks[0].passes,currentPassId:'pass-a'});
    expect(migrated.tasks[0].forge).toBeUndefined();
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
    expect(loaded.version).toBe(6);
    expect(saved.version).toBe(6);
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
    expect(state.getForgeTicketInState(state.getState(),'forge-session-a')?.id).toBe('forge-session-a');

    await state.mutateForgeSession('forge-session-a',{type:'propose_plan',actor:{role:'orchestrator',id:'root'},planId:'plan-a',tasks:[{
      id:'work-a',title:'One task',description:'Implement one task.',dependencyIds:[],assignment:{outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['The public interface must change.'],receipt_requirements:['Return a receipt.']},
      knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
    }]},stamp);
    const persisted=JSON.parse(await readFile(path.join(directory,'data','state.json'),'utf8'));
    expect(persisted.tasks[0].forge.proposedPlan).toMatchObject({id:'plan-a',revision:1,tasks:[{id:'work-a'}]});
    expect(state.taskDeletionBlockReason(state.getTask('forge-session-a')!)).toMatch(/pause|cancel/i);
    await state.mutateForgeSession('forge-session-a',{type:'accept_plan',actor:{role:'orchestrator',id:'root'},revision:1},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'start',actor:{role:'user',id:'user'}},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',claimId:'claim-a',attemptId:'attempt-a',claimToken:'token-a',runtimeId:'runtime-a',branch:'forge/attempt-a',worktreeRoot:path.join(directory,'worktree'),sourceBaselineSha:'a'.repeat(40)},stamp);
    await state.mutateForgeSession('forge-session-a',{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',threadId:'thread-a',turnId:'turn-a'},stamp);
    const beforeReload=state.getForgeTicketInState(state.getState(),'forge-session-a')!;
    expect(state.getTask('forge-session-a')?.passes).toBeUndefined();
    vi.resetModules();
    const reloadedState=await import('../server/state.js');
    const reloaded=await reloadedState.loadState();
    expect(reloaded.tasks[0].passes).toBeUndefined();
    expect(reloaded.tasks[0].forge).toEqual(beforeReload);
    expect(reloaded.tasks[0].forge?.attempts[0].status).toBe('claimed');
    expect(reloaded.tasks[0].forge?.workitems[0].state).toBe('claimed');

    expect(await reloadedState.recoverForgeSessionsAfterRestart(stamp)).toEqual(['forge-session-a']);
    expect(reloadedState.getForgeTicketInState(reloadedState.getState(),'forge-session-a')?.attempts[0].status).toBe('unknown_after_restart');
    expect(await reloadedState.recoverForgeSessionsAfterRestart(stamp)).toEqual([]);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'reconcile_attempt',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',status:'still_running',evidence:'The original worker turn is confirmed live.'},stamp);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'work-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-a',outcomeId:'outcome-a',receiptId:'receipt-a',receipt:{status:'complete',result:'The task is implemented.',changes:['src/change.ts'],acceptance:{met:['A Forge payload is saved.'],unmet:[]},verification:[{check:'Focused tests',result:'passed',evidence:'passed'}],risks:[],knowledge:{consulted:['forge-sessions-design'],updated:[]},decision_required:null},provenance:{producerRole:'worker',threadId:'thread-a',turnId:'turn-a',recordedAt:stamp,artifactRefs:['src/change.ts'],workerId:'worker-a'},hostAttestation:{status:'verified',commitObserved:true,scopeValidation:'passed',commitSha:'d'.repeat(40),observedAt:stamp,evidenceRefs:['host git readback']},retryable:true},stamp);
    await reloadedState.mutateForgeSession('forge-session-a',{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run:{id:'integration-run-a',ownerId:'integrator-a',projectId,workspaceRoot,requestedProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},branch:'forge/integrator/integration-run-a',worktreeRoot:path.join(directory,'integration-run-a'),sourceBaselineSha:'c'.repeat(40),scopes:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},skillSnapshots:[]}},stamp);
    const beforeIntegrationReload=reloadedState.getForgeTicketInState(reloadedState.getState(),'forge-session-a')!;
    expect(beforeIntegrationReload.integration.runs[0]).toMatchObject({id:'integration-run-a',status:'prepared',projectId,workspaceRoot,requestedProfile:{model:'gpt-6-luna'},sourceBaselineSha:'c'.repeat(40)});
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

  it('serializes concurrent Forge claims through the existing atomic state owner',async()=>{
    const directory=await makeDirectory();
    const workspaceRoot=path.join(directory,'workspace');await mkdir(workspaceRoot);
    vi.stubEnv('OPNEX_DATA_DIR',path.join(directory,'data'));vi.resetModules();
    const state=await import('../server/state.js');
    await state.loadState();
    await state.mutate(value=>state.saveProjectInState(value,{id:projectId,name:'Forge workspace',projectRoot:workspaceRoot,needsLocation:false,pinned:false}));
    await state.createForgeSession({...ticketInput(workspaceRoot,'forge-race'),limits:{maxActiveWorkers:1,maxExecutionAttempts:2,maxCorrectionRounds:3}});
    const assignment={outcome:'Implement it.',deliverable:'Source change.',read_scope:['src'],write_scope:['src'],exclusions:[],constraints:[],context_refs:[],acceptance:['It works.'],verification:['Focused tests pass.'],ordinary_authority:['Make routine edits.'],escalation_conditions:['A public interface change is needed.'],receipt_requirements:['Return a receipt.']};
    await state.mutateForgeSession('forge-race',{type:'propose_plan',actor:{role:'orchestrator',id:'root'},planId:'race-plan',tasks:['work-a','work-b'].map(id=>({id,title:id,description:'Implement a task.',dependencyIds:[],assignment,knowledgeScope:['knowledge/opnex'],executionProfile:{provider:'codex' as const,model:'gpt-6-luna',effort:'max' as const},skillSnapshots:[]}))},stamp);
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
