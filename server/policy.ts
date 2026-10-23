import type { Task } from './state.js';
import type { Receipt } from './contracts.js';
import type { Assignment } from './contracts.js';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

export type OrchestratorWake = 'explicit_user_input'|'explicit_worker_escalation'|'final_worker_receipt';
const completions = new Set<string>();
export function shouldWakeOrchestrator(reason:OrchestratorWake){return reason==='explicit_user_input'||reason==='explicit_worker_escalation'||reason==='final_worker_receipt';}
export function claimCompletion(taskId:string,turnId:string,persisted:string[]){const key=`${taskId}:${turnId}`;if(persisted.includes(turnId)||completions.has(key))return false;completions.add(key);return true;}
export function clearCompletionClaimsForTests(){completions.clear();}
export function correctionWorker(task:Pick<Task,'workerThreadId'|'correctionCount'>,receipt:Receipt){
  if(task.correctionCount>=1)throw new Error('Correction limit reached.');
  if(!task.workerThreadId)throw new Error('Correction requires the original worker thread.');
  if(receipt.status!=='complete')throw new Error('Non-complete receipts cannot be auto-corrected.');
  return task.workerThreadId;
}
export function isCancelled(task:Pick<Task,'phase'>){return task.phase==='cancelled';}
/** AgentMem owns lease truth; a persisted app token may be stale after a service-side release. */
export function canRetryAcceptedAgentMemPass(pass:{phase?:string;agentmemTaskId?:string;agentmemLease?:string}):pass is {phase:'accepted';agentmemTaskId:string;agentmemLease?:string}{
  return pass.phase==='accepted'&&!!pass.agentmemTaskId;
}
export function completionDisposition(task:Pick<Task,'phase'|'pendingRevision'>,role:'orchestrator'|'worker',status:string){
  if(isCancelled(task))return 'ignore' as const;
  if(status==='interrupted'&&task.pendingRevision)return 'revise' as const;
  if(status==='interrupted'||status==='failed')return 'attention' as const;
  return 'continue' as const;
}
export function consolidatedUserRequest(messages:string[],assignment?:Assignment){
  const [original,...updates]=messages;
  if(!assignment)return `Original user request:\n${original||''}\n\nSubsequent user updates:\n${updates.join('\n\n')}`;
  return `Original user request:\n${original||''}\n\nPrior complete assignment:\n${JSON.stringify(assignment)}\n\nUser updates:\n${updates.join('\n\n')}`;
}
export function assignmentWriteRoots(assignment:Pick<Assignment,'write_scope'>,projectRoot:string){
  const entries=assignment.write_scope.map(x=>x.trim());
  const none=/^(none|no filesystem writes(?: authorized)?|read.only|no writes authorized)$/i;
  if(entries.length===0)return [];
  if(entries.every(x=>none.test(x)))return [];
  const root=path.resolve(projectRoot);const result:string[]=[];
  for(const value of entries){
    if(none.test(value))throw new Error('Assignment mixes a no-write declaration with writable paths.');
    if(!path.isAbsolute(value))throw new Error(`Write scope must use absolute paths inside the selected project root: ${value}`);
    const candidate=path.resolve(value);const rel=path.relative(root,candidate);
    if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error(`Write scope escapes the selected project root: ${value}`);
    result.push(candidate);
  }
  return [...new Set(result)];
}

/**
 * A simple route is writable only when the human explicitly names one or more
 * existing project directories in inline code. File paths and prose are not
 * widened to their parent directory; callers must use the hard assignment flow
 * when a bounded directory scope cannot be established.
 */
export async function simpleRouteWriteRoots(userInputs:string[],projectRoot:string):Promise<string[]|undefined>{
  const references=userInputs.flatMap(input=>[...input.matchAll(/`([^`\r\n]+)`/g)].map(match=>match[1].trim()));
  const pathLike=references.filter(value=>/[\\/]/.test(value)||/^[A-Za-z]:/.test(value)||value.startsWith('.')||/\.[A-Za-z0-9]{1,8}$/.test(value));
  if(!pathLike.length)return undefined;

  try{
    const root=path.resolve(projectRoot),rootReal=await realpath(root);
    if(!(await stat(rootReal)).isDirectory())return undefined;
    const roots:string[]=[];
    for(const value of pathLike){
      const candidate=path.resolve(root,value);
      const relative=path.relative(root,candidate);
      if(relative===''||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return undefined;
      const resolved=await realpath(candidate);
      const resolvedRelative=path.relative(rootReal,resolved);
      if(resolvedRelative===''||resolvedRelative==='..'||resolvedRelative.startsWith(`..${path.sep}`)||path.isAbsolute(resolvedRelative))return undefined;
      if(!(await stat(resolved)).isDirectory())return undefined;
      roots.push(resolved);
    }
    return assignmentWriteRoots({write_scope:roots},root);
  }catch{return undefined;}
}
