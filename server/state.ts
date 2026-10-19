import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ApprovalPolicy, Assignment, Receipt } from './contracts.js';

export type TaskPhase = 'intake' | 'planning' | 'worker_running' | 'escalated' | 'reviewing' | 'accepted' | 'needs_attention' | 'cancelled' | 'paused_after_restart';
export type Message = { id: string; role: 'user'|'orchestrator'|'worker'|'system'; text: string; createdAt: string };
export type ApprovalRequest = { requestId: string|number; method: 'item/commandExecution/requestApproval'|'item/fileChange/requestApproval'; itemId:string; threadId:string; turnId:string; reason?:string; command?:string; cwd?:string; grantRoot?:string; availableDecisions?:string[]; kind?:string; networkHost?:string; networkProtocol?:string };
export type Task = { id: string; title: string; phase: TaskPhase; createdAt: string; updatedAt: string; userRoot: string; agentmemProjectId: string; userMessages: string[]; messages: Message[]; assignment?: Assignment; receipt?: Receipt; reviewNote?: string; correctionCount: number; orchestratorThreadId?: string; workerThreadId?: string; activeTurnId?: string; activeRole?: 'orchestrator'|'worker'; processedTurns: string[]; error?: string; escalation?: unknown; approvalRequests?: ApprovalRequest[]; agentmemTaskId?: string; agentmemLease?: string; agentmemRecordStatus?: string; agentmemRecordError?: string; agentmemReceiptId?: string; pendingRevision?: boolean };
export type Settings = { projectRoot: string; agentmemProjectId: string; orchestratorModel: string; orchestratorEffort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'; approvalPolicy: ApprovalPolicy };
export type State = { version: 1; settings: Settings; tasks: Task[]; activeTaskId: string|null; };
const dataDir = process.env.PSEUDOHARNESS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Pseudoharness');
const statePath = path.join(dataDir, 'state.json');
const defaults: State = { version: 1, settings: { projectRoot: '', agentmemProjectId: '', orchestratorModel: 'gpt-6-sol', orchestratorEffort: 'high', approvalPolicy: 'on-request' }, tasks: [], activeTaskId: null };
let current = structuredClone(defaults);
let loaded = false;
let writeQueue = Promise.resolve();
const listeners = new Set<(state: State) => void>();

export async function loadState(): Promise<State> {
  if (loaded) return current;
  await mkdir(dataDir, { recursive: true });
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as State;
    if (value.version === 1 && Array.isArray(value.tasks)) current = { ...defaults, ...value, settings: {...defaults.settings,...value.settings}, tasks: value.tasks.map(t => ({...t, agentmemProjectId:t.agentmemProjectId||value.settings?.agentmemProjectId||defaults.settings.agentmemProjectId, ...(['planning','worker_running','reviewing'].includes(t.phase) ? { phase: 'paused_after_restart' as const, activeRole: undefined, activeTurnId: undefined, approvalRequests: [], error: 'The process restarted during this turn. Resume explicitly after checking Codex thread state.' } : {})})) };
  } catch { /* A missing or malformed first-run file starts with clean state. */ }
  loaded = true;
  return structuredClone(current);
}
export function getState() { return structuredClone(current); }
export function getTask(id: string) { return current.tasks.find(t => t.id === id); }
export function subscribe(fn: (s: State) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export async function mutate(fn: (state: State) => void) {
  await loadState(); fn(current); current.tasks.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  writeQueue = writeQueue.then(async () => { await mkdir(dataDir,{recursive:true}); const tmp = `${statePath}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(current,null,2), { mode: 0o600 }); await rename(tmp,statePath); });
  await writeQueue; for(const listener of listeners) listener(getState()); return getState();
}
export async function createTask(message: string, root: string, agentmemProjectId: string) {
  const now = new Date().toISOString(); const id = randomUUID();
  const task: Task = { id, title: message.slice(0, 72), phase: 'intake', createdAt: now, updatedAt: now, userRoot: root, agentmemProjectId, userMessages: [message], correctionCount: 0, processedTurns: [], messages: [{id:randomUUID(),role:'user',text:message,createdAt:now}] };
  await mutate(s => { s.tasks.unshift(task); s.activeTaskId=id; }); return task;
}
export function addMessage(task: Task, role: Message['role'], text: string) { task.messages.push({id:randomUUID(),role,text,createdAt:new Date().toISOString()}); task.updatedAt = new Date().toISOString(); }
