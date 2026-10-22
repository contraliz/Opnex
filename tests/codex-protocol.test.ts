import { describe, expect, it, vi } from 'vitest';
import { AppServer, approvalResponse, buildOrchestratorDeveloperInstructions, makeThreadParams, makeThreadResumeParams, makeTurnParams } from '../server/codex.js';
import { settingsSchema } from '../server/contracts.js';

describe('Codex approval and turn configuration',()=>{
  it('loads the app-owned delegation policy into orchestrator developer instructions',()=>{
    const instructions=buildOrchestratorDeveloperInstructions('ORCHESTRATOR POLICY COPY');
    expect(instructions).toContain('ORCHESTRATOR POLICY COPY');expect(instructions).toContain('policy-bound orchestration model');
  });
  it('accepts only supported approval presets and keeps the safe default',()=>{
    const base={projectRoot:'D:/repo',agentmemProjectId:'demo',orchestratorModel:'gpt-6-sol',orchestratorEffort:'high'};
    expect(settingsSchema.parse(base).approvalPolicy).toBe('on-request');
    for(const approvalPolicy of ['on-request','untrusted','never','full-access'])expect(settingsSchema.safeParse({...base,approvalPolicy}).success).toBe(true);
    expect(settingsSchema.safeParse({...base,approvalPolicy:'custom'}).success).toBe(false);
    expect(settingsSchema.parse({...base,agentmemProjectId:''}).agentmemProjectId).toBe('');
    expect(settingsSchema.parse({...base,agentmemProjectId:'   '}).agentmemProjectId).toBe('');
    expect(settingsSchema.safeParse({...base,agentmemProjectId:'x'.repeat(129)}).success).toBe(false);
  });
  it('requests the most detailed supported summaries and available provider text for new and resumed role threads',()=>{
    const orchestrator=makeThreadParams({role:'orchestrator',root:'D:/repo',model:'gpt-6-sol',approvalPolicy:'on-request',ownedPolicy:'policy'});
    const worker=makeThreadParams({role:'worker',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request'});
    expect(orchestrator.config).toEqual({model_reasoning_summary:'auto',model_supports_reasoning_summaries:true,show_raw_agent_reasoning:true});
    expect(worker.config).toEqual(orchestrator.config);
    expect(makeThreadResumeParams('thread-1')).toEqual({threadId:'thread-1',excludeTurns:true,config:orchestrator.config});
    expect(orchestrator.developerInstructions).toContain('policy');
  });
  it('isolates the router with a classification-only thread and assigns the Fast tier only to its low-effort turn',()=>{
    const router=makeThreadParams({role:'router',root:'/tmp/project',model:'gpt-6-luna',effort:'low',approvalPolicy:'on-request'});
    expect((router as any).dynamicTools).toEqual([]);
    expect(router.config).toMatchObject({web_search:'disabled',apps:{_default:{enabled:false,destructive_enabled:false,open_world_enabled:false}}});
    expect(router.developerInstructions).toContain('classification-only');
    const turn=makeTurnParams({threadId:'router',input:'Classify only',role:'router',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'},serviceTierForTurn:'priority'});
    expect(turn).toMatchObject({model:'gpt-6-luna',effort:'low',serviceTierForTurn:'priority',sandboxPolicy:{type:'readOnly',networkAccess:false}});
    const direct=makeTurnParams({threadId:'direct',input:'Answer',role:'direct',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    const simple=makeTurnParams({threadId:'simple',input:'Edit',role:'simple',model:'gpt-6-luna',effort:'xhigh',writeRoots:['/tmp/project'],approvalPolicy:'on-request',schema:{type:'object'}});
    const simpleInstructions=makeThreadParams({role:'simple',root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'on-request'}).developerInstructions;
    expect(simpleInstructions).toContain('Updating focused tests or docs needed to verify the requested behavior is an ordinary implementation decision');expect(simpleInstructions).toContain('never weaken or rewrite a test merely to hide a failure');
    expect(direct).not.toHaveProperty('serviceTierForTurn');expect(direct.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    expect(simple).not.toHaveProperty('serviceTierForTurn');expect(simple.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['/tmp/project'],networkAccess:false});
  });
  it('requires both roles to verify public-source provenance instead of trusting local paths or KB claims',()=>{
    const orchestrator=buildOrchestratorDeveloperInstructions();
    const worker=makeThreadParams({role:'worker',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request'}).developerInstructions;
    for(const instructions of [orchestrator,worker]){
      expect(instructions).toContain('tracked and present in the relevant remote repository');
      expect(instructions).toContain('local workspace path or project-knowledge statement alone does not establish publication');
    }
  });
  it('does not add reasoning config to turn parameters or send reasoning through the prompt',()=>{
    const params=makeTurnParams({threadId:'t',input:'safe user prompt',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    expect(params).not.toHaveProperty('config');expect(params.input).toEqual([{type:'text',text:'safe user prompt'}]);
  });
  it('serializes selected approval mode with read-only or bounded write sandbox',()=>{
    const readOnly=makeTurnParams({threadId:'t',input:'answer',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    expect(readOnly.approvalPolicy).toBe('on-request');expect(readOnly.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    expect(readOnly.summary).toBe('auto');
    const write=makeTurnParams({threadId:'t',input:'edit',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:['D:/repo/src'],approvalPolicy:'untrusted',schema:{type:'object'}});
    expect(write.approvalPolicy).toBe('untrusted');expect(write.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['D:/repo/src'],networkAccess:false});
    const orchestration=makeTurnParams({threadId:'t',input:'plan',role:'orchestrator',model:'gpt-6-sol',effort:'high',writeRoots:['D:/ignored'],approvalPolicy:'never',schema:{type:'object'}});
    expect(orchestration.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
  });
  it('maps full access to the installed app-server never-approve and danger-full-access policies for all roles',()=>{
    for(const role of ['orchestrator','worker'] as const){
      const thread=makeThreadParams({role,root:'D:/repo',model:role==='worker'?'gpt-6-luna':'gpt-6-sol',approvalPolicy:'full-access'});
      expect(thread).toMatchObject({approvalPolicy:'never',sandbox:'danger-full-access'});
      const turn=makeTurnParams({threadId:'thread',input:'work',role,model:'model',effort:'high',writeRoots:[],approvalPolicy:'full-access',schema:{type:'object'}});
      expect(turn).toMatchObject({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
    }
    expect(makeThreadResumeParams('thread','full-access')).toMatchObject({approvalPolicy:'never',sandbox:'danger-full-access'});
    expect(makeThreadResumeParams('thread')).not.toHaveProperty('sandbox');
    for(const role of ['router','direct'] as const){
      const thread=makeThreadParams({role,root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'full-access'});
      const turn=makeTurnParams({threadId:'thread',input:'answer',role,model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'full-access',schema:{type:'object'}});
      expect(thread.sandbox).toBe('read-only');expect(turn.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    }
    const simple=makeTurnParams({threadId:'simple',input:'edit',role:'simple',model:'gpt-6-luna',effort:'xhigh',writeRoots:['/tmp/project'],approvalPolicy:'full-access',schema:{type:'object'}});
    expect(simple.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['/tmp/project'],networkAccess:true});
  });
  it('uses the full-access sandbox for review turns as well as ordinary turns',async()=>{
    const client=new AppServer();const request=vi.fn().mockResolvedValue({turn:{id:'review'}});(client as any).request=request;
    await client.reviewTurn('thread','review','gpt-6-sol','high','full-access');
    expect(request.mock.calls[0][1]).toMatchObject({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  });
  it('converts user approval decisions into the app-server response schema',()=>{
    expect(approvalResponse('item/commandExecution/requestApproval',null,'accept')).toEqual({decision:'accept'});
    expect(approvalResponse('item/fileChange/requestApproval',null,'decline')).toEqual({decision:'decline'});
    const requested={network:{enabled:true}};
    expect(approvalResponse('item/permissions/requestApproval',requested,'accept')).toEqual({permissions:requested,scope:'turn'});
    expect(approvalResponse('item/permissions/requestApproval',requested,'decline')).toEqual({permissions:{},scope:'turn'});
  });
  it('routes app-server requests separately from client responses and answers by original request id',()=>{
    const client=new AppServer();const writes:string[]=[];
    (client as any).child={killed:false,stdin:{write:(s:string)=>{writes.push(s);}}};
    let request:any;
    client.on('serverRequest',(id,method,params)=>{request={id,method,params};});
    (client as any).consume('{"id":"server-approval-7","method":"item/commandExecution/requestApproval","params":{"itemId":"item-1","threadId":"worker-1","turnId":"turn-1"}}\n');
    expect(request).toEqual({id:'server-approval-7',method:'item/commandExecution/requestApproval',params:{itemId:'item-1',threadId:'worker-1',turnId:'turn-1'}});
    client.respondServerRequest(request.id,{decision:'accept'});
    expect(JSON.parse(writes[0])).toEqual({id:'server-approval-7',result:{decision:'accept'}});
    client.close();
  });
  it('requests usage for the exact thread rather than reading account-wide activity',async()=>{
    const client=new AppServer();(client as any).ready=true;
    const request=vi.fn().mockResolvedValue({threadUsage:{threadId:'worker-thread',estimatedUsageCreditsMicros:125000,groups:[]}});(client as any).request=request;
    await expect(client.threadUsage('worker-thread')).resolves.toEqual({threadId:'worker-thread',estimatedUsageCreditsMicros:125000,groups:[]});
    expect(request).toHaveBeenCalledWith('account/usage/read',{threadId:'worker-thread'},10000);
  });
  it('reads Codex rate limits without requesting reset-credit detail calls',async()=>{
    const client=new AppServer();(client as any).ready=true;const request=vi.fn().mockResolvedValue({rateLimits:{limitId:'codex'}});(client as any).request=request;
    await expect(client.accountRateLimits()).resolves.toEqual({rateLimits:{limitId:'codex'}});
    expect(request).toHaveBeenCalledWith('account/rateLimits/read',{excludeResetCreditDetails:true},10000);
  });
});
