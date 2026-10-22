import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Receipt } from './contracts.js';
import os from 'node:os';

type Status = { connected:boolean; projectVerified:boolean; detail:string };
export type AgentMemProject = { id:string; name:string; description?:string; sourceRoot:string; memoryDirectory:string };
export class AgentMem {
  private client?:Client; private transport?:StdioClientTransport;
  private connecting?:Promise<void>;
  status:Status={connected:false,projectVerified:false,detail:'Not connected'};
  private command?:string; private args:string[]=[]; private env:Record<string,string>={};
  async configure() {
    const codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    const config=await readFile(path.join(codexHome,'config.toml'),'utf8');
    const block=config.match(/\[mcp_servers\.agentmem\]([\s\S]*?)(?=\n\[|$)/)?.[1];
    const command=block?.match(/^\s*command\s*=\s*['"]([^'"\r\n]+)['"]/m)?.[1];
    const argsRaw=block?.match(/^\s*args\s*=\s*(\[[^\r\n]+\])/m)?.[1];
    const envBlock=config.match(/\[mcp_servers\.agentmem\.env\]([\s\S]*?)(?=\n\[|$)/)?.[1];
    if(!command || !argsRaw) throw new Error('No usable AgentMem stdio server is configured in Codex settings.');
    this.command=command; this.args=JSON.parse(argsRaw.replace(/'/g,'"')) as string[];
    const dataDir=envBlock?.match(/^\s*AGENTMEM_DATA_DIR\s*=\s*['"]([^'"\r\n]+)['"]/m)?.[1];
    if(dataDir) this.env.AGENTMEM_DATA_DIR=dataDir;
  }
  async connect(projectId:string,expectedRoot:string) {
    try {
      const projects=await this.listProjects();
      const project=projects.find(x=>x.id===projectId);
      if(!project) throw new Error(`AgentMem project "${projectId}" is not registered.`);
      const root=project.sourceRoot;
      if(!root) throw new Error('AgentMem did not return a registered source root, so project identity cannot be verified.');
      if(path.resolve(root).toLowerCase()!==path.resolve(expectedRoot).toLowerCase()) throw new Error('AgentMem project root does not match the selected project root.');
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
    const transport=new StdioClientTransport({command:this.command!,args:this.args,env:{...process.env,...this.env} as Record<string,string>,stderr:'ignore'});
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
    if(['projects','attach_project','requirements','lessons','retrieve_evidence','task_context'].includes(name))return true;
    if(name==='tasks'&&['show','list'].includes(String(args.action||'')))return true;
    if(name==='record_work'&&args.action==='receipt'&&typeof args.idempotency_key==='string'&&!!args.idempotency_key)return true;
    if(name==='record_work'&&args.action==='release'&&typeof args.lease_token==='string'&&!!args.lease_token&&typeof args.task_id==='string'&&!!args.task_id)return true;
    return false;
  }
  async listProjects():Promise<AgentMemProject[]> {
    const result:any=await this.call('projects',{action:'list'});
    const rows=Array.isArray(result)?result:result?.projects||result?.items||result?.data?.projects;
    if(!Array.isArray(rows))throw new Error('AgentMem project list did not contain a projects array.');
    return rows.flatMap((row:any)=>{
      if(!row||typeof row.id!=='string'||!row.id.trim())return [];
      const sourceRoot=row.source_root||row.root||row.cwd;
      const memoryRoot=row.memory_root||row.memoryRoot;
      if(typeof sourceRoot!=='string'||!sourceRoot.trim()||typeof memoryRoot!=='string'||!memoryRoot.trim()||path.basename(path.dirname(memoryRoot)).toLowerCase()!=='projects')return [];
      return [{id:row.id,name:typeof row.name==='string'&&row.name.trim()?row.name:row.id,...(typeof row.description==='string'&&row.description?{description:row.description}:{}),sourceRoot,memoryDirectory:path.basename(memoryRoot)}];
    }).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id.localeCompare(b.id));
  }
  private async call(name:string,args:Record<string,unknown>) {
    for(let attempt=0;attempt<2;attempt++){
      let client:Client|undefined;
      try{
        await this.ensureConnected();client=this.client;
        if(!client)throw new Error('AgentMem is not connected.');
        const result:any=await client.callTool({name,arguments:args});
        if(result.isError) throw new Error(result.content?.map((x:any)=>x.text||'').join('\n')||`AgentMem ${name} failed`);
        const text=result.content?.find((x:any)=>x.type==='text')?.text;
        if(text) {try{return JSON.parse(text)}catch{}}
        return result.structuredContent||result;
      }catch(error){
        if(!isTransportFailure(error)||attempt>0)throw error;
        if(client)this.invalidateConnection(client,this.transport);
        if(!this.canReplay(name,args))throw error;
      }
    }
    throw new Error(`AgentMem ${name} failed after reconnecting.`);
  }
  async context(projectId:string,query:string) {
    const [attached,requirements,lessons,evidence]=await Promise.all([
      this.call('attach_project',{project_id:projectId,query,max_chars:4500,include_sources:true}),
      this.call('requirements',{action:'list',project_id:projectId}),
      this.call('lessons',{action:'retrieve',project_id:projectId,query}),
      this.call('retrieve_evidence',{project_id:projectId,query,limit:8}),
    ]);
    return {attached,requirements,lessons,evidence};
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
