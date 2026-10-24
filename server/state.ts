import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalPolicy, Assignment, Receipt } from './contracts.js';
import type { WorkerContextStatus, WorkerStage } from './worker-staging.js';
import type { TaskAttachment } from './attachments.js';
import { stateDirectory } from './paths.js';

export type TaskPhase = 'intake' | 'routing' | 'direct_running' | 'simple_running' | 'planning' | 'worker_running' | 'escalated' | 'reviewing' | 'accepted' | 'needs_attention' | 'cancelled' | 'paused_after_restart';
export type WorkflowRole='router'|'direct'|'simple'|'orchestrator'|'worker';
export type Message = { id: string; role: 'user'|'router'|'direct'|'simple'|'orchestrator'|'worker'|'system'; text: string; createdAt: string; passId?:string; attachments?:TaskAttachment[] };
export type ActivityRole='direct'|'simple'|'orchestrator'|'worker';
export type ReasoningSummary = { role:ActivityRole; threadId:string; turnId:string; itemId:string; summaryIndex:number; text:string; passId?:string; requestedModel?:string; requestedEffort?:string; effectiveModel?:string; updatedAt?:string };
export type LiveActivity = { role:ActivityRole; threadId:string; turnId:string; itemId:string; kind:'commentary'|'tool'; itemType:string; title:string; text?:string; detail?:string; output?:string; status:'running'|'completed'|'failed'|'interrupted'; startedAt:string; updatedAt:string; passId?:string };
export type ReasoningTurn = { role:ActivityRole; threadId:string; turnId:string; requestedModel:string; requestedEffort:string; effectiveModel?:string; startedAt?:string; status:'streaming'|'completed'|'interrupted'|'failed' };
export type PassTokenUsage = { totalTokens:number; inputTokens:number; cachedInputTokens:number|null; cacheWriteInputTokens:number|null; outputTokens:number; reasoningOutputTokens:number|null; modelContextWindow:number|null; source:'thread'|'thread-estimate' };
export type PassUsageGroup = { model:string|null; reasoningEffort:string|null; speed:string|null; estimatedCreditsMicros:string; netNewInputTokens:string|null; cachedInputTokens:string|null; inputTokens:string|null; outputTokens:string|null; totalTokens:string|null };
export type PassAllowanceWindow = { sampleCount:number; firstSampledAt:string; lastSampledAt:string; windowDurationMins:number; resetsAt:number; boundariesChanged:boolean };
export type PassAllowanceUsage = { fiveHourPercent:number|null; weeklyPercent:number|null; fiveHourWindow?:PassAllowanceWindow; weeklyWindow?:PassAllowanceWindow };
export type PassRoleUsage = { threadId:string; tokenStatus:'pending'|'available'|'unavailable'; tokens?:PassTokenUsage; creditStatus:'pending'|'available'|'unavailable'; estimateSource?:'codex-app-server-thread-usage'; estimatedCreditsMicros?:string; estimatedUsdMicros?:string|null; allowance?:PassAllowanceUsage; groups?:PassUsageGroup[]; updatedAt?:string };
export type PassUsage = Partial<Record<WorkflowRole,PassRoleUsage>>;
export type PassGitDiffTurn={threadId:string;turnId:string;role:'simple'|'orchestrator'|'worker';diff:string;capturedAt:string;truncated?:boolean};
export type PassGitDiff={status:'recorded'|'partial';source:'codex-turn-diff';updatedAt:string;turns:PassGitDiffTurn[]};
export type ApprovalRequest = { requestId: string|number; method: 'item/commandExecution/requestApproval'|'item/fileChange/requestApproval'; itemId:string; threadId:string; turnId:string; reason?:string; command?:string; cwd?:string; grantRoot?:string; availableDecisions?:string[]; kind?:string; networkHost?:string; networkProtocol?:string };
export type RouteDecision={route:'direct_answer'|'simple_implementation'|'hard_task';effectiveRoute?:'direct_answer'|'simple_implementation'|'hard_task';rule_id:string;justification:string;model:string;effort:string;speed:string;decidedAt:string;fallback?:boolean};
export type ExecutionEscalation={from:'direct_answer'|'simple_implementation';to:'simple_implementation'|'hard_task';reason:string;completedActions:string[];evidence:string[]};
export type TaskPass = { id:string; index:number; createdAt:string; userInput:string; userInputs:string[]; userMessageIds:string[]; attachments?:TaskAttachment[]; phase:TaskPhase; approvalPolicy?:ApprovalPolicy; agentContextVersion?:number; legacyUnassociated?:boolean; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; publicAnswer?:string; assignment?:Assignment; receipt?:Receipt; reviewNote?:string; resolution?:'direct'|'simple'|'delegated'; routingNote?:string; error?:string; escalation?:unknown; workerStage?:WorkerStage; workerContextStatus?:WorkerContextStatus; workerContextSummary?:string; reasoningSummaries?:ReasoningSummary[]; reasoningTurns?:ReasoningTurn[]; liveActivity?:LiveActivity[]; usage?:PassUsage; gitDiff?:PassGitDiff; correctionCount:number; routerThreadId?:string; directThreadId?:string; simpleThreadId?:string; orchestratorThreadId?:string; workerThreadId?:string; activeTurnId?:string; activeRole?:WorkflowRole; processedTurns:string[]; agentmemTaskId?:string; agentmemLease?:string; agentmemRecordStatus?:string; agentmemRecordError?:string; agentmemReceiptId?:string }
export type GitHubTaskLink={repository:string;branch:string;baseBranch?:string;pullRequestUrl?:string;updatedAt:string};
export type Task = { githubLink?:GitHubTaskLink; workspaceCommand?:{id:string;mode:'browser'|'github';placement:'side'|'full';url?:string;createdAt:string}; id: string; title: string; phase: TaskPhase; createdAt: string; updatedAt: string; userRoot: string; agentmemProjectId: string; userMessages: string[]; messages: Message[]; passes?:TaskPass[]; currentPassId?:string; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; assignment?: Assignment; receipt?: Receipt; reviewNote?: string; resolution?:'direct'|'simple'|'delegated'; allowDirectResponse?:boolean;routingNote?:string;workerStage?:WorkerStage;workerContextStatus?:WorkerContextStatus;workerContextSummary?:string;reasoningSummaries?:ReasoningSummary[];reasoningTurns?:ReasoningTurn[];liveActivity?:LiveActivity[];activeModelId?:string;activeEffort?:string;correctionCount:number;routerThreadId?:string;directThreadId?:string;simpleThreadId?:string;orchestratorThreadId?:string;workerThreadId?:string;activeTurnId?:string;activeRole?:WorkflowRole;processedTurns:string[];error?:string;escalation?:unknown;approvalRequests?:ApprovalRequest[];agentmemTaskId?:string;agentmemLease?:string;agentmemRecordStatus?:string;agentmemRecordError?:string;agentmemReceiptId?:string;pendingRevision?:boolean };
export type Settings = { projectRoot: string; agentmemProjectId: string; orchestratorModel: string; orchestratorEffort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'; approvalPolicy: ApprovalPolicy };
export type State = { version: 2; settings: Settings; tasks: Task[]; activeTaskId: string|null; };
const dataDir = stateDirectory();
const statePath = path.join(dataDir, 'state.json');
const defaults: State = { version: 2, settings: { projectRoot: '', agentmemProjectId: '', orchestratorModel: 'gpt-6-sol', orchestratorEffort: 'high', approvalPolicy: 'on-request' }, tasks: [], activeTaskId: null };
let current = structuredClone(defaults);
let loaded = false;
let writeQueue = Promise.resolve();
const listeners = new Set<(state: State) => void>();
const approvalPolicies:ApprovalPolicy[]=['on-request','untrusted','never','full-access'];
const savedApprovalPolicy=(value:unknown):ApprovalPolicy=>approvalPolicies.includes(value as ApprovalPolicy)?value as ApprovalPolicy:'on-request';

export async function loadState(): Promise<State> {
  if (loaded) return current;
  await mkdir(dataDir, { recursive: true });
  let value:any;
  try { value=JSON.parse(await readFile(statePath, 'utf8')); } catch { /* A missing or malformed first-run file starts with clean state. */ }
  if ((value?.version === 1 || value?.version === 2) && Array.isArray(value.tasks)) {
    const containedRawReasoning=value.tasks.some((task:any)=>Array.isArray(task.reasoningRawContent)&&task.reasoningRawContent.length>0||Array.isArray(task.passes)&&task.passes.some((pass:any)=>Array.isArray(pass.reasoningRawContent)&&pass.reasoningRawContent.length>0));
    current = upgradeStoredState(value);
    if(containedRawReasoning){const tmp=`${statePath}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(current,null,2),{mode:0o600});await rename(tmp,statePath);}
  }
  loaded = true;
  return structuredClone(current);
}
export function upgradeStoredState(value:any):State{
  const tasks=(value.tasks||[]).map((t:any)=>{
    const task={...t,agentmemProjectId:typeof t.agentmemProjectId==='string'?t.agentmemProjectId:(value.settings?.agentmemProjectId||defaults.settings.agentmemProjectId)} as Task;
    if(!Array.isArray(task.passes)||task.passes.length===0){
      task.passes=[{id:randomUUID(),index:1,createdAt:task.createdAt,userInput:task.userMessages?.[0]||task.title,userInputs:[...(task.userMessages||[])],userMessageIds:[],phase:task.phase,approvalPolicy:savedApprovalPolicy(value.settings?.approvalPolicy),legacyUnassociated:true,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,reasoningSummaries:task.reasoningSummaries,reasoningTurns:task.reasoningTurns,liveActivity:task.liveActivity,correctionCount:task.correctionCount||0,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,processedTurns:[...(task.processedTurns||[])],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId}];
      task.currentPassId=undefined;
    }
    for(const pass of task.passes){pass.approvalPolicy=savedApprovalPolicy(pass.approvalPolicy??value.settings?.approvalPolicy);if(pass.agentContextVersion!==1)pass.agentContextVersion=0;}
    const current=task.passes.find(pass=>pass.id===task.currentPassId);
    if(['routing','direct_running','simple_running','planning','worker_running','reviewing'].includes(t.phase)){
      task.phase='paused_after_restart';task.activeRole=undefined;task.activeTurnId=undefined;task.approvalRequests=[];
      task.error=current?.agentContextVersion===1?'The process restarted during this turn. Resume explicitly after checking the isolated agent thread.':'This session used a pre-isolation Codex thread and cannot be resumed with the isolated runtime. Send a follow-up to start a fresh isolated pass.';
      for(const turn of task.reasoningTurns||[])if(turn.status==='streaming')turn.status='interrupted';
      const interruptedAt=new Date().toISOString();for(const activity of task.liveActivity||[])if(activity.status==='running'){activity.status='interrupted';activity.updatedAt=interruptedAt;}
    }
    delete (task as any).reasoningRawContent;
    for(const pass of task.passes||[])delete (pass as any).reasoningRawContent;
    syncCurrentPass(task);
    return task;
  });
  return {...defaults,...value,version:2,settings:{...defaults.settings,...value.settings,approvalPolicy:savedApprovalPolicy(value.settings?.approvalPolicy)},tasks};
}
export function getState() { return structuredClone(current); }
export function getTask(id: string) { return current.tasks.find(t => t.id === id); }
export function taskDeletionBlockReason(task:Task){
  if(['intake','routing','direct_running','simple_running','planning','worker_running','reviewing','escalated'].includes(task.phase)||task.activeTurnId||task.activeRole)return 'Stop or finish the active turn before deleting this session.';
  const records=[task,...(task.passes||[])];
  if(records.some(x=>x.agentmemRecordStatus==='saving'||!!x.agentmemLease))return 'Wait for AgentMem receipt completion before deleting this session.';
  return null;
}
export function renameTaskInState(state:State,id:string,title:string){
  const task=state.tasks.find(x=>x.id===id);if(!task)throw new Error('Session not found.');
  task.title=title;task.updatedAt=new Date().toISOString();return task;
}
export function deleteTaskInState(state:State,id:string){
  const task=state.tasks.find(x=>x.id===id);if(!task)throw new Error('Session not found.');
  const blocked=taskDeletionBlockReason(task);if(blocked)throw new Error(blocked);
  state.tasks=state.tasks.filter(x=>x.id!==id);if(state.activeTaskId===id)state.activeTaskId=null;return task;
}
export function subscribe(fn: (s: State) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export async function mutate(fn: (state: State) => void) {
  await loadState(); fn(current); current.version=2; current.tasks.forEach(syncCurrentPass); current.tasks.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  writeQueue = writeQueue.then(async () => { await mkdir(dataDir,{recursive:true}); const tmp = `${statePath}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(current,null,2), { mode: 0o600 }); await rename(tmp,statePath); });
  await writeQueue; for(const listener of listeners) listener(getState()); return getState();
}
export async function createTask(message: string, root: string, agentmemProjectId: string, approvalPolicy:ApprovalPolicy='on-request',attachments:TaskAttachment[]=[] ) {
  const now = new Date().toISOString(); const id = randomUUID();
  const task: Task = { id, title: message.slice(0, 72)||attachments[0]?.name||'Image task', phase: 'intake', createdAt: now, updatedAt: now, userRoot: root, agentmemProjectId, userMessages: [message], correctionCount: 0, processedTurns: [], messages: [{id:randomUUID(),role:'user',text:message,createdAt:now,attachments}] };
  beginPass(task,message,task.messages[0].id,approvalPolicy,attachments);
  await mutate(s => { s.tasks.unshift(task); s.activeTaskId=id; }); return task;
}
export function beginPass(task:Task,message:string,userMessageId?:string,approvalPolicy:ApprovalPolicy='on-request',attachments:TaskAttachment[]=[]){
  const now=new Date().toISOString();const pass:TaskPass={id:randomUUID(),index:(task.passes?.reduce((n,p)=>Math.max(n,p.index),0)||0)+1,createdAt:now,userInput:message,userInputs:[message],userMessageIds:userMessageId?[userMessageId]:[],attachments,phase:'intake',approvalPolicy,agentContextVersion:1,correctionCount:0,processedTurns:[]};
  task.passes=[...(task.passes||[]),pass];task.currentPassId=pass.id;
  task.phase='intake';task.routeDecision=undefined;task.executionEscalation=undefined;task.assignment=undefined;task.receipt=undefined;task.reviewNote=undefined;task.resolution=undefined;task.routingNote=undefined;task.workerStage=undefined;task.workerContextStatus=undefined;task.workerContextSummary=undefined;task.reasoningSummaries=[];task.reasoningTurns=[];task.liveActivity=[];task.activeModelId=undefined;task.activeEffort=undefined;task.correctionCount=0;task.routerThreadId=undefined;task.directThreadId=undefined;task.simpleThreadId=undefined;task.orchestratorThreadId=undefined;task.workerThreadId=undefined;task.activeTurnId=undefined;task.activeRole=undefined;task.processedTurns=[];task.error=undefined;task.escalation=undefined;task.approvalRequests=[];task.agentmemTaskId=undefined;task.agentmemLease=undefined;task.agentmemRecordStatus=undefined;task.agentmemRecordError=undefined;task.agentmemReceiptId=undefined;task.pendingRevision=false;
  if(userMessageId){const msg=task.messages.find(m=>m.id===userMessageId);if(msg)msg.passId=pass.id;}
  return pass;
}
export function currentPass(task:Task){return task.passes?.find(p=>p.id===task.currentPassId);}
export function passForThread(task:Task,threadId:string){return task.passes?.find(p=>[p.routerThreadId,p.directThreadId,p.simpleThreadId,p.orchestratorThreadId,p.workerThreadId].includes(threadId));}
export function isCurrentPassThread(task:Task,threadId:string){const pass=currentPass(task);return !!pass&&[pass.routerThreadId,pass.directThreadId,pass.simpleThreadId,pass.orchestratorThreadId,pass.workerThreadId].includes(threadId);}
export function syncCurrentPass(task:Task){
  const p=currentPass(task);if(!p)return;
  Object.assign(p,{phase:task.phase,routeDecision:task.routeDecision,executionEscalation:task.executionEscalation,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,workerStage:task.workerStage,workerContextStatus:task.workerContextStatus,workerContextSummary:task.workerContextSummary,reasoningSummaries:structuredClone(task.reasoningSummaries||[]),reasoningTurns:structuredClone(task.reasoningTurns||[]),liveActivity:structuredClone(task.liveActivity||[]),correctionCount:task.correctionCount,routerThreadId:task.routerThreadId,directThreadId:task.directThreadId,simpleThreadId:task.simpleThreadId,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,activeTurnId:task.activeTurnId,activeRole:task.activeRole,processedTurns:[...task.processedTurns],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId});
}
export function addMessage(task: Task, role: Message['role'], text: string, attachments?:TaskAttachment[]) { const message:Message={id:randomUUID(),role,text,createdAt:new Date().toISOString(),...(task.currentPassId?{passId:task.currentPassId}:{}),...(attachments?.length?{attachments:structuredClone(attachments)}:{})};task.messages.push(message);task.updatedAt = new Date().toISOString();return message; }
