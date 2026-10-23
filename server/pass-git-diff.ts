import type { PassGitDiff, Task, TaskPass } from './state.js';

export const PASS_GIT_DIFF_MAX_TURNS=16;
export const PASS_GIT_DIFF_MAX_TURN_CHARS=96*1024;
export const PASS_GIT_DIFF_MAX_TOTAL_CHARS=384*1024;
const WRITING_ROLES=new Set(['simple','orchestrator','worker']);

/** Store Codex's latest cumulative diff for one trusted writing turn. */
export function applyPassGitDiffUpdate(task:Task,params:unknown,now=new Date().toISOString()):boolean{
  if(!params||typeof params!=='object')return false;
  const event=params as Record<string,unknown>;
  if(typeof event.threadId!=='string'||typeof event.turnId!=='string'||typeof event.diff!=='string')return false;
  const pass=task.passes?.find(candidate=>candidate.id===task.currentPassId);
  const role=task.activeRole;
  if(!pass||task.phase==='cancelled'||!WRITING_ROLES.has(role||'')||!task.activeTurnId||task.activeTurnId!==event.turnId)return false;
  const expectedThread=task[`${role}ThreadId` as 'simpleThreadId'|'orchestratorThreadId'|'workerThreadId'];
  if(!expectedThread||expectedThread!==event.threadId)return false;
  return replaceTurnDiff(pass,{threadId:event.threadId,turnId:event.turnId,role:role as 'simple'|'orchestrator'|'worker',diff:event.diff,capturedAt:now});
}

export function replaceTurnDiff(pass:TaskPass,turn:PassGitDiff['turns'][number]):boolean{
  let state=pass.gitDiff;
  if(!state)state=pass.gitDiff={status:'recorded',source:'codex-turn-diff',updatedAt:turn.capturedAt,turns:[]};
  if(state.status==='partial'&&state.turns.length>=PASS_GIT_DIFF_MAX_TURNS&&!state.turns.some(entry=>entry.turnId===turn.turnId))return false;
  const existing=state.turns.find(entry=>entry.turnId===turn.turnId&&entry.threadId===turn.threadId);
  if(!existing&&state.turns.length>=PASS_GIT_DIFF_MAX_TURNS){state.status='partial';state.updatedAt=turn.capturedAt;return false;}
  const chars=existing?state.turns.reduce((sum,entry)=>sum+entry.diff.length,0)-existing.diff.length:state.turns.reduce((sum,entry)=>sum+entry.diff.length,0);
  const allowed=Math.max(0,Math.min(PASS_GIT_DIFF_MAX_TURN_CHARS,PASS_GIT_DIFF_MAX_TOTAL_CHARS-chars));
  const clipped=turn.diff.length>allowed;
  const next={...turn,diff:turn.diff.slice(0,allowed),...(clipped?{truncated:true}:{})};
  if(existing){Object.assign(existing,next);if(!clipped)delete existing.truncated;}else state.turns.push(next);
  state.updatedAt=turn.capturedAt;
  if(clipped)state.status='partial';
  return true;
}

