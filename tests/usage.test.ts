import { describe, expect, it } from 'vitest';
import type { TaskPass } from '../server/state.js';
import { applyAllowanceDelta, applyThreadEstimatedUsage, applyThreadTokenUsage, markThreadTokenUsageUnavailable, normalizeAllowanceSnapshot } from '../server/usage.js';

function pass():TaskPass{return {id:'pass-1',index:1,createdAt:'2026-10-21T00:00:00.000Z',userInput:'Do work',userInputs:['Do work'],userMessageIds:[],phase:'worker_running',correctionCount:1,orchestratorThreadId:'orch-thread',workerThreadId:'worker-thread',processedTurns:[]};}

describe('pass usage accounting',()=>{
  it('replaces cumulative snapshots by thread instead of adding repeated updates',()=>{
    const value=pass();
    expect(applyThreadTokenUsage(value,'orchestrator','orch-thread',{total:{totalTokens:40,inputTokens:30,cachedInputTokens:8,cacheWriteInputTokens:2,outputTokens:10,reasoningOutputTokens:3},last:{totalTokens:40,inputTokens:30,cachedInputTokens:8,cacheWriteInputTokens:2,outputTokens:10,reasoningOutputTokens:3},modelContextWindow:128000})).toBe(true);
    applyThreadTokenUsage(value,'orchestrator','orch-thread',{total:{totalTokens:55,inputTokens:41,cachedInputTokens:12,cacheWriteInputTokens:3,outputTokens:14,reasoningOutputTokens:4},last:{totalTokens:15,inputTokens:11,cachedInputTokens:4,cacheWriteInputTokens:1,outputTokens:4,reasoningOutputTokens:1},modelContextWindow:128000});
    applyThreadTokenUsage(value,'worker','worker-thread',{total:{totalTokens:70,inputTokens:50,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:6},last:{totalTokens:70,inputTokens:50,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:6},modelContextWindow:256000});
    expect(value.usage?.orchestrator?.tokens?.totalTokens).toBe(55);
    expect(value.usage?.orchestrator?.tokens?.inputTokens).toBe(41);
    expect(value.usage?.worker?.tokens?.totalTokens).toBe(70);
    expect(value.usage?.orchestrator?.tokens?.cachedInputTokens).toBe(12);
    expect(value.usage?.orchestrator?.tokens?.reasoningOutputTokens).toBe(4);
  });

  it('rejects stale thread identities and does not replace available usage with an unavailable marker',()=>{
    const value=pass();
    expect(applyThreadTokenUsage(value,'worker','another-thread',{total:{totalTokens:3,inputTokens:2,outputTokens:1}})).toBe(false);
    applyThreadTokenUsage(value,'worker','worker-thread',{total:{totalTokens:3,inputTokens:2,outputTokens:1}});
    expect(markThreadTokenUsageUnavailable(value,'worker','worker-thread')).toBe(false);
    expect(value.usage?.worker?.tokenStatus).toBe('available');
  });

  it('keeps per-thread estimated credits as exact micro-unit strings and retains model breakdowns',()=>{
    const value=pass();
    expect(applyThreadEstimatedUsage(value,'worker','worker-thread',{threadId:'worker-thread',estimatedUsageCreditsMicros:'1234567890123456',estimatedUsageUsdMicros:'2700',groups:[{model:'gpt-6-luna',reasoningEffort:'high',speed:'standard',estimatedUsageCreditsMicros:'1234567890123456',netNewInputTokens:'40',cachedInputTokens:'10',inputTokens:'50',outputTokens:'20',totalTokens:'70'}]})).toBe(true);
    expect(value.usage?.worker?.estimatedCreditsMicros).toBe('1234567890123456');
    expect(value.usage?.worker?.groups?.[0].model).toBe('gpt-6-luna');
    expect(value.usage?.worker?.tokens).toMatchObject({totalTokens:70,inputTokens:50,outputTokens:20,source:'thread-estimate'});
    expect(value.usage?.worker?.tokens?.reasoningOutputTokens).toBeNull();
    expect(applyThreadEstimatedUsage(value,'worker','worker-thread',{threadId:'other-thread',estimatedUsageCreditsMicros:'0'})).toBe(false);
  });

  it('leaves token usage unknown when provider estimates omit token groups',()=>{
    const value=pass();
    applyThreadEstimatedUsage(value,'orchestrator','orch-thread',{threadId:'orch-thread',estimatedUsageCreditsMicros:'0',estimatedUsageUsdMicros:null,groups:[]});
    expect(value.usage?.orchestrator?.creditStatus).toBe('available');
    expect(value.usage?.orchestrator?.estimatedUsdMicros).toBeNull();
    expect(value.usage?.orchestrator?.tokenStatus).toBe('pending');
    expect(value.usage?.orchestrator?.tokens).toBeUndefined();
  });

  it('measures 5-hour and weekly allowance deltas from matching Codex windows only',()=>{
    const snapshot=(fiveHour:number,weekly:number,resetsAt=1800000000)=>normalizeAllowanceSnapshot({rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:fiveHour,windowDurationMins:300,resetsAt},secondary:{usedPercent:weekly,windowDurationMins:10080,resetsAt:1900000000}}}});
    const value=pass();
    expect(applyAllowanceDelta(value,'orchestrator','orch-thread',snapshot(20,40),snapshot(20.25,40.1))).toBe(true);
    expect(applyAllowanceDelta(value,'worker','worker-thread',snapshot(20.25,40.1),snapshot(20.5,40.3))).toBe(true);
    expect(value.usage?.orchestrator?.allowance).toMatchObject({fiveHourPercent:0.25,weeklyPercent:0.1,fiveHourWindow:{sampleCount:1,windowDurationMins:300,resetsAt:1800000000},weeklyWindow:{sampleCount:1,windowDurationMins:10080,resetsAt:1900000000}});
    expect(value.usage?.worker?.allowance).toMatchObject({fiveHourPercent:0.25,weeklyPercent:0.2,fiveHourWindow:{sampleCount:1,windowDurationMins:300,resetsAt:1800000000},weeklyWindow:{sampleCount:1,windowDurationMins:10080,resetsAt:1900000000}});
    applyAllowanceDelta(value,'orchestrator','orch-thread',snapshot(30,50,2000000000),snapshot(30.1,50.2,2000000000));
    expect(value.usage?.orchestrator?.allowance).toMatchObject({fiveHourPercent:0.35,weeklyPercent:0.3,fiveHourWindow:{sampleCount:2,resetsAt:1800000000,boundariesChanged:true}});
    expect(normalizeAllowanceSnapshot({rateLimits:{limitId:'other',primary:{usedPercent:1,windowDurationMins:300,resetsAt:1}}})).toBeNull();
    const crossed=normalizeAllowanceSnapshot({rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:21,windowDurationMins:300,resetsAt:1800000002},secondary:{usedPercent:41,windowDurationMins:10080,resetsAt:1900000001}}}});
    expect(applyAllowanceDelta(value,'worker','worker-thread',snapshot(20,40,1800000001),crossed)).toBe(false);
  });
});
