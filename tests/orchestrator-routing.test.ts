import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fake=vi.hoisted(()=>({instance:null as any,agentInstance:null as any,instances:[] as any[],threadOwners:new Map<string,any>(),calls:[] as any[],threadCount:0,turnCount:0,fastAvailable:true}));
vi.mock('../server/codex.js',()=>{
  class FakeAppServer{
    ready=false;
    listeners=new Map<string,((...args:any[])=>void)[]>();
    constructor(options:any={}){fake.instances.push(this);if(options.metadataOnly)fake.instance=this;else fake.agentInstance=this;}
    on(event:string,listener:(...args:any[])=>void){this.listeners.set(event,[...(this.listeners.get(event)||[]),listener]);return this;}
    emit(event:string,...args:any[]){for(const listener of this.listeners.get(event)||[])listener(...args);return true;}
    async connect(){this.ready=true;this.emit('connected');}
    async verifyAgentIsolationConfig(){return;}
    async exportChatGPTAuthTokens(){return {accessToken:'opaque-test-token',chatgptAccountId:'test-account'};}
    async useExternalChatGPTAuth(){return;}
    async refreshChatGPTAuthTokens(previousAccountId:string|null){fake.calls.push({kind:'refresh-auth',previousAccountId});return {accessToken:'opaque-refreshed-token',chatgptAccountId:'test-account',chatgptPlanType:'plus'};}
    respondServerRequest(id:string|number,result:unknown){fake.calls.push({kind:'server-response',id,result});}
    async models(){return [
      {id:'gpt-6-luna',supportedReasoningEfforts:['low','high','xhigh'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:fake.fastAvailable?[{id:'priority'}]:[]},
      {id:'gpt-6-sol',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort}))},
    ] as any;}
    async startThread(role:string,root:string,model:string,effort:string,approvalPolicy:string){const threadId=`${role}-${++fake.threadCount}`;fake.threadOwners.set(threadId,this);fake.calls.push({kind:'thread',server:this===fake.agentInstance?'agent':'broker',role,root,model,effort,approvalPolicy,threadId});return threadId;}
    async resumeThread(threadId:string){return threadId;}
    async startTurn(threadId:string,input:string,role:string,model:string,effort:string,root:string,writeRoots:string[]=[],approvalPolicy:string,schema?:unknown,serviceTierForTurn?:string){const turnId=`turn-${++fake.turnCount}`;fake.calls.push({kind:'turn',threadId,input,role,model,effort,root,writeRoots,approvalPolicy,schema,serviceTierForTurn,turnId});return {turn:{id:turnId}};}
    async reviewTurn(threadId:string,input:string,model:string,effort:string,approvalPolicy:string){return this.startTurn(threadId,input,'orchestrator',model,effort,'/workspace',[],approvalPolicy);}
    async accountRateLimits(){return null;}
    threadUsage(){return new Promise<never>(()=>{});}
    async interrupt(threadId:string,turnId:string){fake.calls.push({kind:'interrupt',threadId,turnId});}
    close(){this.ready=false;}
  }
  const extractAssistantText=(turn:any)=>turn?.items?.filter((item:any)=>['agentMessage','assistantMessage','message'].includes(item.type)).map((item:any)=>item.text??'').join('\n').trim()||'';
  const approvalResponse=(method:string,requested:unknown,decision:string)=>method==='item/permissions/requestApproval'?{permissions:decision==='accept'&&requested?requested:{},scope:'turn'}:{decision};
  return {AppServer:FakeAppServer,extractAssistantText,approvalResponse};
});

let dataDirectory='';let projectRoot='';let previousDataDirectory:string|undefined;let modules:any;
const assignment={outcome:'Perform the requested implementation.',deliverable:'A bounded change.',read_scope:[],write_scope:[],exclusions:[],constraints:[],context_refs:[],acceptance:['The requested behavior is delivered.'],verification:['Run focused verification.'],ordinary_authority:['Choose local implementation details.'],escalation_conditions:['Scope expands.'],receipt_requirements:['Return status and evidence.']};
const receipt={status:'complete',result:'Completed and verified.',changes:[],acceptance:{met:['The requested behavior is delivered.'],unmet:[]},verification:[{check:'Focused behavior check',result:'passed',evidence:'Mocked lifecycle completed.'},{check:'Unrelated integration suite',result:'not_run',evidence:null}],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null};
async function waitFor(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for the routed workflow.');}
async function setup(fast=true){
  vi.resetModules();fake.calls=[];fake.instances=[];fake.instance=null;fake.agentInstance=null;fake.threadOwners.clear();fake.threadCount=0;fake.turnCount=0;fake.fastAvailable=fast;
  previousDataDirectory=process.env.PSEUDOHARNESS_DATA_DIR;dataDirectory=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-route-test-'));process.env.PSEUDOHARNESS_DATA_DIR=dataDirectory;
  projectRoot=path.join(dataDirectory,'workspace');await import('node:fs/promises').then(fs=>fs.mkdir(path.join(projectRoot,'src'),{recursive:true}));
  const state=await import('../server/state.js');await state.loadState();await state.mutate(value=>{value.settings={...value.settings,projectRoot,agentmemProjectId:'',orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'};});
  const orchestrator=await import('../server/orchestrator.js');await orchestrator.initialize();await waitFor(()=>orchestrator.getRuntimeStatus().codex.models.length>0);modules={state,orchestrator};return modules;
}
function lastTurn(role:string){const turn=[...fake.calls].reverse().find(row=>row.kind==='turn'&&row.role===role);if(!turn)throw new Error(`No ${role} turn started.`);return turn;}
async function complete(role:string,value:unknown){const turn=lastTurn(role);const owner=fake.threadOwners.get(turn.threadId)||fake.instance;owner.emit('notification','turn/completed',{threadId:turn.threadId,turn:{id:turn.turnId,status:'completed',items:[{type:'agentMessage',text:JSON.stringify(value)}]}});return turn;}
async function waitForRole(role:string){await waitFor(()=>fake.calls.some(row=>row.kind==='turn'&&row.role===role));return lastTurn(role);}

afterEach(async()=>{await new Promise(resolve=>setImmediate(resolve));if(modules?.state)await modules.state.mutate(()=>{});if(modules?.orchestrator){modules.orchestrator.shutdown();modules=null;}if(previousDataDirectory===undefined)delete process.env.PSEUDOHARNESS_DATA_DIR;else process.env.PSEUDOHARNESS_DATA_DIR=previousDataDirectory;if(dataDirectory)await rm(dataDirectory,{recursive:true,force:true});});
beforeEach(()=>vi.clearAllMocks());

describe('routed request workflow',()=>{
  it('writes the app-owned isolated runtime config without ambient instruction sources or saved credentials',async()=>{
    await setup();
    const config=await readFile(path.join(dataDirectory,'agent-codex-home-v1','config.toml'),'utf8');
    expect(config).toContain('include_permissions_instructions = false');expect(config).toContain('include_environment_context = false');
    expect(config).toContain('project_doc_max_bytes = 0');expect(config).toContain('include_instructions = false');expect(config).toContain('use_memories = false');
    expect(config).toContain('multi_agent = false');expect(config).toContain('experimental_compact_prompt_file = ');
    await expect(readFile(path.join(dataDirectory,'agent-codex-home-v1','auth.json'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('bridges isolated-agent credential refresh through the metadata-only signed-in transport',async()=>{
    await setup();fake.agentInstance.emit('serverRequest','agent-auth-1','account/chatgptAuthTokens/refresh',{reason:'unauthorized',previousAccountId:'test-account'});
    await waitFor(()=>fake.calls.some(row=>row.kind==='server-response'));
    expect(fake.calls.find(row=>row.kind==='refresh-auth')).toMatchObject({previousAccountId:'test-account'});
    expect(fake.calls.find(row=>row.kind==='server-response')).toMatchObject({id:'agent-auth-1',result:{accessToken:'opaque-refreshed-token',chatgptAccountId:'test-account',chatgptPlanType:'plus'}});
  });
  it('runs a direct answer only on Luna and records a user-facing answer without a worker receipt',async()=>{
    const {orchestrator}=await setup();let task=await orchestrator.submitTask('Explain why the sky looks blue.');expect(task.phase).toBe('routing');const router=lastTurn('router');expect(router).toMatchObject({model:'gpt-6-luna',effort:'low',serviceTierForTurn:'priority'});
    await complete('router',{route:'direct_answer',rule_id:'direct_explanation_or_transform',justification:'A concise explanation needs no implementation.'});const direct=await waitForRole('direct');expect(direct).toMatchObject({model:'gpt-6-luna',effort:'low',serviceTierForTurn:undefined});expect(fake.calls.some(row=>row.role==='orchestrator')).toBe(false);
    await complete('direct',{type:'answer',answer:'Short wavelengths scatter more strongly.',escalation:null,route:null,justification:null});await waitFor(()=>modules.state.getTask(task.id)?.phase==='accepted');task=modules.state.getTask(task.id);expect(task).toMatchObject({resolution:'direct'});expect(task.passes?.[0].publicAnswer).toBe('Short wavelengths scatter more strongly.');expect(task.receipt).toBeUndefined();
  });
  it('runs a bounded implementation on Luna xhigh, confines it to the workspace and does not start Sol review',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Fix the known typo under `src/` and run its focused test.');await complete('router',{route:'simple_implementation',rule_id:'simple_bounded_correction',justification:'This is a known localized correction with clear verification.'});const simple=await waitForRole('simple');expect(simple).toMatchObject({model:'gpt-6-luna',effort:'xhigh',writeRoots:[path.join(projectRoot,'src')],serviceTierForTurn:undefined});expect(fake.calls.some(row=>row.role==='orchestrator')).toBe(false);
    await complete('simple',{type:'complete',receipt,escalation:null});await waitFor(()=>modules.state.getTask(task.id)?.phase==='accepted');expect(modules.state.getTask(task.id)).toMatchObject({phase:'accepted',resolution:'simple',reviewNote:expect.stringContaining('No Sol review')});
  });
  it('escalates a direct answer to Luna simple work without entering the hard flow',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Explain then rename one bounded internal label under `src/`.');await complete('router',{route:'direct_answer',rule_id:'direct_explanation_or_transform',justification:'The initial request appears to ask for a brief explanation.'});await waitForRole('direct');await complete('direct',{type:'escalate',answer:null,escalation:'The request includes a bounded implementation.',route:'simple_implementation',justification:'Rename one known internal label and run its focused test.'});const simple=await waitForRole('simple');expect(simple).toMatchObject({model:'gpt-6-luna',effort:'xhigh',writeRoots:[path.join(projectRoot,'src')]});expect(fake.calls.some(row=>row.role==='orchestrator')).toBe(false);expect(modules.state.getTask(task.id)?.executionEscalation).toMatchObject({from:'direct_answer',to:'simple_implementation'});
    await complete('simple',{type:'complete',receipt,escalation:null});await waitFor(()=>modules.state.getTask(task.id)?.phase==='accepted');expect(modules.state.getTask(task.id)).toMatchObject({resolution:'simple'});
  });
  it('carries completed simple actions and evidence into the hard assignment after escalation',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Make the bounded change under `src/` and handle any consequential schema choice.');await complete('router',{route:'simple_implementation',rule_id:'simple_bounded_correction',justification:'The initial change is bounded and has focused verification.'});await waitForRole('simple');const completedActions=['Updated the local parser callsite.'];const evidence=['Focused test now exposes a persisted schema mismatch.'];await complete('simple',{type:'escalate',receipt:null,escalation:{decision_needed:'Choose a backward-compatible stored field mapping.',completed_actions:completedActions,evidence}});const sol=await waitForRole('orchestrator');expect(sol).toMatchObject({model:'gpt-6-sol',effort:'high'});expect(sol.input).toContain('COMPLETED ACTIONS (preserve; do not repeat)');expect(sol.input).toContain(JSON.stringify(completedActions));expect(sol.input).toContain(JSON.stringify(evidence));expect(modules.state.getTask(task.id)?.executionEscalation).toMatchObject({from:'simple_implementation',to:'hard_task',completedActions,evidence});
  });
  it('forces hard tasks through assignment, Luna execution, and Sol review without a direct-answer downgrade',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Add a new, multi-screen feature.');await complete('router',{route:'hard_task',rule_id:'hard_new_feature',justification:'This request introduces new behavior.'});const sol=await waitForRole('orchestrator');expect(sol.schema).toMatchObject({type:'object',required:expect.arrayContaining(['write_scope','acceptance'])});
    await complete('orchestrator',assignment);const worker=await waitForRole('worker');expect(worker).toMatchObject({model:'gpt-6-luna',effort:'high'});await complete('worker',{type:'receipt',receipt,decision_needed:null,evidence:[],options:[],recommendation:null,consequences:[]});await waitFor(()=>fake.calls.filter(row=>row.kind==='turn'&&row.role==='orchestrator').length===2);await complete('orchestrator',{outcome:'accept',note:'Receipt verified.',assignment:null,decision_required:null});await waitFor(()=>modules.state.getTask(task.id)?.phase==='accepted');expect(modules.state.getTask(task.id)).toMatchObject({phase:'accepted',resolution:'delegated'});expect(fake.calls.filter(row=>row.kind==='thread'&&row.role==='orchestrator')).toHaveLength(1);expect(fake.calls.filter(row=>row.kind==='thread').every(row=>row.server==='agent')).toBe(true);
  });
  it('surfaces required router Fast startup failures for new tasks and follow-up passes',async()=>{
    const {orchestrator}=await setup(false);const first=await orchestrator.submitTask('What is 2 + 2?');expect(first.phase).toBe('needs_attention');expect(first.error).toContain('Fast service tier');
    const followup=await orchestrator.submitTask('Try again with the same request.',first.id);expect(followup.phase).toBe('needs_attention');expect(followup.error).toContain('Fast service tier');expect(followup.passes).toHaveLength(2);
  });
  it('keeps a valid route when the selected executor fails to start',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Fix one bounded issue under `src/`.');const original=fake.agentInstance.startThread.bind(fake.agentInstance);fake.agentInstance.startThread=async(role:string,...args:any[])=>{if(role==='simple')throw new Error('GPT-6 Luna xhigh is unavailable.');return original(role,...args);};
    await complete('router',{route:'simple_implementation',rule_id:'simple_bounded_correction',justification:'This is a known localized correction with clear verification.'});await waitFor(()=>modules.state.getTask(task.id)?.phase==='needs_attention');expect(modules.state.getTask(task.id)?.routeDecision?.route).toBe('simple_implementation');expect(modules.state.getTask(task.id)?.error).toContain('xhigh is unavailable');expect(fake.calls.some(row=>row.role==='orchestrator')).toBe(false);
  });
  it('routes simple work through the hard assignment when no bounded user-named directory exists',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('Fix the known typo in src/label.ts.');
    await complete('router',{route:'simple_implementation',rule_id:'simple_bounded_correction',justification:'This is a known localized correction with clear verification.'});
    const sol=await waitForRole('orchestrator');expect(sol.input).toContain('Fix the known typo in src/label.ts.');expect(sol.input).toContain('explicitly named, existing project directory');expect(fake.calls.some(row=>row.kind==='turn'&&row.role==='simple')).toBe(false);
    expect(modules.state.getTask(task.id)?.routeDecision).toMatchObject({route:'simple_implementation',effectiveRoute:'hard_task'});
  });
  it('conservatively starts the hard-task assignment when router output is malformed',async()=>{
    const {orchestrator}=await setup();const task=await orchestrator.submitTask('A request with an invalid route payload.');await complete('router',{route:'simple_implementation',rule_id:'hard_new_feature',justification:'Mismatched rule'});await waitForRole('orchestrator');const routed=modules.state.getTask(task.id);expect(routed?.routeDecision).toMatchObject({route:'hard_task',effectiveRoute:'hard_task',rule_id:'hard_significant_uncertainty',fallback:true});expect(routed?.routeDecision?.justification).toContain('failed validation');expect(routed?.allowDirectResponse).toBe(false);
  });
  it('interrupts a turn/start response that resolves after a routed task is cancelled',async()=>{
    const {orchestrator}=await setup();let release:(value:{turn:{id:string}})=>void=()=>{};const deferred=new Promise<{turn:{id:string}}>(resolve=>{release=resolve;});const original=fake.agentInstance.startTurn.bind(fake.agentInstance);fake.agentInstance.startTurn=(...args:any[])=>{const result=original(...args);return args[2]==='router'?deferred:result;};
    const pending=orchestrator.submitTask('Classify this request.');await waitFor(()=>fake.calls.some(row=>row.kind==='turn'&&row.role==='router'));const row=modules.state.getState().tasks[0];await orchestrator.cancelTask(row.id);release({turn:{id:'late-turn'}});await pending;await waitFor(()=>fake.calls.some(call=>call.kind==='interrupt'&&call.turnId==='late-turn'));expect(modules.state.getTask(row.id)?.phase).toBe('cancelled');
  });
  it('does not revive a router start that resolves after cancellation and interrupts a late turn response',async()=>{
    const {orchestrator}=await setup();let release:(value:string)=>void=()=>{};const deferred=new Promise<string>(resolve=>{release=resolve;});const original=fake.agentInstance.startThread.bind(fake.agentInstance);fake.agentInstance.startThread=async(role:string,...args:any[])=>role==='router'?deferred:original(role,...args);
    const pending=orchestrator.submitTask('Classify this request.');await waitFor(()=>modules.state.getState().tasks.length===1);const row=modules.state.getState().tasks[0];await orchestrator.cancelTask(row.id);release('late-router-thread');await pending;await new Promise(resolve=>setTimeout(resolve,20));expect(modules.state.getTask(row.id)?.phase).toBe('cancelled');expect(fake.calls.some(call=>call.kind==='turn'&&call.role==='router')).toBe(false);
  });
});
