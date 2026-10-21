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
    for(const approvalPolicy of ['on-request','untrusted','never'])expect(settingsSchema.safeParse({...base,approvalPolicy}).success).toBe(true);
    expect(settingsSchema.safeParse({...base,approvalPolicy:'custom'}).success).toBe(false);
    expect(settingsSchema.parse({...base,agentmemProjectId:''}).agentmemProjectId).toBe('');
    expect(settingsSchema.parse({...base,agentmemProjectId:'   '}).agentmemProjectId).toBe('');
    expect(settingsSchema.safeParse({...base,agentmemProjectId:'x'.repeat(129)}).success).toBe(false);
  });
  it('requests detailed summaries and available provider raw text for new and resumed role threads',()=>{
    const orchestrator=makeThreadParams({role:'orchestrator',root:'D:/repo',model:'gpt-6-sol',approvalPolicy:'on-request',ownedPolicy:'policy'});
    const worker=makeThreadParams({role:'worker',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request'});
    expect(orchestrator.config).toEqual({model_reasoning_summary:'detailed',model_supports_reasoning_summaries:true,show_raw_agent_reasoning:true});
    expect(worker.config).toEqual(orchestrator.config);
    expect(makeThreadResumeParams('thread-1')).toEqual({threadId:'thread-1',excludeTurns:true,config:orchestrator.config});
    expect(orchestrator.developerInstructions).toContain('policy');
  });
  it('does not add reasoning config to turn parameters or send reasoning through the prompt',()=>{
    const params=makeTurnParams({threadId:'t',input:'safe user prompt',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    expect(params).not.toHaveProperty('config');expect(params.input).toEqual([{type:'text',text:'safe user prompt'}]);
  });
  it('serializes selected approval mode with read-only or bounded write sandbox',()=>{
    const readOnly=makeTurnParams({threadId:'t',input:'answer',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    expect(readOnly.approvalPolicy).toBe('on-request');expect(readOnly.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    expect(readOnly.summary).toBe('detailed');
    const write=makeTurnParams({threadId:'t',input:'edit',role:'worker',model:'gpt-6-luna',effort:'high',writeRoots:['D:/repo/src'],approvalPolicy:'untrusted',schema:{type:'object'}});
    expect(write.approvalPolicy).toBe('untrusted');expect(write.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['D:/repo/src'],networkAccess:false});
    const orchestration=makeTurnParams({threadId:'t',input:'plan',role:'orchestrator',model:'gpt-6-sol',effort:'high',writeRoots:['D:/ignored'],approvalPolicy:'never',schema:{type:'object'}});
    expect(orchestration.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
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
