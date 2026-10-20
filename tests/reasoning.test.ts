import { describe, expect, it } from 'vitest';
import { applyCodexReasoningNotification, beginReasoningTurn } from '../server/reasoning.js';
import type { Task } from '../server/state.js';

function task():Task{return {id:'task',title:'Work',phase:'worker_running',createdAt:'',updatedAt:'',userRoot:'D:/repo',agentmemProjectId:'demo',userMessages:[],messages:[],currentPassId:'pass-1',workerThreadId:'worker-thread',orchestratorThreadId:'orchestrator-thread',activeRole:'worker',activeTurnId:'worker-turn',activeModelId:'gpt-6-luna',activeEffort:'high',processedTurns:[],correctionCount:0,passes:[{id:'pass-1',index:1,createdAt:'',userInput:'work',userInputs:['work'],userMessageIds:[],phase:'worker_running',correctionCount:0,processedTurns:[]}]};}
const event=(threadId:string,turnId:string,extra:Record<string,unknown>={})=>({threadId,turnId,...extra});

describe('Codex reasoning channels',()=>{
  it('streams readable summary deltas with per-role and requested-model metadata',()=>{
    const t=task();
    expect(beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high')).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'reasoning-1',summaryIndex:0,delta:'I will inspect the relevant behavior.'}))).toBe(true);
    expect(t.reasoningSummaries).toEqual([{role:'worker',threadId:'worker-thread',turnId:'worker-turn',itemId:'reasoning-1',summaryIndex:0,text:'I will inspect the relevant behavior.',passId:'pass-1',requestedModel:'gpt-6-luna',requestedEffort:'high',effectiveModel:undefined}]);
    expect(t.reasoningTurns?.[0]).toMatchObject({role:'worker',requestedModel:'gpt-6-luna',requestedEffort:'high',status:'streaming',startedAt:expect.any(String)});
  });
  it('creates summary section boundaries and replaces streamed text with the authoritative completed item without duplicating it',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryPartAdded',event('worker-thread','worker-turn',{itemId:'r',summaryIndex:0}))).toBe(true);
    expect(t.reasoningSummaries?.[0].text).toBe('');
    applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'r',summaryIndex:0,delta:'Draft wording'}));
    expect(applyCodexReasoningNotification(t,'item/completed',{...event('worker-thread','worker-turn'),item:{id:'r',type:'reasoning',summary:['Final readable summary'],content:['private raw reasoning']}})).toBe(true);
    expect(t.reasoningSummaries).toHaveLength(1);expect(t.reasoningSummaries?.[0].text).toBe('Final readable summary');
    expect(t.reasoningRawContent).toEqual([{role:'worker',threadId:'worker-thread',turnId:'worker-turn',itemId:'r',contentIndex:0,text:'private raw reasoning',passId:'pass-1'}]);
  });
  it('streams provider raw text by content index and reconciles each completed snapshot without merging it into the summary',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('worker-thread','worker-turn',{itemId:'r',contentIndex:0,delta:'first '}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('worker-thread','worker-turn',{itemId:'r',contentIndex:1,delta:'second'}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'r',summaryIndex:0,delta:'Readable summary'}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/completed',{...event('worker-thread','worker-turn'),item:{id:'r',type:'reasoning',summary:['Final summary'],content:['authoritative first','authoritative second']}})).toBe(true);
    expect(t.reasoningRawContent?.map(x=>[x.contentIndex,x.text])).toEqual([[0,'authoritative first'],[1,'authoritative second']]);
    expect(t.reasoningSummaries?.[0].text).toBe('Final summary');
    expect(applyCodexReasoningNotification(t,'item/completed',{...event('worker-thread','worker-turn'),item:{id:'r',type:'reasoning',summary:[],content:['authoritative first','authoritative second']}})).toBe(false);
  });
  it('uses a completed raw-content snapshot when no raw deltas were emitted and leaves empty content unavailable',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'completed',items:[{id:'r-final',type:'reasoning',summary:[],content:['completed only']}]}})).toBe(true);
    expect(t.reasoningRawContent?.map(x=>x.text)).toEqual(['completed only']);
    expect(t.reasoningSummaries).toBeUndefined();
    expect(t.reasoningTurns?.[0].status).toBe('completed');
    const empty=task();beginReasoningTurn(empty,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    applyCodexReasoningNotification(empty,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'completed',items:[{id:'r-empty',type:'reasoning',summary:[],content:[]}]}});
    expect(empty.reasoningRawContent).toBeUndefined();expect(empty.reasoningSummaries).toBeUndefined();
  });
  it('uses turn completion summary items as a fallback when no deltas were emitted',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    const completed={threadId:'worker-thread',turn:{id:'worker-turn',status:'completed',items:[{id:'r-final',type:'reasoning',summary:['One','Two'],content:['must not persist']}]}};
    expect(applyCodexReasoningNotification(t,'turn/completed',completed)).toBe(true);
    expect(t.reasoningSummaries?.map(x=>x.text)).toEqual(['One','Two']);
    expect(t.reasoningTurns?.[0].status).toBe('completed');
    expect(applyCodexReasoningNotification(t,'turn/completed',completed)).toBe(true);
    expect(t.reasoningSummaries).toHaveLength(2);
    expect(JSON.stringify(t.reasoningSummaries)).not.toContain('must not persist');
  });
  it('keeps orchestrator and worker summaries and reroutes bound to their own turn',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'model/rerouted',event('worker-thread','worker-turn',{fromModel:'gpt-6-luna',toModel:'gpt-6-luna-fast',reason:'service route'}))).toBe(true);
    applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'w',summaryIndex:0,delta:'Worker summary'}));
    t.phase='reviewing';t.activeRole='orchestrator';t.activeTurnId='review-turn';t.activeModelId='gpt-6-sol';t.activeEffort='high';
    beginReasoningTurn(t,'orchestrator','orchestrator-thread','review-turn','gpt-6-sol','high');
    applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('orchestrator-thread','review-turn',{itemId:'o',summaryIndex:0,delta:'Review summary'}));
    expect(t.reasoningSummaries?.map(x=>[x.role,x.turnId,x.requestedModel,x.effectiveModel])).toEqual([['worker','worker-turn','gpt-6-luna','gpt-6-luna-fast'],['orchestrator','review-turn','gpt-6-sol',undefined]]);
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'w',summaryIndex:0,delta:'must not leak'}))).toBe(false);
  });
  it('rejects cross-role, stale-turn, malformed, and unrelated events without persisting opaque response items',()=>{
    const t=task();
    beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('worker-thread','worker-turn',{itemId:'r',contentIndex:0,delta:'worker raw'}))).toBe(true);
    t.phase='reviewing';t.activeRole='orchestrator';t.activeTurnId='review-turn';
    beginReasoningTurn(t,'orchestrator','orchestrator-thread','review-turn','gpt-6-sol','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('orchestrator-thread','worker-turn',{itemId:'r',contentIndex:0,delta:'cross role'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('worker-thread','old-turn',{itemId:'r',contentIndex:0,delta:'stale'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('orchestrator-thread','review-turn',{itemId:'r',contentIndex:-1,delta:'bad index'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('orchestrator-thread','review-turn',{itemId:'r',contentIndex:0,delta:4}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'rawResponseItem/completed',event('orchestrator-thread','review-turn',{item:{type:'reasoning',encrypted_content:'opaque'}}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('orchestrator-thread','worker-turn',{itemId:'r',summaryIndex:0,delta:'cross role'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','old-turn',{itemId:'r',summaryIndex:0,delta:'stale'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('worker-thread','worker-turn',{itemId:'r',delta:'assistant text is not summary'}))).toBe(false);
    expect(t.reasoningRawContent?.map(x=>x.text)).toEqual(['worker raw']);
    expect(t.reasoningSummaries).toBeUndefined();
  });
  it('marks turns without summaries as completed or failed without inventing text',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    applyCodexReasoningNotification(t,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'failed',items:[]}});
    expect(t.reasoningTurns?.[0].status).toBe('failed');expect(t.reasoningSummaries).toBeUndefined();
  });
  it('does not persist final reasoning content after cancellation',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');t.phase='cancelled';
    expect(applyCodexReasoningNotification(t,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'completed',items:[{id:'r',type:'reasoning',content:['late raw text']}]}})).toBe(false);
    expect(t.reasoningRawContent).toBeUndefined();
  });
});
