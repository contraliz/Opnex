import { describe, expect, it } from 'vitest';
import { beginPass, currentPass, isCurrentPassThread, syncCurrentPass, upgradeStoredState, type Message, type Task } from '../server/state.js';
import { buildPriorConversationContext, formatCurrentPassConversation } from '../server/pass-context.js';

const assignment={outcome:'First change',deliverable:'first',read_scope:[],write_scope:[],exclusions:[],constraints:[],context_refs:[],acceptance:['done'],verification:['check'],ordinary_authority:['normal choices'],escalation_conditions:['blocked'],receipt_requirements:['receipt']};
const receipt={status:'complete' as const,result:'First result',changes:[],acceptance:{met:['done'],unmet:[]},verification:[],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null};
function taskFixture():Task{return {id:'task',title:'First prompt',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z',userRoot:'D:/workspace',agentmemProjectId:'demo',userMessages:['First prompt'],messages:[],passes:[{id:'pass-1',index:1,createdAt:'2026-10-19T00:00:00Z',userInput:'First prompt',userInputs:['First prompt'],userMessageIds:[],phase:'accepted',assignment,receipt,reviewNote:'Reviewed first pass',resolution:'delegated',workerThreadId:'worker-one',orchestratorThreadId:'orch-one',correctionCount:1,processedTurns:['turn-one']}],currentPassId:'pass-1',assignment,receipt,reviewNote:'Reviewed first pass',resolution:'delegated',workerThreadId:'worker-one',orchestratorThreadId:'orch-one',correctionCount:1,processedTurns:['turn-one']};}

describe('per-pass task state',()=>{
  it('persists each completed pass usage snapshot across reloads and new passes',()=>{
    const task=taskFixture();task.passes![0].usage={orchestrator:{threadId:'orch-one',tokenStatus:'available',tokens:{totalTokens:80,inputTokens:60,cachedInputTokens:10,cacheWriteInputTokens:null,outputTokens:20,reasoningOutputTokens:4,modelContextWindow:128000,source:'thread'},creditStatus:'available',estimateSource:'codex-app-server-thread-usage',estimatedCreditsMicros:'1200000',estimatedUsdMicros:'700000',groups:[{model:'gpt-6-sol',reasoningEffort:'high',speed:'standard',estimatedCreditsMicros:'1200000',netNewInputTokens:'50',cachedInputTokens:'10',inputTokens:'60',outputTokens:'20',totalTokens:'80'}],allowance:{fiveHourPercent:0.25,weeklyPercent:0.5,fiveHourWindow:{sampleCount:1,firstSampledAt:'2026-10-19T00:00:00Z',lastSampledAt:'2026-10-19T00:01:00Z',windowDurationMins:300,resetsAt:1800000000,boundariesChanged:false}}},worker:{threadId:'worker-one',tokenStatus:'available',tokens:{totalTokens:20,inputTokens:15,cachedInputTokens:0,cacheWriteInputTokens:null,outputTokens:5,reasoningOutputTokens:1,modelContextWindow:128000,source:'thread'},creditStatus:'available',estimateSource:'codex-app-server-thread-usage',estimatedCreditsMicros:'300000',estimatedUsdMicros:'150000',groups:[{model:'gpt-6-luna',reasoningEffort:'high',speed:'standard',estimatedCreditsMicros:'300000',netNewInputTokens:'15',cachedInputTokens:'0',inputTokens:'15',outputTokens:'5',totalTokens:'20'}],allowance:{fiveHourPercent:0.1,weeklyPercent:0.2}}};
    const loaded=upgradeStoredState(JSON.parse(JSON.stringify({version:2,settings:{},tasks:[task],activeTaskId:task.id}))).tasks[0];
    const previous=loaded.passes![0].usage;const userMessage:Message={id:'later',role:'user',text:'Next pass',createdAt:'2026-10-19T00:02:00Z'};loaded.messages.push(userMessage);beginPass(loaded,userMessage.text,userMessage.id);
    expect(loaded.passes![0].usage).toEqual(previous);expect(loaded.passes![0].usage?.orchestrator?.groups?.[0].model).toBe('gpt-6-sol');expect(loaded.passes![0].usage?.orchestrator?.allowance?.fiveHourWindow?.firstSampledAt).toBe('2026-10-19T00:00:00Z');expect(loaded.passes![1].usage).toBeUndefined();
  });
  it('starts an independent pass and leaves prior assignment, receipt and thread ids attached to the previous pass',()=>{
    const task=taskFixture();syncCurrentPass(task);const userMessage:Message={id:'user-two',role:'user',text:'Second prompt',createdAt:'2026-10-19T00:01:00Z'};task.messages.push(userMessage);const second=beginPass(task,userMessage.text,userMessage.id);
    expect(userMessage.passId).toBe(second.id);expect(currentPass(task)?.id).toBe(second.id);
    expect(task.passes).toHaveLength(2);expect(task.passes?.[0]).toMatchObject({assignment,receipt,workerThreadId:'worker-one',orchestratorThreadId:'orch-one',phase:'accepted'});
    expect(second).toMatchObject({index:2,userInput:'Second prompt',phase:'intake',correctionCount:0});expect(second.assignment).toBeUndefined();expect(second.receipt).toBeUndefined();expect(task.orchestratorThreadId).toBeUndefined();expect(task.workerThreadId).toBeUndefined();
    second.orchestratorThreadId='orch-two';task.orchestratorThreadId='orch-two';syncCurrentPass(task);expect(isCurrentPassThread(task,'orch-two')).toBe(true);expect(isCurrentPassThread(task,'orch-one')).toBe(false);
  });
  it('persists the selected approval policy per pass and preserves the historical policy across later passes',()=>{
    const task=taskFixture();task.passes![0].approvalPolicy='on-request';syncCurrentPass(task);
    const msg:Message={id:'user-full',role:'user',text:'Use full access',createdAt:'2026-10-19T00:02:00Z'};task.messages.push(msg);
    const second=beginPass(task,msg.text,msg.id,'full-access');
    expect(task.passes?.[0].approvalPolicy).toBe('on-request');expect(second.approvalPolicy).toBe('full-access');
    const migrated=upgradeStoredState({version:2,settings:{approvalPolicy:'full-access'},tasks:[task],activeTaskId:task.id});
    expect(migrated.tasks[0].passes?.map(pass=>pass.approvalPolicy)).toEqual(['on-request','full-access']);
  });
  it('migrates old passes from the saved setting and rejects an unknown stored preset to the safe default',()=>{
    const task=taskFixture();delete task.passes![0].approvalPolicy;
    const saved=upgradeStoredState({version:2,settings:{approvalPolicy:'full-access'},tasks:[task],activeTaskId:task.id});
    expect(saved.tasks[0].passes?.[0].approvalPolicy).toBe('full-access');expect(saved.settings.approvalPolicy).toBe('full-access');
    const invalid=upgradeStoredState({version:2,settings:{approvalPolicy:'custom-policy'},tasks:[],activeTaskId:null});
    expect(invalid.settings.approvalPolicy).toBe('on-request');
  });
  it('migrates old single-artifact state without claiming the artifact belongs to a particular message',()=>{
    const legacy=upgradeStoredState({version:1,settings:{projectRoot:'D:/workspace',agentmemProjectId:'demo'},activeTaskId:'old',tasks:[{id:'old',title:'Old task',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:01:00Z',userRoot:'D:/workspace',userMessages:['first','second'],messages:[{id:'one',role:'user',text:'first'},{id:'two',role:'user',text:'second'}],assignment,receipt,correctionCount:0,processedTurns:[]}]});
    const old=legacy.tasks[0];expect(legacy.version).toBe(2);expect(old.messages).toHaveLength(2);expect(old.userMessages).toEqual(['first','second']);expect(old.currentPassId).toBeUndefined();expect(old.passes?.[0]).toMatchObject({legacyUnassociated:true,assignment,receipt,userInputs:['first','second']});
  });
  it('preserves an explicit per-task AgentMem opt-out across state migration',()=>{
    const state=upgradeStoredState({version:2,settings:{projectRoot:'D:/workspace',agentmemProjectId:'configured-project'},tasks:[{id:'disabled-task',title:'No KB',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:01:00Z',userRoot:'D:/workspace',agentmemProjectId:'',userMessages:['question'],messages:[],correctionCount:0,processedTurns:[]},{id:'legacy-task',title:'Old KB',phase:'accepted',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:01:00Z',userRoot:'D:/workspace',userMessages:['question'],messages:[],correctionCount:0,processedTurns:[]}]});
    expect(state.tasks.find(t=>t.id==='disabled-task')?.agentmemProjectId).toBe('');
    expect(state.tasks.find(t=>t.id==='legacy-task')?.agentmemProjectId).toBe('configured-project');
  });
  it('preserves role-labeled visible answers for follow-ups while excluding assignments, receipts, and worker output',()=>{
    const direct={...taskFixture().passes![0],id:'direct',index:1,userInput:'What is 1+1?',userInputs:['What is 1+1?','Do not delegate.'],resolution:'direct' as const,publicAnswer:'1 + 1 = 2.',reasoningSummaries:[{role:'orchestrator' as const,threadId:'orch',turnId:'turn',itemId:'reason',summaryIndex:0,text:'PRIVATE_REASONING_SUMMARY_SHOULD_NOT_FORWARD',passId:'direct'}],reasoningRawContent:[{role:'orchestrator' as const,threadId:'orch',turnId:'turn',itemId:'reason',contentIndex:0,text:'PRIVATE_RAW_REASONING_SHOULD_NOT_FORWARD',passId:'direct'}],assignment:{...assignment,outcome:'PRIVATE_ASSIGNMENT_SHOULD_NOT_FORWARD'},receipt:{...receipt,result:'PRIVATE_WORKER_RECEIPT_SHOULD_NOT_FORWARD'}};
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
    expect(text).not.toContain('PRIVATE_RAW_REASONING_SHOULD_NOT_FORWARD');
    expect(text).not.toContain('PRIVATE_REASONING_SUMMARY_SHOULD_NOT_FORWARD');
    expect(text).not.toContain('worker-one');
    expect(text).not.toContain('PRIVATE_WORKER_RESULT');
  });
});
