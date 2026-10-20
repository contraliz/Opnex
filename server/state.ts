import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ApprovalPolicy, Assignment, Receipt } from './contracts.js';

export type TaskPhase = 'intake' | 'planning' | 'worker_running' | 'escalated' | 'reviewing' | 'accepted' | 'needs_attention' | 'cancelled' | 'paused_after_restart';
export type Message = { id: string; role: 'user'|'orchestrator'|'worker'|'system'; text: string; createdAt: string; passId?:string };
export type ReasoningSummary = { role:'orchestrator'|'worker'; threadId:string; turnId:string; itemId:string; summaryIndex:number; text:string; passId?:string; requestedModel?:string; requestedEffort?:string; effectiveModel?:string };
export type ReasoningTurn = { role:'orchestrator'|'worker'; threadId:string; turnId:string; requestedModel:string; requestedEffort:string; effectiveModel?:string; status:'streaming'|'completed'|'interrupted'|'failed' };
export type ApprovalRequest = { requestId: string|number; method: 'item/commandExecution/requestApproval'|'item/fileChange/requestApproval'; itemId:string; threadId:string; turnId:string; reason?:string; command?:string; cwd?:string; grantRoot?:string; availableDecisions?:string[]; kind?:string; networkHost?:string; networkProtocol?:string };
export type TaskPass = { id:string; index:number; createdAt:string; userInput:string; userInputs:string[]; userMessageIds:string[]; phase:TaskPhase; legacyUnassociated?:boolean; publicAnswer?:string; assignment?:Assignment; receipt?:Receipt; reviewNote?:string; resolution?:'direct'|'delegated'; routingNote?:string; error?:string; escalation?:unknown; reasoningSummaries?:ReasoningSummary[]; reasoningTurns?:ReasoningTurn[]; correctionCount:number; orchestratorThreadId?:string; workerThreadId?:string; activeTurnId?:string; activeRole?:'orchestrator'|'worker'; processedTurns:string[]; agentmemTaskId?:string; agentmemLease?:string; agentmemRecordStatus?:string; agentmemRecordError?:string; agentmemReceiptId?:string };
export type Task = { id: string; title: string; phase: TaskPhase; createdAt: string; updatedAt: string; userRoot: string; agentmemProjectId: string; userMessages: string[]; messages: Message[]; passes?:TaskPass[]; currentPassId?:string; assignment?: Assignment; receipt?: Receipt; reviewNote?: string; resolution?:'direct'|'delegated'; allowDirectResponse?:boolean; routingNote?:string; reasoningSummaries?:ReasoningSummary[]; reasoningTurns?:ReasoningTurn[]; activeModelId?:string; activeEffort?:string; correctionCount: number; orchestratorThreadId?: string; workerThreadId?: string; activeTurnId?: string; activeRole?:'orchestrator'|'worker'; processedTurns: string[]; error?: string; escalation?: unknown; approvalRequests?: ApprovalRequest[]; agentmemTaskId?: string; agentmemLease?: string; agentmemRecordStatus?: string; agentmemRecordError?: string; agentmemReceiptId?: string; pendingRevision?: boolean };
export type Settings = { projectRoot: string; agentmemProjectId: string; orchestratorModel: string; orchestratorEffort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'; approvalPolicy: ApprovalPolicy };
export type State = { version: 2; settings: Settings; tasks: Task[]; activeTaskId: string|null; };
const dataDir = process.env.PSEUDOHARNESS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Pseudoharness');
const statePath = path.join(dataDir, 'state.json');
const defaults: State = { version: 2, settings: { projectRoot: '', agentmemProjectId: '', orchestratorModel: 'gpt-6-sol', orchestratorEffort: 'high', approvalPolicy: 'on-request' }, tasks: [], activeTaskId: null };
let current = structuredClone(defaults);
let loaded = false;
let writeQueue = Promise.resolve();
const listeners = new Set<(state: State) => void>();

export async function loadState(): Promise<State> {
  if (loaded) return current;
  await mkdir(dataDir, { recursive: true });
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as any;
    if ((value.version === 1 || value.version === 2) && Array.isArray(value.tasks)) current = upgradeStoredState(value);
  } catch { /* A missing or malformed first-run file starts with clean state. */ }
  loaded = true;
  return structuredClone(current);
}
export function upgradeStoredState(value:any):State{
  const tasks=(value.tasks||[]).map((t:any)=>{
    const task={...t,agentmemProjectId:typeof t.agentmemProjectId==='string'?t.agentmemProjectId:(value.settings?.agentmemProjectId||defaults.settings.agentmemProjectId),...(['planning','worker_running','reviewing'].includes(t.phase)?{phase:'paused_after_restart' as const,activeRole:undefined,activeTurnId:undefined,approvalRequests:[],error:'The process restarted during this turn. Resume explicitly after checking Codex thread state.'}:{})} as Task;
    if(!Array.isArray(task.passes)||task.passes.length===0){
      task.passes=[{id:randomUUID(),index:1,createdAt:task.createdAt,userInput:task.userMessages?.[0]||task.title,userInputs:[...(task.userMessages||[])],userMessageIds:[],phase:task.phase,legacyUnassociated:true,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,reasoningSummaries:task.reasoningSummaries,reasoningTurns:task.reasoningTurns,correctionCount:task.correctionCount||0,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,processedTurns:[...(task.processedTurns||[])],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId}];
      task.currentPassId=undefined;
    }
    syncCurrentPass(task);
    return task;
  });
  return {...defaults,...value,version:2,settings:{...defaults.settings,...value.settings},tasks};
}
export function getState() { return structuredClone(current); }
export function getTask(id: string) { return current.tasks.find(t => t.id === id); }
export function subscribe(fn: (s: State) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export async function mutate(fn: (state: State) => void) {
  await loadState(); fn(current); current.version=2; current.tasks.forEach(syncCurrentPass); current.tasks.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  writeQueue = writeQueue.then(async () => { await mkdir(dataDir,{recursive:true}); const tmp = `${statePath}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(current,null,2), { mode: 0o600 }); await rename(tmp,statePath); });
  await writeQueue; for(const listener of listeners) listener(getState()); return getState();
}
export async function createTask(message: string, root: string, agentmemProjectId: string) {
  const now = new Date().toISOString(); const id = randomUUID();
  const task: Task = { id, title: message.slice(0, 72), phase: 'intake', createdAt: now, updatedAt: now, userRoot: root, agentmemProjectId, userMessages: [message], correctionCount: 0, processedTurns: [], messages: [{id:randomUUID(),role:'user',text:message,createdAt:now}] };
  beginPass(task,message,task.messages[0].id);
  await mutate(s => { s.tasks.unshift(task); s.activeTaskId=id; }); return task;
}
export function beginPass(task:Task,message:string,userMessageId?:string){
  const now=new Date().toISOString();const pass:TaskPass={id:randomUUID(),index:(task.passes?.reduce((n,p)=>Math.max(n,p.index),0)||0)+1,createdAt:now,userInput:message,userInputs:[message],userMessageIds:userMessageId?[userMessageId]:[],phase:'intake',correctionCount:0,processedTurns:[]};
  task.passes=[...(task.passes||[]),pass];task.currentPassId=pass.id;
  task.phase='intake';task.assignment=undefined;task.receipt=undefined;task.reviewNote=undefined;task.resolution=undefined;task.routingNote=undefined;task.reasoningSummaries=[];task.reasoningTurns=[];task.activeModelId=undefined;task.activeEffort=undefined;task.correctionCount=0;task.orchestratorThreadId=undefined;task.workerThreadId=undefined;task.activeTurnId=undefined;task.activeRole=undefined;task.processedTurns=[];task.error=undefined;task.escalation=undefined;task.approvalRequests=[];task.agentmemTaskId=undefined;task.agentmemLease=undefined;task.agentmemRecordStatus=undefined;task.agentmemRecordError=undefined;task.agentmemReceiptId=undefined;task.pendingRevision=false;
  if(userMessageId){const msg=task.messages.find(m=>m.id===userMessageId);if(msg)msg.passId=pass.id;}
  return pass;
}
export function currentPass(task:Task){return task.passes?.find(p=>p.id===task.currentPassId);}
export function passForThread(task:Task,threadId:string){return task.passes?.find(p=>p.orchestratorThreadId===threadId||p.workerThreadId===threadId);}
export function isCurrentPassThread(task:Task,threadId:string){const pass=currentPass(task);return !!pass&&(pass.orchestratorThreadId===threadId||pass.workerThreadId===threadId);}
export function syncCurrentPass(task:Task){
  const p=currentPass(task);if(!p)return;
  Object.assign(p,{phase:task.phase,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,reasoningSummaries:structuredClone(task.reasoningSummaries||[]),reasoningTurns:structuredClone(task.reasoningTurns||[]),correctionCount:task.correctionCount,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,activeTurnId:task.activeTurnId,activeRole:task.activeRole,processedTurns:[...task.processedTurns],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId});
}
export function addMessage(task: Task, role: Message['role'], text: string) { const message:Message={id:randomUUID(),role,text,createdAt:new Date().toISOString(),...(task.currentPassId?{passId:task.currentPassId}:{})};task.messages.push(message);task.updatedAt = new Date().toISOString();return message; }
