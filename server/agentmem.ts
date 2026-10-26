import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Receipt } from './contracts.js';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolveMcpHelperLaunch } from './mcp-helper-runtime.js';
import { parse as parseToml } from 'smol-toml';

type Status = { connected:boolean; projectVerified:boolean; detail:string };
export type AgentMemProject = { id:string; name:string; description?:string; sourceRoot:string; memoryDirectory:string };
export type AgentMemSetupMode='register'|'repository'|'ready';
export type AgentMemAuditScope={taskId:string;passId:string;role:'direct'|'simple'|'orchestrator'|'worker';purpose:string;projectId:string;workspaceRoot:string;threadId?:string;contextId:string};
export type AgentMemCallAudit={taskId:string;passId:string;role:AgentMemAuditScope['role'];purpose:string;projectId:string;repositoryId?:string;contextId:string;callId:string;method:string;service:'knowledge'|'repository_index'|'unknown';operation:'read'|'write'|'unknown';status:'running'|'completed'|'failed';startedAt:string;updatedAt:string;resultSummary?:string;error?:string};
function rootKey(value:string){return path.resolve(value).replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();}
function decisionIdKey(value:string){
  const match=value.toLowerCase().replace(/[^a-z0-9]/g,'').match(/^([a-z]+)0*(\d+)$/);
  return match?`${match[1]}${Number(match[2])}`:'';
}
export function relevantDecisions(value:unknown,query:string){
  const records=Array.isArray(value)?value:(value as any)?.decisions||(value as any)?.items||(value as any)?.data?.decisions||[];
  if(!Array.isArray(records))return {items:[],query,match_count:0};
  const queryIds=new Set((query.match(/[a-z]+[-\s]?0*\d+/gi)||[]).map(decisionIdKey).filter(Boolean));
  const searchableTerms=(source:string)=>{
    const terms=source.toLocaleLowerCase().match(/[a-z0-9]{3,}/g)||[];
    const stopWords=new Set(['what','which','that','this','with','from','about','does','have','into','tell','show','explain','decision','decisions','project']);
    const cjkRuns=source.match(/[\u3400-\u9fff\uf900-\ufaff]+/g)||[];
    const cjkTerms=cjkRuns.flatMap(run=>Array.from({length:Math.max(0,run.length-1)},(_,index)=>run.slice(index,index+2)));
    return [...new Set([...terms.filter(term=>!stopWords.has(term)),...cjkTerms])];
  };
  const queryTerms=searchableTerms(query);
  const ranked=records.map((record:any)=>{
    const id=typeof record?.id==='string'?decisionIdKey(record.id):'';
    const text=[record?.title,record?.choice,record?.rationale,record?.original_quote].filter(x=>typeof x==='string').join(' ').toLocaleLowerCase();
    const idMatch=!!id&&queryIds.has(id);
    const score=queryTerms.reduce((total,term)=>total+(new Set(searchableTerms(text)).has(term)?1:0),0);
    return {record,idMatch,score};
  }).filter(x=>x.idMatch||x.score>0).sort((a,b)=>Number(b.idMatch)-Number(a.idMatch)||b.score-a.score);
  return {items:ranked.slice(0,8).map(x=>x.record),query,match_count:ranked.length};
}
export class AgentMem {
  private client?:Client; private transport?:StdioClientTransport;
  private auditScope=new AsyncLocalStorage<AgentMemAuditScope>();
  private auditObserver?: (event:AgentMemCallAudit)=>Promise<void>|void;
  private connecting?:Promise<void>;
  status:Status={connected:false,projectVerified:false,detail:'Not connected'};
  private command?:string; private args:string[]=[]; private env:Record<string,string>={};
  setAuditObserver(observer:(event:AgentMemCallAudit)=>Promise<void>|void){this.auditObserver=observer;}
  withAuditScope<T>(scope:AgentMemAuditScope,run:()=>Promise<T>):Promise<T>{return this.auditScope.run(scope,run);}
  async configure() {
    const codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    let source:string;
    try{source=await readFile(path.join(codexHome,'config.toml'),'utf8');}
    catch(error){throw new Error('Could not read Codex config.toml: '+(error instanceof Error?error.message:'file unavailable'));}
    let config:Record<string,unknown>;
    try{config=parseToml(source) as Record<string,unknown>;}
    catch(error){throw new Error('Could not parse Codex config.toml: '+(error instanceof Error?error.message:'invalid TOML'));}
    const servers=config.mcp_servers;
    const server=servers&&typeof servers==='object'&&!Array.isArray(servers)?(servers as Record<string,unknown>).agentmem:undefined;
    if(!server||typeof server!=='object'||Array.isArray(server))throw new Error('Codex config.toml must define [mcp_servers.agentmem] as a table.');
    const entry=server as Record<string,unknown>;
    if(typeof entry.command!=='string'||!entry.command.trim())throw new Error('Codex config.toml [mcp_servers.agentmem] requires a non-empty string command.');
    const args=entry.args===undefined?[]:entry.args;
    if(!Array.isArray(args)||!args.every(value=>typeof value==='string'))throw new Error('Codex config.toml [mcp_servers.agentmem].args must be an array of strings when provided.');
    const configuredEnv=entry.env===undefined?{}:entry.env;
    if(!configuredEnv||typeof configuredEnv!=='object'||Array.isArray(configuredEnv)||Object.entries(configuredEnv).some(([key,value])=>!key.trim()||typeof value!=='string'))
      throw new Error('Codex config.toml [mcp_servers.agentmem.env] must contain only named string values.');
    this.command=entry.command.trim();this.args=args as string[];
    this.env={...(configuredEnv as Record<string,string>)};
    for(const key of Object.keys(this.env))if(typeof process.env[key]==='string')this.env[key]=process.env[key]!;
    // Preserve explicit AgentMem data-root isolation even when set only on the
    // Pseudoharness launcher rather than in Codex's MCP env table.
    for(const key of ['AGENTMEM_DATA_DIR','AGENTMEM_MEMORY_ROOT'])if(typeof process.env[key]==='string')this.env[key]=process.env[key]!;
  }
  async modelMcpServerConfig(projectId:string,workspaceRoot:string,repositoryRoot=workspaceRoot){
    if(!projectId||!workspaceRoot||!this.command)throw new Error('Choose an AgentMem project ID and project root before exposing project knowledge to a model.');
    const setupMode=await this.setupMode(projectId,workspaceRoot);
    let repository:any;
    if(setupMode!=='register'){
      const repositories=await this.call('repository_list',{project_id:projectId});const rows=Array.isArray(repositories?.repositories)?repositories.repositories:[];
      repository=rows.find((row:any)=>typeof row?.repository_id==='string'&&typeof row?.root==='string'&&rootKey(row.root)===rootKey(repositoryRoot));
      if(!repository&&rootKey(repositoryRoot)!==rootKey(workspaceRoot)){
        await this.call('repository_register',{project_id:projectId,repository_root:path.resolve(repositoryRoot)});
        const refreshed=await this.call('repository_list',{project_id:projectId});const updated=Array.isArray(refreshed?.repositories)?refreshed.repositories:[];
        repository=updated.find((row:any)=>typeof row?.repository_id==='string'&&typeof row?.root==='string'&&rootKey(row.root)===rootKey(repositoryRoot));
        if(!repository)throw new Error('AgentMem did not confirm the recruited worktree repository under the selected project ID. The canonical project registration was not changed.');
      }
    }
    if(setupMode==='ready'&&!repository)throw new Error('The selected AgentMem project has no repository index registered for this exact workspace.');
    const modulePath=fileURLToPath(import.meta.url),launch=resolveMcpHelperLaunch({modulePath,helperFile:modulePath.endsWith('.ts')?'agentmem-mcp-gateway.ts':'agentmem-mcp-gateway.js'});
    const setupTools=setupMode==='register'?['projects','repository_register']:setupMode==='repository'?['repository_register']:[];
    return {command:launch.command,args:launch.args,cwd:launch.cwd,enabled:true,enabled_tools:['attach_project','retrieve_evidence','decisions','requirements','lessons','knowledge','update_project_brief','repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','repository_resync','index_project','check_project_changes',...setupTools],env:{PSEUDOHARNESS_AGENTMEM_PROJECT_ID:projectId,PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT:path.resolve(workspaceRoot),PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID:repository?.repository_id||'',PSEUDOHARNESS_AGENTMEM_SETUP_MODE:setupMode,PSEUDOHARNESS_AGENTMEM_COMMAND:this.command,PSEUDOHARNESS_AGENTMEM_ARGS:JSON.stringify(this.args),PSEUDOHARNESS_AGENTMEM_CONFIG_ENV:JSON.stringify(this.env)}};
  }
  async setupMode(projectId:string,expectedRoot:string):Promise<AgentMemSetupMode>{
    if(!projectId||!expectedRoot)throw new Error('Choose an AgentMem project ID and project root.');
    const projects=await this.projectRows();const idMatch=projects.find(project=>project.id===projectId);const rootMatch=projects.find(project=>typeof project.sourceRoot==='string'&&rootKey(project.sourceRoot)===rootKey(expectedRoot));
    if(idMatch&&(!idMatch.sourceRoot||rootKey(idMatch.sourceRoot)!==rootKey(expectedRoot)))throw new Error('AgentMem project root does not match the selected project root.');
    if(rootMatch&&rootMatch.id!==projectId)throw new Error(`This root is already registered as AgentMem project "${rootMatch.id}". Select that ID; Pseudoharness will not rebind it.`);
    if(!idMatch)return 'register';
    const result:any=await this.call('repository_list',{project_id:projectId});const repositories=Array.isArray(result?.repositories)?result.repositories:[];
    return repositories.some((row:any)=>typeof row?.root==='string'&&rootKey(row.root)===rootKey(expectedRoot))?'ready':'repository';
  }
  async prepareProject(projectId:string,expectedRoot:string){
    const mode=await this.setupMode(projectId,expectedRoot);
    if(mode==='ready'){await this.connect(projectId,expectedRoot);return;}
    this.status={connected:false,projectVerified:false,detail:mode==='register'?`Setup pending · ${projectId} will be registered for this folder by the project agent`:`Setup pending · repository index required for ${projectId}`};
  }
  async connect(projectId:string,expectedRoot:string) {
    try {
      const projects=await this.listProjects();
      const project=projects.find(x=>x.id===projectId);
      if(!project) throw new Error(`AgentMem project "${projectId}" is not registered.`);
      const root=project.sourceRoot;
      if(!root) throw new Error('AgentMem did not return a registered source root, so project identity cannot be verified.');
      if(rootKey(root)!==rootKey(expectedRoot)) throw new Error('AgentMem project root does not match the selected project root.');
      this.status={connected:true,projectVerified:true,detail:`Connected · ${projectId}`}; return project;
    } catch(e) {this.status={connected:!!this.client,projectVerified:false,detail:safeError(e)};throw e;}
  }
  private async ensureConnected(){
    if(this.connecting){await this.connecting;return;}
    if(this.client&&this.transport)return;
    const connection=this.openConnection();this.connecting=connection;
    try{await connection;}finally{if(this.connecting===connection)this.connecting=undefined;}
  }
  private async openConnection(){
    await this.configure();
    const client=new Client({name:'pseudoharness',version:'0.1.0'});
    const transport=new StdioClientTransport({command:this.command!,args:this.args,env:{...this.env,...process.env} as Record<string,string>,stderr:'ignore'});
    this.client=client;this.transport=transport;
    transport.onclose=()=>this.invalidateConnection(client,transport);
    transport.onerror=()=>this.invalidateConnection(client,transport);
    try{await client.connect(transport);if(this.client!==client)throw new Error('AgentMem connection closed during startup.');}
    catch(error){this.invalidateConnection(client,transport);try{await transport.close();}catch{}throw error;}
  }
  private invalidateConnection(client?:Client,transport?:StdioClientTransport){
    if(client&&this.client!==client||transport&&this.transport!==transport)return;
    const current=this.transport;this.client=undefined;this.transport=undefined;
    this.status={connected:false,projectVerified:false,detail:'AgentMem connection closed; retry to reconnect.'};
    if(current)void current.close().catch(()=>{});
  }
  private canReplay(name:string,args:Record<string,unknown>){
    if(['projects','attach_project','requirements','lessons','retrieve_evidence','decisions','task_context'].includes(name))return true;
    if(name==='tasks'&&['show','list'].includes(String(args.action||'')))return true;
    if(name==='record_work'&&args.action==='receipt'&&typeof args.idempotency_key==='string'&&!!args.idempotency_key)return true;
    if(name==='record_work'&&args.action==='release'&&typeof args.lease_token==='string'&&!!args.lease_token&&typeof args.task_id==='string'&&!!args.task_id)return true;
    return false;
  }
  async listProjects():Promise<AgentMemProject[]> {
    const rows=await this.projectRows();
    return rows.flatMap((row:any)=>{
      if(!row||typeof row.id!=='string'||!row.id.trim())return [];
      const sourceRoot=row.source_root||row.root||row.cwd;
      const memoryRoot=row.memory_root||row.memoryRoot;
      if(typeof sourceRoot!=='string'||!sourceRoot.trim()||typeof memoryRoot!=='string'||!memoryRoot.trim()||path.basename(path.dirname(memoryRoot)).toLowerCase()!=='projects')return [];
      return [{id:row.id,name:typeof row.name==='string'&&row.name.trim()?row.name:row.id,...(typeof row.description==='string'&&row.description?{description:row.description}:{}),sourceRoot,memoryDirectory:path.basename(memoryRoot)}];
    }).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id.localeCompare(b.id));
  }
  async registeredProjectForRoot(expectedRoot:string):Promise<AgentMemProject|undefined>{
    const key=rootKey(expectedRoot);return (await this.listProjects()).find(project=>rootKey(project.sourceRoot)===key);
  }
  async repositoryForRoot(projectId:string,expectedRoot:string):Promise<{repository_id:string;root:string}|undefined>{
    const result:any=await this.call('repository_list',{project_id:projectId});const rows=Array.isArray(result?.repositories)?result.repositories:[];
    const match=rows.find((row:any)=>typeof row?.repository_id==='string'&&typeof row?.root==='string'&&rootKey(row.root)===rootKey(expectedRoot));
    return match?{repository_id:match.repository_id,root:match.root}:undefined;
  }
  private async projectRows():Promise<any[]>{
    const result:any=await this.call('projects',{action:'list'});const rows=Array.isArray(result)?result:result?.projects||result?.items||result?.data?.projects;
    if(!Array.isArray(rows))throw new Error('AgentMem project list did not contain a projects array.');return rows.map((row:any)=>row&&typeof row==='object'?{...row,sourceRoot:row.source_root||row.root||row.cwd,memoryRoot:row.memory_root||row.memoryRoot}:row);
  }
  private async call(name:string,args:Record<string,unknown>) {
    for(let attempt=0;attempt<2;attempt++){
      let client:Client|undefined;const scope=this.auditScope.getStore();const callId=randomUUID();const startedAt=new Date().toISOString();let sent=false;let finalized=false;
      const repositoryMethods=new Set(['repository_list','repository_register','repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','repository_resync']);
      const service:AgentMemCallAudit['service']=repositoryMethods.has(name)?'repository_index':'knowledge';
      const action=String(args.action||'');
      const write= name==='repository_register'||name==='repository_resync'||name==='update_project_brief'||name==='index_project'||name==='record_work'&&action==='receipt'||name==='record_work'&&action==='release'||name==='requirements'&&['create','revise','fulfill'].includes(action)||name==='decisions'&&action==='create'||name==='knowledge'&&['create','update'].includes(action)||name==='lessons'&&['propose','review'].includes(action);
      const operation:AgentMemCallAudit['operation']=write?'write':'read';
      const audit=async(event:Partial<AgentMemCallAudit>)=>{if(scope)await this.auditObserver?.({...scope,callId,method:name,service,operation,status:'running',startedAt,updatedAt:new Date().toISOString(),...(typeof args.project_id==='string'?{projectId:args.project_id}:{}),...(typeof args.repository_id==='string'?{repositoryId:args.repository_id}:{}),...event});};
      try{
        await this.ensureConnected();client=this.client;
        if(!client)throw new Error('AgentMem is not connected.');
        await audit({status:'running'});sent=true;
        const result:any=await client.callTool({name,arguments:args});
        if(result.isError) {const failure=new Error(result.content?.map((x:any)=>x.text||'').join('\n')||`AgentMem ${name} failed`);await audit({status:'failed',error:`AgentMem ${name} returned an MCP error.`});finalized=true;throw failure;}
        const text=result.content?.find((x:any)=>x.type==='text')?.text;
        let value:any;if(text) {try{value=JSON.parse(text)}catch{}}value??=result.structuredContent||result;
        await audit({status:'completed',resultSummary:auditResultSummary(value)});finalized=true;return value;
      }catch(error){
        // Only record failures after the call was sent; configuration/connection errors are not MCP calls.
        if(sent&&!finalized)await audit({status:'failed',error:auditFailure(name,error)});
        if(!isTransportFailure(error)||attempt>0)throw error;
        if(client)this.invalidateConnection(client,this.transport);
        if(!this.canReplay(name,args))throw error;
      }
    }
    throw new Error(`AgentMem ${name} failed after reconnecting.`);
  }
  async context(projectId:string,query:string) {
    const [attached,requirements,lessons,evidence,decisions]=await Promise.all([
      this.call('attach_project',{project_id:projectId,query,max_chars:4500,include_sources:true}),
      this.call('requirements',{action:'list',project_id:projectId}),
      this.call('lessons',{action:'retrieve',project_id:projectId,query}),
      this.call('retrieve_evidence',{project_id:projectId,query,limit:8}),
      this.call('decisions',{action:'list',project_id:projectId}),
    ]);
    return {attached,requirements,lessons,evidence,decisions:relevantDecisions(decisions,query)};
  }
  async createWork(projectId:string,title:string,goal:string,paths:string[],criteria:string[]) {
    const result=await this.call('tasks',{action:'create',project_id:projectId,title,goal,authorized_paths:paths,acceptance:criteria});
    const taskId=result.task?.id||result.task_id||result.id;
    if(!taskId) throw new Error('AgentMem created no task ID.');
    const claimed=await this.call('claim_task',{project_id:projectId,task_id:taskId,owner:'pseudoharness-local',lease_seconds:3600});
    const lease=claimed.lease_token||claimed.lease?.token||claimed.token;
    if(!lease) throw new Error('AgentMem did not issue a task lease.');
    return {taskId,lease};
  }
  async retryReceipt(projectId:string,taskId:string,receipt:unknown){
    const existing=await this.call('tasks',{action:'show',project_id:projectId,task_id:taskId});
    if(existing.status==='done')return {status:'done',receipt_id:existing.latest_receipt_id,ownership_released:true,completion_accepted:true};
    if(existing.status!=='in_progress')throw new Error(`AgentMem task is ${existing.status}; only this app's released in-progress work can be retried.`);
    const claimed=await this.call('claim_task',{project_id:projectId,task_id:taskId,owner:'pseudoharness-local',lease_seconds:3600});
    const lease=claimed.lease_token||claimed.lease?.token||claimed.token;
    if(!lease)throw new Error('AgentMem did not issue a lease for retrying the saved receipt.');
    return this.recordReceipt(projectId,taskId,lease,receipt);
  }
  async recordReceipt(projectId:string,taskId:string,lease:string,receipt:unknown) {
    const appReceipt=receipt as Receipt & Record<string,unknown>;
    let payload:any;let saved:any;
    try{
      const context=await this.completionContext(projectId,taskId);
      payload=toAgentMemReceipt(appReceipt,context);
      saved=await this.call('record_work',{action:'receipt',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local',idempotency_key:`pseudoharness-${taskId}-receipt-v2`,receipt:payload});
    }catch(error){
      let message=`Could not prepare or save the AgentMem receipt: ${safeError(error)}`;let ownershipReleased=false;
      try{await this.releaseWork(projectId,taskId,lease);ownershipReleased=true;}catch(releaseError){message+=`; lease release also failed: ${safeError(releaseError)}`;}
      const failure=new Error(message,{cause:error});(failure as Error&{ownershipReleased?:boolean}).ownershipReleased=ownershipReleased;throw failure;
    }
    if(saved.status!=='done') {
      if(appReceipt.status==='blocked'&&!saved.duplicate)await this.call('record_work',{action:'block',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local',blocked_reason:appReceipt.result.slice(0,4000)});
      await this.call('record_work',{action:'release',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local'});
      return {...saved,ownership_released:true,...(payload.status==='done'?{completion_accepted:false,actionable_error:saved.note||'AgentMem did not accept completion; the saved task was released for follow-up.'}:{})};
    }
    return saved;
  }
  private async completionContext(projectId:string,taskId:string){
    const args={project_id:projectId,task_id:taskId,max_chars:12000,requirements_limit:1000,acceptance_limit:1000};
    const first=await this.call('task_context',{...args,requirement_offset:0,acceptance_offset:0});
    const initialRequirements=first?.requirements;
    if(!initialRequirements||!Number.isInteger(initialRequirements.requirements_revision))throw new Error('AgentMem task context omitted the current requirements revision; completion was not requested.');
    const requirements=[...(Array.isArray(initialRequirements.applicable_requirements)?initialRequirements.applicable_requirements:[])];
    let complete=initialRequirements.requirements_complete===true;
    let next=initialRequirements.next_requirement_offset;
    const seenOffsets=new Set<number>();
    while(!complete){
      if(!Number.isInteger(next)||next<0||seenOffsets.has(next)||seenOffsets.size>=100)throw new Error('AgentMem returned an incomplete requirement page without a safe continuation; completion was not requested.');
      seenOffsets.add(next);
      const page=await this.call('task_context',{...args,requirement_offset:next,acceptance_offset:0});
      const req=page?.requirements;
      if(req?.requirements_revision!==initialRequirements.requirements_revision)throw new Error('AgentMem requirements changed while assembling completion evidence; retry after refreshing task context.');
      if(!Array.isArray(req?.applicable_requirements)||!req.applicable_requirements.length&&req.requirements_complete!==true)throw new Error('AgentMem returned an empty incomplete requirement page; completion was not requested.');
      requirements.push(...(req.applicable_requirements||[]));
      complete=req.requirements_complete===true;
      next=req.next_requirement_offset;
    }
    const task={...first.task};
    let acceptance=Array.isArray(task.acceptance)?[...task.acceptance]:[];
    let acceptanceComplete=task.acceptance_complete!==false;
    let nextAcceptance=task.next_acceptance_offset;
    const seenAcceptanceOffsets=new Set<number>();
    while(!acceptanceComplete){
      if(!Number.isInteger(nextAcceptance)||nextAcceptance<0||seenAcceptanceOffsets.has(nextAcceptance)||seenAcceptanceOffsets.size>=100)throw new Error('AgentMem returned an incomplete task-acceptance page without a safe continuation; completion was not requested.');
      seenAcceptanceOffsets.add(nextAcceptance);
      const page=await this.call('task_context',{...args,requirement_offset:0,acceptance_offset:nextAcceptance});
      if(page?.task?.acceptance_revision!==task.acceptance_revision)throw new Error('AgentMem task acceptance changed while assembling completion evidence; retry after refreshing task context.');
      if(!Array.isArray(page?.task?.acceptance)||!page.task.acceptance.length&&page.task.acceptance_complete!==true)throw new Error('AgentMem returned an empty incomplete task-acceptance page; completion was not requested.');
      acceptance.push(...page.task.acceptance);
      acceptanceComplete=page.task.acceptance_complete===true;
      nextAcceptance=page.task.next_acceptance_offset;
    }
    task.acceptance=acceptance;
    task.acceptance_complete=acceptanceComplete;
    return {...first,task,requirements:{...initialRequirements,applicable_requirements:requirements,requirements_complete:complete,next_requirement_offset:null}};
  }
  async releaseWork(projectId:string,taskId:string,lease:string){
    return this.call('record_work',{action:'release',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local'});
  }
  close(){this.invalidateConnection(this.client,this.transport);this.status={connected:false,projectVerified:false,detail:'Disconnected'};}
}
function auditFailure(method:string,error:unknown){const message=error instanceof Error?error.message:String(error);if(/root does not match|not registered|cannot be verified/i.test(message))return 'Selected AgentMem project identity could not be verified.';if(isTransportFailure(error))return 'AgentMem connection failed during the request.';return `AgentMem ${method} request failed.`;}
function auditResultSummary(value:any){
  const refs:string[]=[];const visit=(x:any)=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){for(const row of x.slice(0,40))visit(row);return;}for(const key of ['source_ref','source_id','decision_id','requirement_id','lesson_id','id'])if(typeof x[key]==='string'&&x[key].length<160)refs.push(`${key}:${x[key]}`);for(const key of ['items','results','decisions','requirements','lessons','evidence','sources','projects'])if(x[key])visit(x[key]);};visit(value);
  const unique=[...new Set(refs)].slice(0,12);const counts=['items','results','decisions','requirements','lessons','evidence','sources','projects'].flatMap(key=>Array.isArray(value?.[key])?[`${key}=${value[key].length}`]:[]);
  return [...counts,...(unique.length?[`refs=${unique.join(', ')}`]:[])].join(' · ').slice(0,700)||'Response received';
}
export function toAgentMemReceipt(receipt:Receipt & Record<string,unknown>,context:any){
  const scopedAcceptance=Array.isArray(context?.task?.acceptance)?context.task.acceptance:[];
  const assignedAcceptance=Array.isArray((receipt as any).assignment?.acceptance)?(receipt as any).assignment.acceptance:[];
  const taskAcceptance:string[]=scopedAcceptance.length?scopedAcceptance:assignedAcceptance;
  const acceptanceMatches=!scopedAcceptance.length||!assignedAcceptance.length||
    (scopedAcceptance.length===assignedAcceptance.length&&scopedAcceptance.every((value:string,index:number)=>value===assignedAcceptance[index]));
  const verifications=receipt.verification.filter(v=>v.result==='passed'&&v.evidence).map(v=>`${v.check}: ${v.evidence}`);
  const accepted=receipt.status==='complete'&&receipt.decision_required===null&&receipt.acceptance.unmet.length===0&&
    receipt.review_outcome==='accept'&&taskAcceptance.length>0&&acceptanceMatches;
  const acceptanceChecks=taskAcceptance.map(criterion=>({
    criterion,met:accepted,evidence:accepted?`The orchestrator accepted this assignment criterion after reviewing the worker receipt. Worker receipt evidence: ${receipt.acceptance.met.join('; ')||receipt.result}. ${verifications.join(' | ')||receipt.result}`:''
  }));
  const reqs=context?.requirements;
  const applicable=Array.isArray(reqs?.applicable_requirements)?reqs.applicable_requirements:[];
  const requirementsComplete=reqs?.requirements_complete===true;
  const requirementChecks=applicable.map((r:any)=>({requirement_id:r.id,revision:r.revision,met:accepted,
    evidence:accepted?`This task's accepted work complied with the scoped requirement for its assigned change. This check does not change project requirement fulfillment. Acceptance evidence: ${receipt.acceptance.met.join('; ')}. ${verifications.join(' | ')||receipt.result}`:''
  }));
  return {
  status:accepted&&requirementsComplete?'done':'in_progress',
  application_status:receipt.status,
  result:receipt.result,
  changes:receipt.changes,
  acceptance_checks:acceptanceChecks,
  requirements_revision:reqs?.requirements_revision,
  requirement_checks:requirementChecks,
  verification:receipt.verification,
  risks:receipt.risks,
  knowledge:receipt.knowledge,
  decision_required:receipt.decision_required,
  app_task_id:receipt.app_task_id,
  assignment:receipt.assignment,
  review:receipt.review,
  note:accepted&&requirementsComplete?'Accepted app receipt; AgentMem task completion requested. Project requirement fulfillment remains independent.':'Application outcome did not meet the AgentMem task completion contract; preserve as in progress and release the lease.'
};}
export function safeError(e:unknown){return (e instanceof Error?e.message:String(e)).replace(/(?:[A-Z]:\\[^\s]+|\/[^\s]+\.toml)/gi,'[local path]').slice(0,500);}
function isTransportFailure(error:unknown){return /connection closed|transport closed|not connected|client is closed|process exited|broken pipe|\bEPIPE\b|\bECONNRESET\b/i.test(error instanceof Error?error.message:String(error));}
export function agentMemRecordState(saved:any,appStatus:string){
  return {status:saved.status,receiptId:saved.receipt_id,ownershipReleased:saved.status==='done'||saved.ownership_released===true,error:saved.actionable_error||((appStatus==='complete'&&saved.status!=='done')?saved.note||'AgentMem did not accept task completion. Review the saved receipt and task checks.':undefined)};
}
export function agentMemRecordFailure(error:unknown){return {status:'failed',error:`AgentMem receipt save/completion failed: ${safeError(error)}`};}
export function agentMemFailureReleased(error:unknown){return (error as {ownershipReleased?:boolean}|null)?.ownershipReleased===true;}
