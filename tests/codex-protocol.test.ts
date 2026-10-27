import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { AppServer, AppServerRequestError, approvalResponse, assertAgentRuntimeConfig, assertInstructionIsolation, appAgentBaseInstructions, appAgentConfig, buildOrchestratorDeveloperInstructions, makeAppServerUserInput, makeThreadParams, makeThreadResumeParams, makeTurnParams, normalCodexSqliteHome } from '../server/codex.js';
import { settingsSchema } from '../server/contracts.js';
import { authorizesWorkerWorkspaceTool, normalizeAgentWorkspaceUrl, workerWorkspaceTool, workspaceToolRequiresDesktop } from '../server/workspace-tools.js';

describe('Codex approval and turn configuration',()=>{
  it('omits absent MCP servers instead of emitting malformed disabled entries',()=>{
    for(const role of ['router','direct','simple','orchestrator','worker'] as const){const config=appAgentConfig('/repo',role);expect(config).not.toHaveProperty('mcp_servers');}
    const skills={command:'node',args:['gateway.js'],enabled:true,enabled_tools:['skills_list']};
    const worker=appAgentConfig('/repo','worker',undefined,skills);
    expect(worker.mcp_servers).toEqual({pseudoharness_skills:skills});
    expect(worker.mcp_servers).not.toHaveProperty('agentmem');
    const router=appAgentConfig('/repo','router',undefined,skills);expect(router).not.toHaveProperty('mcp_servers');
  });
  it('resolves the normal Codex SQLite home while keeping the instruction-filtered home separate',async()=>{
    expect(normalCodexSqliteHome({CODEX_HOME:'D:/Users/test/.codex'},'C:/Users/test')).toBe('D:/Users/test/.codex');
    expect(normalCodexSqliteHome({CODEX_HOME:'D:/Users/test/.codex',CODEX_SQLITE_HOME:'E:/codex-state'},'C:/Users/test')).toBe('E:/codex-state');
    expect(normalCodexSqliteHome({},'C:/Users/test')).toBe(path.join('C:/Users/test','.codex'));
    const previousProfile=process.env.CODEX_PROFILE,previousConfig=process.env.CODEX_CONFIG;process.env.CODEX_PROFILE='qa-profile';process.env.CODEX_CONFIG='D:/codex/custom-config.toml';let options:any;
    const fakeSpawn=(_exe:string,_args:string[],spawnOptions:any)=>{options=spawnOptions;const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk:string,...args:any[])=>{const result=write(chunk,...args);for(const line of String(chunk).trim().split('\n')){const request=JSON.parse(line);if(request.method==='initialize')queueMicrotask(()=>child.stdout.write(`${JSON.stringify({id:request.id,result:{}})}\n`));}return result;};child.kill=()=>{child.killed=true;return true;};return child;};
    try{const client=new AppServer({codexHome:'/instruction-filtered-home',sqliteHome:'C:/Users/test/.codex',spawnProcess:fakeSpawn as any});await client.connect();expect(options.env).toMatchObject({CODEX_HOME:'/instruction-filtered-home',CODEX_SQLITE_HOME:'C:/Users/test/.codex',CODEX_PROFILE:'qa-profile',CODEX_CONFIG:'D:/codex/custom-config.toml'});client.close();}finally{if(previousProfile===undefined)delete process.env.CODEX_PROFILE;else process.env.CODEX_PROFILE=previousProfile;if(previousConfig===undefined)delete process.env.CODEX_CONFIG;else process.env.CODEX_CONFIG=previousConfig;}
  });
  const verifiedRuntimeConfig={config:{mcp_servers:{agentmem:{command:'agentmem'}},plugins:{example:{enabled:true}}}};
  it('loads the app-owned delegation policy into orchestrator developer instructions',()=>{
    const instructions=buildOrchestratorDeveloperInstructions('ORCHESTRATOR POLICY COPY');
    expect(instructions).toContain('ORCHESTRATOR POLICY COPY');expect(instructions).toContain('policy-bound orchestration model');expect(instructions).toContain('setup/tool-use stage');expect(instructions).toContain('do not create an assignment in that stage');
  });
  it('accepts only supported approval presets and keeps the safe default',()=>{
    const base={projectRoot:'D:/repo',agentmemProjectId:'demo',orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low'};
    expect(settingsSchema.parse(base).approvalPolicy).toBe('on-request');
    for(const approvalPolicy of ['on-request','untrusted','never','full-access'])expect(settingsSchema.safeParse({...base,approvalPolicy}).success).toBe(true);
    expect(settingsSchema.safeParse({...base,approvalPolicy:'custom'}).success).toBe(false);
    expect(settingsSchema.parse({...base,agentmemProjectId:''}).agentmemProjectId).toBe('');
    expect(settingsSchema.parse({...base,agentmemProjectId:'   '}).agentmemProjectId).toBe('');
    expect(settingsSchema.safeParse({...base,agentmemProjectId:'x'.repeat(129)}).success).toBe(false);
    expect(settingsSchema.safeParse({...base,projectRoot:'',agentmemProjectId:'',agentmemAutoSetup:false}).success).toBe(true);
  });
  it('requests the most detailed supported summaries and available provider text for new and resumed role threads',()=>{
    const orchestrator=makeThreadParams({role:'orchestrator',root:'D:/repo',model:'gpt-6.1-sol',approvalPolicy:'on-request',ownedPolicy:'policy'});
    const worker=makeThreadParams({role:'worker',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request'});
    expect(orchestrator.config).toMatchObject({model_reasoning_summary:'auto',model_supports_reasoning_summaries:true,include_permissions_instructions:false,include_apps_instructions:false,include_collaboration_mode_instructions:false,include_environment_context:false,projects:{'D:/repo':{trust_level:'trusted'}},memories:{use_memories:false,dedicated_tools:false},features:{apps:true,hooks:false,plugins:true,memories:false,multi_agent:false,mcp_2026_07_28:true,codex_apps_mcp_2026_07_28:true}});expect(orchestrator.config).not.toHaveProperty('project_doc_fallback_filenames');expect(orchestrator.config).not.toHaveProperty('project_root_markers');expect(orchestrator.config).not.toHaveProperty('show_raw_agent_reasoning');
    expect(worker.config).toMatchObject(orchestrator.config);
    expect(orchestrator.baseInstructions).toBe(appAgentBaseInstructions('D:/repo'));
    expect(makeThreadResumeParams('thread-1','on-request','orchestrator','D:/repo','policy')).toMatchObject({threadId:'thread-1',excludeTurns:true,config:orchestrator.config,baseInstructions:appAgentBaseInstructions('D:/repo'),developerInstructions:orchestrator.developerInstructions});
    expect(orchestrator.developerInstructions).toContain('policy');
  });
  it('registers only the scoped workspace tool on worker threads and rejects stale or pre-execution calls',()=>{
    const params=makeThreadParams({role:'worker',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request',dynamicTools:workerWorkspaceTool});
    expect(params.dynamicTools).toEqual(workerWorkspaceTool);
    expect(workerWorkspaceTool[0].inputSchema).toMatchObject({properties:{action:{enum:expect.not.arrayContaining(['push','create_pr'])}}});
    expect(makeThreadParams({role:'router',root:'D:/repo',model:'gpt-6-luna',approvalPolicy:'on-request',dynamicTools:workerWorkspaceTool}).dynamicTools).toEqual([]);
    const task:any={id:'task',currentPassId:'pass',phase:'worker_running',workerStage:'execute',workerThreadId:'worker-thread'};const pass:any={id:'pass',workerStage:'execute'};const target={taskId:'task',passId:'pass'};
    expect(authorizesWorkerWorkspaceTool(task,pass,target,'worker-thread')).toBe(true);
    expect(authorizesWorkerWorkspaceTool({...task,workerStage:'context_compose'},pass,target,'worker-thread')).toBe(false);
    expect(authorizesWorkerWorkspaceTool({...task,currentPassId:'corrected-pass'},pass,target,'worker-thread')).toBe(false);
    expect(authorizesWorkerWorkspaceTool(task,pass,target,'another-thread')).toBe(false);
    expect(authorizesWorkerWorkspaceTool(task,pass,{...target,taskId:'other-task'},'worker-thread')).toBe(false);
    expect(normalizeAgentWorkspaceUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(()=>normalizeAgentWorkspaceUrl('https://github.com/org/repo?access_token=secret')).toThrow('authentication parameters');
    expect(()=>normalizeAgentWorkspaceUrl('https://user:password@example.com')).toThrow('credentials');
    expect(workspaceToolRequiresDesktop('open_browser')).toBe(true);expect(workspaceToolRequiresDesktop('inspect_github')).toBe(false);
  });
  it('isolates the router with a classification-only thread and assigns the Fast tier only to its low-effort turn',()=>{
    const router=makeThreadParams({role:'router',root:'/tmp/project',model:'gpt-6-luna',effort:'low',approvalPolicy:'on-request'});
    expect((router as any).dynamicTools).toEqual([]);
    expect(router.config).toMatchObject({project_doc_max_bytes:0,projects:{'/tmp/project':{trust_level:'trusted'}},web_search:'disabled',features:{apps:false,hooks:false,plugins:false,memories:false,multi_agent:false,mcp_2026_07_28:false,codex_apps_mcp_2026_07_28:false}});
    expect(router.developerInstructions).toContain('classification-only');
    const turn=makeTurnParams({threadId:'router',input:'Classify only',role:'router',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'},serviceTierForTurn:'priority'});
    expect(turn).toMatchObject({model:'gpt-6-luna',effort:'low',serviceTierForTurn:'priority',sandboxPolicy:{type:'readOnly',networkAccess:false}});
    const direct=makeTurnParams({threadId:'direct',input:'Answer',role:'direct',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'}});
    const simple=makeTurnParams({threadId:'simple',input:'Edit',role:'simple',model:'gpt-6-luna',effort:'xhigh',writeRoots:['/tmp/project'],approvalPolicy:'on-request',schema:{type:'object'}});
    const simpleInstructions=makeThreadParams({role:'simple',root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'on-request'}).developerInstructions;
    expect(simpleInstructions).toContain('Updating focused tests or docs needed to verify the requested behavior is an ordinary implementation decision');expect(simpleInstructions).toContain('never weaken or rewrite a test merely to hide a failure');
    expect(direct).not.toHaveProperty('serviceTierForTurn');expect(direct.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    expect(simple).not.toHaveProperty('serviceTierForTurn');expect(simple.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['/tmp/project'],networkAccess:false});
    const toolFirst=makeTurnParams({threadId:'setup',input:'Use the setup tools first',role:'orchestrator',model:'gpt-6.1-sol',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:undefined});
    expect(toolFirst).not.toHaveProperty('outputSchema');
    for(const role of ['router','direct','simple','orchestrator','worker'] as const){const thread=makeThreadParams({role,root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'on-request'});expect(thread.config).toMatchObject({projects:{'/tmp/project':{trust_level:'trusted'}}});expect(thread.baseInstructions).toBe(appAgentBaseInstructions('/tmp/project'));expect(thread.baseInstructions).toContain(`Host platform: ${process.platform}`);if(role==='router')expect(thread.config).toHaveProperty('project_doc_max_bytes',0);else{expect(thread.config).not.toHaveProperty('project_doc_fallback_filenames');expect(thread.config).not.toHaveProperty('project_root_markers');}}
  });
  it('serializes attachment image data through the app-server user-input adapter',()=>{
    const image={mediaType:'image/png' as const,data:'iVBORw0KGgo='};
    const input=makeAppServerUserInput('Describe the image',[image]);
    expect(input).toEqual([{type:'text',text:'Describe the image'},{type:'image',url:'data:image/png;base64,iVBORw0KGgo='}]);
    const turn=makeTurnParams({threadId:'router',input:'Describe the image',role:'router',model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'on-request',schema:{type:'object'},images:[image]});
    expect(turn.input).toEqual(input);
  });
  it('uses the native turn/steer RPC with the expected turn, input attachments, and stable message id',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};(client as any).verifiedAgentThreads.add('worker-thread');const request=vi.fn().mockResolvedValue({turnId:'active-turn'});(client as any).request=request;
    await expect(client.steerTurn('worker-thread','active-turn','Please check this image',[{mediaType:'image/png',data:'iVBORw0KGgo='}],'message-1')).resolves.toEqual({turnId:'active-turn'});
    expect(request).toHaveBeenCalledWith('turn/steer',{threadId:'worker-thread',expectedTurnId:'active-turn',input:[{type:'text',text:'Please check this image'},{type:'image',url:'data:image/png;base64,iVBORw0KGgo='}],clientUserMessageId:'message-1'},30000);client.close();
  });
  it('preserves method identity on native server rejection for race-safe steering fallback',async()=>{
    const client=new AppServer();(client as any).child={killed:false,stdin:{write:()=>{}}};const response=client.request('turn/steer',{threadId:'worker-thread',expectedTurnId:'stale'});const pending=[...(client as any).pending.entries()][0];(client as any).consume(JSON.stringify({id:pending[0],error:{code:-32600,message:'no active turn to steer'}})+'\n');await expect(response).rejects.toMatchObject({method:'turn/steer',message:'no active turn to steer'});expect((await response.catch(error=>error)) instanceof AppServerRequestError).toBe(true);client.close();
  });
  it('uses the same app-server user-input adapter for review turns',async()=>{
    const client=new AppServer();(client as any).verifiedAgentThreads.add('thread');const request=vi.fn().mockResolvedValue({turn:{id:'review'}});(client as any).request=request;
    await client.reviewTurn('thread','Review this image','gpt-6.1-sol','low','on-request',[{mediaType:'image/webp',data:'UklGRg=='}]);
    expect(request.mock.calls[0][1].input).toEqual([{type:'text',text:'Review this image'},{type:'image',url:'data:image/webp;base64,UklGRg=='}]);client.close();
  });
  it('allows project AGENTS files while rejecting Codex-home or out-of-root instructions',()=>{
    expect(()=>assertInstructionIsolation({instructionSources:['D:/repo/AGENTS.md']},'D:/repo','C:/app/instruction-filtered-home')).not.toThrow();
    expect(()=>assertInstructionIsolation({instructionSources:['C:/app/instruction-filtered-home/AGENTS.md']},'D:/repo','C:/app/instruction-filtered-home')).toThrow('global Codex-home AGENTS.md');
    expect(()=>assertInstructionIsolation({instructionSources:['C:/Users/user/.codex/AGENTS.md']},'D:/repo','C:/app/instruction-filtered-home')).toThrow('outside the selected project root');
    expect(()=>assertInstructionIsolation({})).toThrow('instruction loading could not be verified');
    expect(()=>assertInstructionIsolation({instructionSources:null})).toThrow('instruction loading could not be verified');
  });
  it('requires normal MCP and plugin configuration before starting agent threads',async()=>{
    expect(()=>assertAgentRuntimeConfig(verifiedRuntimeConfig)).not.toThrow();
    expect(()=>assertAgentRuntimeConfig({config:{mcp_servers:{},plugins:{example:{enabled:true}}}})).toThrow('does not expose the normal configured MCP and plugin settings');
    expect(()=>assertAgentRuntimeConfig({config:{mcp_servers:{agentmem:{}}}})).toThrow('does not expose the normal configured MCP and plugin settings');
    const client=new AppServer({codexHome:'/instruction-filtered-home',cwd:'/instruction-filtered-home/workspace'});(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};const request=vi.fn().mockResolvedValue(verifiedRuntimeConfig);(client as any).request=request;
    await client.verifyAgentRuntimeConfig();await client.verifyAgentRuntimeConfig();expect(request).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledWith('config/read',{cwd:'/instruction-filtered-home/workspace',includeLayers:false},10000);client.close();
    const unsafe=new AppServer({codexHome:'/instruction-filtered-home',cwd:'/instruction-filtered-home/workspace'});(unsafe as any).ready=true;(unsafe as any).child={killed:false,stdin:{write:()=>{}}};const unsafeRequest=vi.fn().mockResolvedValue({config:{mcp_servers:{},plugins:{}}});(unsafe as any).request=unsafeRequest;
    await expect(unsafe.startThread('worker','/repo','gpt-6-luna','high')).rejects.toThrow('does not expose the normal configured MCP and plugin settings');expect(unsafeRequest).toHaveBeenCalledTimes(1);expect(unsafeRequest.mock.calls[0][0]).toBe('config/read');unsafe.close();
  });
  it('checks instruction sources on every role start and resume and preserves MCP-free routing',async()=>{
    const client=new AppServer({codexHome:'/instruction-filtered-home',cwd:'/instruction-filtered-home/workspace'});(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};
    const request=vi.fn().mockResolvedValueOnce(verifiedRuntimeConfig).mockResolvedValueOnce({instructionSources:['/repo/AGENTS.md'],thread:{id:'router-thread'}}).mockResolvedValueOnce({instructionSources:['/outside/AGENTS.md'],thread:{id:'unsafe-thread'}}).mockResolvedValueOnce({instructionSources:['/repo/AGENTS.md'],thread:{id:'direct-thread'}}).mockResolvedValueOnce({turn:{id:'safe-turn'}});
    (client as any).request=request;
    await expect(client.startThread('router','/repo','gpt-6-luna','low')).resolves.toBe('router-thread');
    expect(request.mock.calls[0]).toEqual(['config/read',{cwd:'/instruction-filtered-home/workspace',includeLayers:false},10000]);
    expect(request.mock.calls[1][1]).toMatchObject({cwd:'/repo',baseInstructions:appAgentBaseInstructions('/repo'),config:{project_doc_max_bytes:0,projects:{'/repo':{trust_level:'trusted'}},features:{plugins:false,mcp_2026_07_28:false}}});
    await expect(client.resumeThread('router-thread','on-request','router','/repo')).rejects.toThrow('outside the selected project root');
    await expect(client.startTurn('unsafe-thread','classify','router','gpt-6-luna','low','/isolated/home')).rejects.toThrow('not verified');
    await expect(client.startThread('direct','/repo','gpt-6-luna','low')).resolves.toBe('direct-thread');
    expect(request.mock.calls[3][1].config).toMatchObject({features:{plugins:true,mcp_2026_07_28:true,codex_apps_mcp_2026_07_28:true}});expect(request.mock.calls[3][1].config).not.toHaveProperty('project_doc_fallback_filenames');
    await expect(client.startTurn('direct-thread','answer','direct','gpt-6-luna','low','/repo')).resolves.toMatchObject({turn:{id:'safe-turn'}});
    client.close();
  });
  it('keeps the original Codex process threadless with an RPC allowlist',async()=>{
    const broker=new AppServer({metadataOnly:true});
    await expect(broker.startThread('worker','/repo','gpt-6-luna','high')).rejects.toThrow('metadata-only');
    await expect(broker.request('turn/start',{})).rejects.toThrow('does not permit turn/start');
    await expect(broker.request('thread/resume',{})).rejects.toThrow('does not permit thread/resume');
    const writes:string[]=[];(broker as any).child={killed:false,stdin:{write:(data:string)=>writes.push(data)}};
    expect(()=>broker.respondServerRequest('unexpected-thread',{})).toThrow('does not host agent requests');
    broker.respondServerError('unexpected-request',-32601,'Unsupported');
    expect(JSON.parse(writes[0])).toEqual({id:'unexpected-request',error:{code:-32601,message:'Unsupported'}});
    broker.close();
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
    const client=new AppServer({spawnProcess:fakeSpawn as any,cwd:'/isolated/agent/workspace'});
    await Promise.all([client.connect(),client.connect(),client.connect()]);expect(spawnCount).toBe(1);expect(spawnOptions[0].cwd).toBe('/isolated/agent/workspace');client.close();
  });
  it('preserves the selected normal Codex profile and explicit config path with the instruction-filtered home',async()=>{
    const previousProfile=process.env.CODEX_PROFILE,previousConfig=process.env.CODEX_CONFIG;process.env.CODEX_PROFILE='qa-profile';process.env.CODEX_CONFIG='D:/codex/custom-config.toml';let options:any;
    const fakeSpawn=(_exe:string,_args:string[],spawnOptions:any)=>{options=spawnOptions;const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk:string,...args:any[])=>{const result=write(chunk,...args);for(const line of String(chunk).trim().split('\n')){const request=JSON.parse(line);if(request.method==='initialize')queueMicrotask(()=>child.stdout.write(`${JSON.stringify({id:request.id,result:{}})}\n`));}return result;};child.kill=()=>{child.killed=true;return true;};return child;};
    try{const client=new AppServer({codexHome:'/instruction-filtered-home',spawnProcess:fakeSpawn as any});await client.connect();expect(options.env).toMatchObject({CODEX_HOME:'/instruction-filtered-home',CODEX_PROFILE:'qa-profile',CODEX_CONFIG:'D:/codex/custom-config.toml'});client.close();}finally{if(previousProfile===undefined)delete process.env.CODEX_PROFILE;else process.env.CODEX_PROFILE=previousProfile;if(previousConfig===undefined)delete process.env.CODEX_CONFIG;else process.env.CODEX_CONFIG=previousConfig;}
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
    const orchestration=makeTurnParams({threadId:'t',input:'plan',role:'orchestrator',model:'gpt-6.1-sol',effort:'low',writeRoots:['D:/ignored'],approvalPolicy:'never',schema:{type:'object'}});
    expect(orchestration.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
  });
  it('maps full access to the installed app-server never-approve and danger-full-access policies for all roles',()=>{
    for(const role of ['orchestrator','worker'] as const){
      const thread=makeThreadParams({role,root:'D:/repo',model:role==='worker'?'gpt-6-luna':'gpt-6.1-sol',approvalPolicy:'full-access'});
      expect(thread).toMatchObject({approvalPolicy:'never',sandbox:'danger-full-access'});
      const turn=makeTurnParams({threadId:'thread',input:'work',role,model:'model',effort:'high',writeRoots:[],approvalPolicy:'full-access',schema:{type:'object'}});
      expect(turn).toMatchObject({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
    }
    expect(()=>makeThreadResumeParams('thread','full-access' as any,undefined as any,undefined as any)).toThrow('role and project root are required');
    expect(makeThreadResumeParams('router','full-access','router','/tmp/project')).toMatchObject({approvalPolicy:'never',sandbox:'read-only',config:{project_doc_max_bytes:0,projects:{'/tmp/project':{trust_level:'trusted'}}},baseInstructions:appAgentBaseInstructions('/tmp/project')});
    expect(()=>((makeThreadResumeParams as any)('thread'))).toThrow('role and project root are required');
    for(const role of ['router','direct'] as const){
      const thread=makeThreadParams({role,root:'/tmp/project',model:'gpt-6-luna',approvalPolicy:'full-access'});
      const turn=makeTurnParams({threadId:'thread',input:'answer',role,model:'gpt-6-luna',effort:'low',writeRoots:[],approvalPolicy:'full-access',schema:{type:'object'}});
      expect(thread.sandbox).toBe('read-only');expect(turn.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    }
    const simple=makeTurnParams({threadId:'simple',input:'edit',role:'simple',model:'gpt-6-luna',effort:'xhigh',writeRoots:['/tmp/project'],approvalPolicy:'full-access',schema:{type:'object'}});
    expect(simple.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:['/tmp/project'],networkAccess:true});
  });
  it('uses the full-access sandbox for review turns as well as ordinary turns',async()=>{
    const client=new AppServer();const request=vi.fn().mockResolvedValue({turn:{id:'review'}});(client as any).request=request;(client as any).verifiedAgentThreads.add('thread');
    await client.reviewTurn('thread','review','gpt-6.1-sol','low','full-access');
    expect(request.mock.calls[0][1]).toMatchObject({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  });
  it('converts user approval decisions into the app-server response schema',()=>{
    expect(approvalResponse('item/commandExecution/requestApproval',null,'accept')).toEqual({decision:'accept'});
    expect(approvalResponse('item/fileChange/requestApproval',null,'decline')).toEqual({decision:'decline'});
    const requested={network:{enabled:true}};
    expect(approvalResponse('item/permissions/requestApproval',requested,'accept')).toEqual({permissions:requested,scope:'turn'});
    expect(approvalResponse('item/permissions/requestApproval',requested,'decline')).toEqual({permissions:{},scope:'turn'});
    expect(approvalResponse('mcpServer/elicitation/request',undefined,'accept',{confirmed:true})).toEqual({action:'accept',content:{confirmed:true}});
    expect(approvalResponse('mcpServer/elicitation/request',undefined,'decline')).toEqual({action:'decline'});
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
    const client=new AppServer();(client as any).ready=true;(client as any).verifiedAgentThreads.add('worker-thread');
    const request=vi.fn().mockResolvedValue({threadUsage:{threadId:'worker-thread',estimatedUsageCreditsMicros:125000,groups:[]}});(client as any).request=request;
    await expect(client.threadUsage('worker-thread')).resolves.toEqual({threadId:'worker-thread',estimatedUsageCreditsMicros:125000,groups:[]});
    expect(request).toHaveBeenCalledWith('account/usage/read',{threadId:'worker-thread'},10000);
  });
  it('queries MCP tools from the active thread catalog with pagination',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};(client as any).verifiedAgentThreads.add('direct-thread');const request=vi.fn().mockResolvedValueOnce({data:[{name:'agentmem',tools:{decisions:{}}}],nextCursor:'next'}).mockResolvedValueOnce({data:[{name:'node_repl',tools:{js:{}}}]});(client as any).request=request;
    await expect(client.mcpServerStatus('direct-thread')).resolves.toEqual([{name:'agentmem',tools:{decisions:{}}},{name:'node_repl',tools:{js:{}}}]);
    expect(request).toHaveBeenNthCalledWith(1,'mcpServerStatus/list',{threadId:'direct-thread',detail:'toolsAndAuthOnly',limit:100},15000);expect(request).toHaveBeenNthCalledWith(2,'mcpServerStatus/list',{threadId:'direct-thread',detail:'toolsAndAuthOnly',limit:100,cursor:'next'},15000);client.close();
  });
  it('waits for a specific thread MCP server catalog when one is requested',async()=>{
    const client=new AppServer();(client as any).ready=true;(client as any).child={killed:false,stdin:{write:()=>{}}};(client as any).verifiedAgentThreads.add('orchestrator-thread');const request=vi.fn().mockResolvedValue({data:[{name:'pseudoharness_skills',tools:{skills_list:{}}}]});(client as any).request=request;
    await expect(client.mcpServerStatus('orchestrator-thread','pseudoharness_skills')).resolves.toEqual([{name:'pseudoharness_skills',tools:{skills_list:{}}}]);
    expect(request).toHaveBeenCalledWith('mcpServerStatus/list',{threadId:'orchestrator-thread',detail:'toolsAndAuthOnly',limit:100,serverName:'pseudoharness_skills'},15000);client.close();
  });
  it('reads Codex rate limits without requesting reset-credit detail calls',async()=>{
    const client=new AppServer();(client as any).ready=true;const request=vi.fn().mockResolvedValue({rateLimits:{limitId:'codex'}});(client as any).request=request;
    await expect(client.accountRateLimits()).resolves.toEqual({rateLimits:{limitId:'codex'}});
    expect(request).toHaveBeenCalledWith('account/rateLimits/read',{excludeResetCreditDetails:true},10000);
  });
});
