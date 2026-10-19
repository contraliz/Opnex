import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Receipt } from './contracts.js';
import os from 'node:os';

type Status = { connected:boolean; projectVerified:boolean; detail:string };
export class AgentMem {
  private client?:Client; private transport?:StdioClientTransport;
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
      if(!this.client) {
        await this.configure();
        this.client=new Client({name:'pseudoharness',version:'0.1.0'});
        this.transport=new StdioClientTransport({command:this.command!,args:this.args,env:{...process.env,...this.env} as Record<string,string>,stderr:'ignore'});
        await this.client.connect(this.transport);
      }
      const r:any=await this.call('projects',{action:'list'});
      const rows=r.projects||r.items||[];
      const project=rows.find((x:any)=>x.id===projectId);
      if(!project) throw new Error(`AgentMem project "${projectId}" is not registered.`);
      const root=project.source_root||project.root||project.cwd;
      if(!root) throw new Error('AgentMem did not return a registered source root, so project identity cannot be verified.');
      if(path.resolve(root).toLowerCase()!==path.resolve(expectedRoot).toLowerCase()) throw new Error('AgentMem project root does not match the selected project root.');
      this.status={connected:true,projectVerified:true,detail:`Connected · ${projectId}`}; return r;
    } catch(e) {this.status={connected:!!this.client,projectVerified:false,detail:safeError(e)};throw e;}
  }
  private async call(name:string,args:Record<string,unknown>) {
    if(!this.client) throw new Error('AgentMem is not connected.');
    const result:any=await this.client.callTool({name,arguments:args});
    if(result.isError) throw new Error(result.content?.map((x:any)=>x.text||'').join('\n')||`AgentMem ${name} failed`);
    const text=result.content?.find((x:any)=>x.type==='text')?.text;
    if(text) {try{return JSON.parse(text)}catch{}}
    return result.structuredContent||result;
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
  async recordReceipt(projectId:string,taskId:string,lease:string,receipt:unknown) {
    const appReceipt=receipt as Receipt & Record<string,unknown>;
    const context=await this.call('task_context',{project_id:projectId,task_id:taskId,max_chars:12000,requirements_limit:12});
    const payload=toAgentMemReceipt(appReceipt,context);
    const saved=await this.call('record_work',{action:'receipt',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local',idempotency_key:`pseudoharness-${taskId}-receipt-v1`,receipt:payload});
    if(saved.status!=='done') {
      if(appReceipt.status==='blocked'&&!saved.duplicate)await this.call('record_work',{action:'block',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local',blocked_reason:appReceipt.result.slice(0,4000)});
      await this.call('record_work',{action:'release',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local'});
      return {...saved,ownership_released:true,...(payload.status==='done'?{completion_accepted:false,actionable_error:saved.note||'AgentMem did not accept completion; the saved task was released for follow-up.'}:{})};
    }
    return saved;
  }
  async releaseWork(projectId:string,taskId:string,lease:string){
    return this.call('record_work',{action:'release',project_id:projectId,task_id:taskId,lease_token:lease,owner:'pseudoharness-local'});
  }
  close(){ void this.transport?.close();this.client=undefined;this.transport=undefined;this.status={connected:false,projectVerified:false,detail:'Disconnected'}; }
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
export function agentMemRecordState(saved:any,appStatus:string){
  return {status:saved.status,receiptId:saved.receipt_id,ownershipReleased:saved.status==='done'||saved.ownership_released===true,error:saved.actionable_error||((appStatus==='complete'&&saved.status!=='done')?saved.note||'AgentMem did not accept task completion. Review the saved receipt and task checks.':undefined)};
}
export function agentMemRecordFailure(error:unknown){return {status:'failed',error:`AgentMem receipt save/completion failed: ${safeError(error)}`};}
