import { describe, expect, it } from 'vitest';
import { deleteTaskInState, renameTaskInState, taskDeletionBlockReason, type State, type Task } from '../server/state.js';
import { sessionTitleSchema } from '../server/contracts.js';

const task=(patch:Partial<Task>={}):Task=>({id:'session-a',title:'Original title',phase:'accepted',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',userRoot:'D:/workspace/demo',userMessages:['hello'],messages:[{id:'m1',role:'user',text:'hello',createdAt:'2026-10-20T00:00:00.000Z'}],correctionCount:0,processedTurns:[],...patch});
const state=(items:Task[],activeTaskId:string|null):State=>({version:5,revision:0,settings:{orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:items,activeTaskId,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']});

describe('local session lifecycle',()=>{
  it('validates trimmed non-empty titles with a bounded length',()=>{
    expect(sessionTitleSchema.parse({title:'  A useful title  '})).toEqual({title:'A useful title'});
    expect(()=>sessionTitleSchema.parse({title:'   '})).toThrow();
    expect(()=>sessionTitleSchema.parse({title:'x'.repeat(121)})).toThrow();
  });
  it('renames in place without changing messages, pass history, or identifiers',()=>{
    const original=task({passes:[{id:'pass-a',index:1,createdAt:'2026-10-20T00:00:00.000Z',userInput:'hello',userInputs:['hello'],userMessageIds:['m1'],phase:'accepted',correctionCount:0,processedTurns:[]}],currentPassId:'pass-a'});const s=state([original],'session-a');const changed=renameTaskInState(s,'session-a','New name');
    expect(changed.id).toBe('session-a');expect(changed.title).toBe('New name');expect(changed.messages).toBe(original.messages);expect(changed.passes).toBe(original.passes);expect(s.activeTaskId).toBe('session-a');
  });
  it('deletes only app-local accepted sessions and clears active selection',()=>{
    const a=task();const b=task({id:'session-b',title:'Keep me'});const s=state([a,b],'session-a');expect(deleteTaskInState(s,'session-a').id).toBe('session-a');expect(s.tasks.map(x=>x.id)).toEqual(['session-b']);expect(s.activeTaskId).toBeNull();expect(taskDeletionBlockReason(b)).toBeNull();
  });
  it('rejects deletion while an execution turn is active',()=>{
    const blocked=task({phase:'worker_running',activeRole:'worker',activeTurnId:'turn-a'});
    const s=state([blocked],blocked.id);expect(taskDeletionBlockReason(blocked)).toBeTruthy();expect(()=>deleteTaskInState(s,blocked.id)).toThrow();expect(s.tasks).toHaveLength(1);expect(s.activeTaskId).toBe(blocked.id);
  });
  it('does not wait for legacy AgentMem receipt state before deleting local history',()=>{
    const legacy=task({legacyAgentMem:{recordStatus:'saving'},passes:[{id:'pass-a',index:1,createdAt:'2026-10-20T00:00:00.000Z',userInput:'hello',userInputs:['hello'],userMessageIds:[],phase:'accepted',correctionCount:0,processedTurns:[],legacyAgentMem:{lease:'lease-held'}}]});
    const s=state([legacy],legacy.id);expect(taskDeletionBlockReason(legacy)).toBeNull();expect(deleteTaskInState(s,legacy.id).id).toBe(legacy.id);expect(s.tasks).toHaveLength(0);
  });
  it('reports a missing session instead of mutating another record',()=>{
    const keep=task({id:'keep'});const s=state([keep],null);expect(()=>renameTaskInState(s,'missing','x')).toThrow('Session not found.');expect(()=>deleteTaskInState(s,'missing')).toThrow('Session not found.');expect(s.tasks).toHaveLength(1);
  });
});
