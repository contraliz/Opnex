import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppServer, approvalResponse, assertInstructionIsolation, buildOrchestratorDeveloperInstructions, makeThreadParams, makeThreadResumeParams, makeTurnParams } from '../server/codex.js';
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
    expect(router.config).toMatchObject({project_doc_max_bytes:0,project_doc_fallback_filenames:[],web_search:'disabled',apps:{_default:{enabled:false,destructive_enabled:false,open_world_enabled:false}}});
    expect(router.developerInstructions).toContain('classification-only');
    const turn=makeTurnParams({threadId:'router',input:'Classify only',role:'router',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'},serviceTierForTurn:'priority'});
    expect(turn).toMatchObject({model:'gpt-6-luna',effort:'low',serviceTierForTurn:'priority',sandboxPolicy:{type:'readOnly',networkAccess:false}});
    const direct=makeTurnParams({threadId:'direct',input:'Answer',role:'direct',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    const simple=makeTurnParams({threadId:'simple',input:'Edit',role:'simple',model:'gpt-6-luna',effort:'xhigh',writeRoots:['/tmp/project'],approvalPolicy:'on-request',schema:{type:'object'}});
    const simpleInstructions=makeThreadParams({role:'simple',root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'on-request'}).developerInstructions;
    expect(simpleInstructions).toContain('Updating focused tests or docs needed to verify the requested behavior is an ordinary implementation decision');expect(simpleInstructions).toContain('never weaken or rewrite a test merely to hide a failure');
    expect(direct).not.toHaveProperty('serviceTierForTurn');expect(direct.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    expect(simple).not.toHaveProperty('serviceTierForTurn');expect(simple.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['/tmp/project'],networkAccess:false});
    expect(makeThreadParams({role:'direct',root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'on-request'}).config).not.toHaveProperty('project_doc_max_bytes');
    expect(makeThreadParams({role:'orchestrator',root:'/tmp/project',model:'gpt-6-sol',approvalPolicy:'on-request'}).config).not.toHaveProperty('project_doc_max_bytes');
  });
  it('fails closed unless the app-server explicitly reports no instruction sources for router threads',()=>{
    expect(()=>assertInstructionIsolation({instructionSources:[]})).not.toThrow();
    expect(()=>assertInstructionIsolation({instructionSources:['/user/.codex/AGENTS.md']})).toThrow('Router instruction isolation could not be verified');
    expect(()=>assertInstructionIsolation({})).toThrow('Router instruction isolation could not be verified');
    expect(()=>assertInstructionIsolation({instructionSources:null})).toThrow('Router instruction isolation could not be verified');
  });
  it('requires the isolation acknowledgement on router start and resume, without changing other roles',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};
    const request=vi.fn().mockResolvedValueOnce({instructionSources:[],thread:{id:'router-thread'}}).mockResolvedValueOnce({thread:{id:'unsafe-thread'}}).mockResolvedValueOnce({thread:{id:'legacy-thread'}});
    (client as any).request=request;
    await expect(client.startThread('router','/isolated/home','gpt-6-luna','low')).resolves.toBe('router-thread');
    expect(request.mock.calls[0][1]).toMatchObject({cwd:'/isolated/home',config:{project_doc_max_bytes:0,project_doc_fallback_filenames:[]}});
    await expect(client.resumeThread('router-thread','on-request','router')).rejects.toThrow('Router instruction isolation could not be verified');
    await expect(client.startTurn('unsafe-thread','classify','router','gpt-6-luna','low','/isolated/home')).rejects.toThrow('must be verified');
    await expect(client.startThread('direct','/workspace','gpt-6-luna','low')).resolves.toBe('legacy-thread');
    client.close();
  });
  it('shares one in-flight app-server startup across concurrent callers',async()=>{
    let spawnCount=0;
    const spawnOptions:any[]=[];
    const fakeSpawn=(_exe:string,_args:string[],options:any)=>{
      spawnCount++;
      spawnOptions.push(options);
      const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;
      const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk:string,...args:any[])=>{const result=write(chunk,...args);for(const line of String(chunk).trim().split('\n')){const request=JSON.parse(line);if(request.method==='initialize')queueMicrotask(()=>child.stdout.write(`${JSON.stringify({id:request.id,result:{}})}\n`));}return result;};
      child.kill=()=>{child.killed=true;return true;};return child;
    };
    const client=new AppServer({spawnProcess:fakeSpawn as any,cwd:'/isolated/router/workspace'});
    await Promise.all([client.connect(),client.connect(),client.connect()]);expect(spawnCount).toBe(1);expect(spawnOptions[0].cwd).toBe('/isolated/router/workspace');client.close();
  });
  it('bridges short-lived ChatGPT auth only in memory and redacts bridge failures',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};
    const token=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+300,'https://api.openai.com/auth':{chatgpt_account_id:'account-123',chatgpt_plan_type:'plus'}})).toString('base64url')}.signature`;
    const request=vi.fn().mockResolvedValue({authMethod:'chatgpt',authToken:token});(client as any).request=request;
    await expect(client.exportChatGPTAuthTokens()).resolves.toEqual({accessToken:token,chatgptAccountId:'account-123',chatgptPlanType:'plus'});
    expect(request).toHaveBeenCalledWith('getAuthStatus',{includeToken:true,refreshToken:false},15000);
    request.mockResolvedValueOnce({type:'chatgptAuthTokens'});
    await client.useExternalChatGPTAuth({accessToken:token,chatgptAccountId:'account-123',chatgptPlanType:'plus'});
    expect(request).toHaveBeenLastCalledWith('account/login/start',{type:'chatgptAuthTokens',accessToken:token,chatgptAccountId:'account-123',chatgptPlanType:'plus'},15000);
    request.mockRejectedValueOnce(new Error(`unexpected token ${token}`));
    let errorText='';try{await client.exportChatGPTAuthTokens();}catch(error){errorText=(error as Error).message;}
    expect(errorText).toContain('short-lived sign-in bridge');expect(errorText).not.toContain(token);
    client.close();
  });
  it('refreshes the ChatGPT auth bridge only when the current token is near expiry',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};
    const token=(exp:number)=>`header.${Buffer.from(JSON.stringify({exp,'https://api.openai.com/auth':{chatgpt_account_id:'account-123'}})).toString('base64url')}.signature`;
    const request=vi.fn().mockResolvedValueOnce({authMethod:'chatgpt',authToken:token(Math.floor(Date.now()/1000)+20)}).mockResolvedValueOnce({authMethod:'chatgpt',authToken:token(Math.floor(Date.now()/1000)+300)});(client as any).request=request;
    await expect(client.exportChatGPTAuthTokens()).resolves.toMatchObject({chatgptAccountId:'account-123'});
    expect(request.mock.calls).toEqual([['getAuthStatus',{includeToken:true,refreshToken:false},15000],['getAuthStatus',{includeToken:true,refreshToken:true},15000]]);client.close();
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
    expect(makeThreadResumeParams('router','full-access','router')).toMatchObject({approvalPolicy:'never',sandbox:'read-only',config:{project_doc_max_bytes:0}});
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
