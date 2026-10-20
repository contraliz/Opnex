import { describe, expect, it } from 'vitest';
import { beginPass, currentPass, isCurrentPassThread, syncCurrentPass, upgradeStoredState, type Message, type Task } from '../server/state.js';
import { buildPriorConversationContext, formatCurrentPassConversation } from '../server/pass-context.js';

const assignment={outcome:'First change',deliverable:'first',read_scope:[],write_scope:[],exclusions:[],constraints:[],context_refs:[],acceptance:['done'],verification:['check'],ordinary_authority:['normal choices'],escalation_conditions:['blocked'],receipt_requirements:['receipt']};
const receipt={status:'complete' as const,result:'First result',changes:[],acceptance:{met:['done'],unmet:[]},verification:[],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null};
function taskFixture():Task{return {id:'task',title:'First prompt',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z',userRoot:'D:/workspace',agentmemProjectId:'demo',userMessages:['First prompt'],messages:[],passes:[{id:'pass-1',index:1,createdAt:'2026-10-19T00:00:00Z',userInput:'First prompt',userInputs:['First prompt'],userMessageIds:[],phase:'accepted',assignment,receipt,reviewNote:'Reviewed first pass',resolution:'delegated',workerThreadId:'worker-one',orchestratorThreadId:'orch-one',correctionCount:1,processedTurns:['turn-one']}],currentPassId:'pass-1',assignment,receipt,reviewNote:'Reviewed first pass',resolution:'delegated',workerThreadId:'worker-one',orchestratorThreadId:'orch-one',correctionCount:1,processedTurns:['turn-one']};}

describe('per-pass task state',()=>{
  it('starts an independent pass and leaves prior assignment, receipt and thread ids attached to the previous pass',()=>{
    const task=taskFixture();syncCurrentPass(task);const userMessage:Message={id:'user-two',role:'user',text:'Second prompt',createdAt:'2026-10-19T00:01:00Z'};task.messages.push(userMessage);const second=beginPass(task,userMessage.text,userMessage.id);
    expect(userMessage.passId).toBe(second.id);expect(currentPass(task)?.id).toBe(second.id);
    expect(task.passes).toHaveLength(2);expect(task.passes?.[0]).toMatchObject({assignment,receipt,workerThreadId:'worker-one',orchestratorThreadId:'orch-one',phase:'accepted'});
    expect(second).toMatchObject({index:2,userInput:'Second prompt',phase:'intake',correctionCount:0});expect(second.assignment).toBeUndefined();expect(second.receipt).toBeUndefined();expect(task.orchestratorThreadId).toBeUndefined();expect(task.workerThreadId).toBeUndefined();
    second.orchestratorThreadId='orch-two';task.orchestratorThreadId='orch-two';syncCurrentPass(task);expect(isCurrentPassThread(task,'orch-two')).toBe(true);expect(isCurrentPassThread(task,'orch-one')).toBe(false);
  });
  it('migrates old single-artifact state without claiming the artifact belongs to a particular message',()=>{
    const legacy=upgradeStoredState({version:1,settings:{projectRoot:'D:/workspace',agentmemProjectId:'demo'},activeTaskId:'old',tasks:[{id:'old',title:'Old task',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:01:00Z',userRoot:'D:/workspace',userMessages:['first','second'],messages:[{id:'one',role:'user',text:'first'},{id:'two',role:'user',text:'second'}],assignment,receipt,correctionCount:0,processedTurns:[]}]});
    const old=legacy.tasks[0];expect(legacy.version).toBe(2);expect(old.messages).toHaveLength(2);expect(old.userMessages).toEqual(['first','second']);expect(old.currentPassId).toBeUndefined();expect(old.passes?.[0]).toMatchObject({legacyUnassociated:true,assignment,receipt,userInputs:['first','second']});
  });
  it('preserves role-labeled visible answers for follow-ups while excluding assignments, receipts, and worker output',()=>{
    const direct={...taskFixture().passes![0],id:'direct',index:1,userInput:'What is 1+1?',userInputs:['What is 1+1?','Do not delegate.'],resolution:'direct' as const,publicAnswer:'1 + 1 = 2.',reasoningSummaries:[{role:'orchestrator' as const,threadId:'orch',turnId:'turn',itemId:'reason',summaryIndex:0,text:'PRIVATE_REASONING_SUMMARY_SHOULD_NOT_FORWARD',passId:'direct'}],assignment:{...assignment,outcome:'PRIVATE_ASSIGNMENT_SHOULD_NOT_FORWARD'},receipt:{...receipt,result:'PRIVATE_WORKER_RECEIPT_SHOULD_NOT_FORWARD'}};
    const delegated={...taskFixture().passes![0],id:'delegated',index:2,userInput:'Return my requested result.',userInputs:['Return my requested result.'],reviewNote:'The requested result is 2.',resolution:'delegated' as const,phase:'accepted' as const,assignment:{...assignment,outcome:'PRIVATE_ASSIGNMENT_SHOULD_NOT_FORWARD'},receipt:{...receipt,result:'PRIVATE_WORKER_RECEIPT_SHOULD_NOT_FORWARD'}};
    const context=buildPriorConversationContext([direct,delegated],'current');
    const text=formatCurrentPassConversation('Double that result.',context);
    expect(text).toContain('CURRENT USER REQUEST:\nDouble that result.');
    expect(text).toContain('Use this history to resolve conversational follow-ups');
    expect(text).toContain('"role":"user","content":"What is 1+1?"');
    expect(text).toContain('"role":"assistant","content":"1 + 1 = 2."');
    expect(context[0].conversation_history).toEqual([{role:'user',content:'What is 1+1?'},{role:'user',content:'Do not delegate.'},{role:'assistant',content:'1 + 1 = 2.'}]);
    expect(context[1].conversation_history).toEqual([{role:'user',content:'Return my requested result.'},{role:'assistant',content:'The requested result is 2.'}]);
    expect(text).not.toContain('PRIVATE_WORKER_RECEIPT_SHOULD_NOT_FORWARD');
    expect(text).not.toContain('PRIVATE_ASSIGNMENT_SHOULD_NOT_FORWARD');
    expect(text).not.toContain('PRIVATE_REASONING_SUMMARY_SHOULD_NOT_FORWARD');
    expect(text).not.toContain('worker-one');
    expect(text).not.toContain('PRIVATE_WORKER_RESULT');
  });
});
