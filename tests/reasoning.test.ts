import { describe, expect, it } from 'vitest';
import { applyCodexReasoningNotification, beginReasoningTurn } from '../server/reasoning.js';
import type { Task } from '../server/state.js';

function task():Task{return {id:'task',title:'Work',phase:'worker_running',createdAt:'',updatedAt:'',userRoot:'D:/repo',agentmemProjectId:'demo',userMessages:[],messages:[],currentPassId:'pass-1',workerThreadId:'worker-thread',orchestratorThreadId:'orchestrator-thread',activeRole:'worker',activeTurnId:'worker-turn',activeModelId:'gpt-6-luna',activeEffort:'high',processedTurns:[],correctionCount:0,passes:[{id:'pass-1',index:1,createdAt:'',userInput:'work',userInputs:['work'],userMessageIds:[],phase:'worker_running',correctionCount:0,processedTurns:[]}]};}
const event=(threadId:string,turnId:string,extra:Record<string,unknown>={})=>({threadId,turnId,...extra});

describe('Codex activity channels',()=>{
  it('streams readable reasoning summaries incrementally and replaces them with the completed provider summary',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/summaryTextDelta',event('worker-thread','worker-turn',{itemId:'r',summaryIndex:0,delta:'Inspecting the project.'}))).toBe(true);
    expect(t.reasoningSummaries?.[0]).toMatchObject({role:'worker',itemId:'r',text:'Inspecting the project.',passId:'pass-1',requestedModel:'gpt-6-luna',requestedEffort:'high'});
    expect(applyCodexReasoningNotification(t,'item/completed',event('worker-thread','worker-turn',{item:{id:'r',type:'reasoning',summary:['Verified summary'],content:['private raw reasoning']}}))).toBe(true);
    expect(t.reasoningSummaries?.[0].text).toBe('Verified summary');
    expect(JSON.stringify(t)).not.toContain('private raw reasoning');
  });

  it('captures only provider-marked assistant commentary deltas and leaves final answers to the final-output path',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/started',event('worker-thread','worker-turn',{item:{id:'commentary-1',type:'agentMessage',phase:'commentary',content:[]}}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('worker-thread','worker-turn',{itemId:'commentary-1',delta:'I will inspect '}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('worker-thread','worker-turn',{itemId:'commentary-1',delta:'the event path.'}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/started',event('worker-thread','worker-turn',{item:{id:'final-1',type:'agentMessage',phase:'final_answer',content:[]}}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('worker-thread','worker-turn',{itemId:'final-1',delta:'Do not duplicate the final answer.'}))).toBe(false);
    expect(t.liveActivity?.map(x=>x.text)).toEqual(['I will inspect the event path.']);
  });

  it('captures orchestrator activity and keeps it separate from later worker activity',()=>{
    const t=task();t.phase='planning';t.activeRole='orchestrator';t.activeTurnId='orchestrator-turn';beginReasoningTurn(t,'orchestrator','orchestrator-thread','orchestrator-turn','gpt-6.1-sol','low');
    expect(applyCodexReasoningNotification(t,'item/started',event('orchestrator-thread','orchestrator-turn',{item:{id:'plan-commentary',type:'agentMessage',phase:'commentary',content:[]}}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('orchestrator-thread','orchestrator-turn',{itemId:'plan-commentary',delta:'Checking the request and project context.'}))).toBe(true);
    expect(t.liveActivity?.[0]).toMatchObject({role:'orchestrator',turnId:'orchestrator-turn',text:'Checking the request and project context.'});
    t.phase='worker_running';t.activeRole='worker';t.activeTurnId='worker-turn';beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('orchestrator-thread','orchestrator-turn',{itemId:'plan-commentary',delta:' stale'}))).toBe(false);
    expect(t.liveActivity?.[0].text).toBe('Checking the request and project context.');
  });

  it('shows running tool rows, streams command output, reconciles completion and deduplicates snapshots by item ID',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/started',event('worker-thread','worker-turn',{item:{id:'cmd-1',type:'commandExecution',command:'rg -n activity src',cwd:'D:/repo',status:'inProgress'}}))).toBe(true);
    expect(t.liveActivity?.[0]).toMatchObject({itemId:'cmd-1',kind:'tool',title:'rg -n activity src',status:'running',detail:'cwd: D:/repo'});
    expect(applyCodexReasoningNotification(t,'item/commandExecution/outputDelta',event('worker-thread','worker-turn',{itemId:'cmd-1',delta:'matched line\n'}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'item/completed',event('worker-thread','worker-turn',{item:{id:'cmd-1',type:'commandExecution',command:'rg -n activity src',status:'completed',exitCode:0,aggregatedOutput:'matched line\n'}}))).toBe(true);
    expect(applyCodexReasoningNotification(t,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'completed',items:[{id:'cmd-1',type:'commandExecution',command:'rg -n activity src',status:'completed',exitCode:0,aggregatedOutput:'matched line\n'}]}})).toBe(true);
    expect(t.liveActivity).toHaveLength(1);expect(t.liveActivity?.[0]).toMatchObject({status:'completed',detail:'cwd: D:/repo',output:'matched line\n'});
    expect(t.reasoningTurns?.[0].status).toBe('completed');
  });

  it('labels MCP tool rows with the server and tool names exposed by Codex',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/started',event('worker-thread','worker-turn',{item:{id:'mcp-1',type:'mcpToolCall',server:'AgentMem',tool:'attach_project',status:'inProgress'}}))).toBe(true);
    expect(t.liveActivity?.[0]).toMatchObject({title:'AgentMem · attach_project',status:'running'});
  });

  it('marks failed and interrupted in-flight items at turn completion without inventing activity',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    applyCodexReasoningNotification(t,'item/started',event('worker-thread','worker-turn',{item:{id:'cmd-1',type:'commandExecution',command:'build',status:'inProgress'}}));
    applyCodexReasoningNotification(t,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'failed',items:[]}});
    expect(t.liveActivity?.[0].status).toBe('failed');expect(t.reasoningTurns?.[0].status).toBe('failed');
    const empty=task();beginReasoningTurn(empty,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    applyCodexReasoningNotification(empty,'turn/completed',{threadId:'worker-thread',turn:{id:'worker-turn',status:'interrupted',items:[]}});
    expect(empty.liveActivity).toBeUndefined();expect(empty.reasoningSummaries).toBeUndefined();expect(empty.reasoningTurns?.[0].status).toBe('interrupted');
  });

  it('rejects cross-role, stale-turn, raw-reasoning and non-commentary assistant events',()=>{
    const t=task();beginReasoningTurn(t,'worker','worker-thread','worker-turn','gpt-6-luna','high');
    expect(applyCodexReasoningNotification(t,'item/reasoning/textDelta',event('worker-thread','worker-turn',{itemId:'r',contentIndex:0,delta:'private raw reasoning'}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/started',event('orchestrator-thread','worker-turn',{item:{id:'wrong-role',type:'commandExecution',command:'secret'}}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/started',event('worker-thread','old-turn',{item:{id:'stale',type:'commandExecution',command:'stale'}}))).toBe(false);
    expect(applyCodexReasoningNotification(t,'item/agentMessage/delta',event('worker-thread','worker-turn',{itemId:'unknown',delta:'unclassified'}))).toBe(false);
    expect(JSON.stringify(t)).not.toContain('private raw reasoning');expect(t.liveActivity).toBeUndefined();
  });
});
