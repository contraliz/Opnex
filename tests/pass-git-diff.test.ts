import { describe,expect,it } from 'vitest';
import { applyPassGitDiffUpdate,PASS_GIT_DIFF_MAX_TURNS,PASS_GIT_DIFF_MAX_TURN_CHARS,replaceTurnDiff } from '../server/pass-git-diff.js';
import type { Task,TaskPass } from '../server/state.js';

function task(overrides:Partial<Task>={}):Task{
  return {id:'task-1',title:'Task',phase:'worker_running',createdAt:'now',updatedAt:'now',userRoot:'D:/repo',agentmemProjectId:'kb',userMessages:[],messages:[],passes:[pass()],currentPassId:'pass-1',correctionCount:0,processedTurns:[],activeRole:'worker',activeTurnId:'turn-1',workerThreadId:'worker-thread',...overrides};
}
function pass(overrides:Partial<TaskPass>={}):TaskPass{return {id:'pass-1',index:1,createdAt:'now',userInput:'Work',userInputs:['Work'],userMessageIds:[],phase:'worker_running',correctionCount:0,processedTurns:[],...overrides};}
const event=(overrides:Record<string,unknown>={})=>({threadId:'worker-thread',turnId:'turn-1',diff:'diff --git a/a b/a\n+one\n',...overrides});

describe('pass-scoped Codex turn diffs',()=>{
  it('accepts a writing turn only when current pass, active turn, role and owned thread all match',()=>{
    const row=task();expect(applyPassGitDiffUpdate(row,event(),'t1')).toBe(true);expect(row.passes?.[0].gitDiff?.turns).toEqual([{threadId:'worker-thread',turnId:'turn-1',role:'worker',diff:'diff --git a/a b/a\n+one\n',capturedAt:'t1'}]);
    for(const invalid of [task({activeTurnId:'turn-2'}),task({activeRole:'router'}),task({workerThreadId:'other'}),task({phase:'cancelled'}),task({currentPassId:'pass-2'}),task({activeRole:'direct'})])expect(applyPassGitDiffUpdate(invalid,event(),'t2')).toBe(false);
    expect(applyPassGitDiffUpdate(task(),event({threadId:'other'}),'t2')).toBe(false);expect(applyPassGitDiffUpdate(task(),event({turnId:'stale-turn'}),'t2')).toBe(false);
  });
  it('replaces cumulative updates for one turn and retains separate turns without double-appending',()=>{
    const target=pass();replaceTurnDiff(target,{threadId:'worker-thread',turnId:'turn-1',role:'worker',diff:'old',capturedAt:'1'});replaceTurnDiff(target,{threadId:'worker-thread',turnId:'turn-1',role:'worker',diff:'new final',capturedAt:'2'});replaceTurnDiff(target,{threadId:'worker-thread',turnId:'turn-2',role:'worker',diff:'second',capturedAt:'3'});
    expect(target.gitDiff?.turns.map(turn=>[turn.turnId,turn.diff])).toEqual([['turn-1','new final'],['turn-2','second']]);expect(target.gitDiff?.updatedAt).toBe('3');
  });
  it('keeps an empty latest diff as a reversion and does not reconstruct from workspace state',()=>{
    const row=task();applyPassGitDiffUpdate(row,event(),'1');applyPassGitDiffUpdate(row,event({diff:''}),'2');expect(row.passes?.[0].gitDiff?.turns).toHaveLength(1);expect(row.passes?.[0].gitDiff?.turns[0].diff).toBe('');expect(applyPassGitDiffUpdate(task({activeTurnId:undefined}),event(),'3')).toBe(false);
  });
  it('bounds turn and pass payloads and reports partial capture',()=>{
    const target=pass();replaceTurnDiff(target,{threadId:'worker-thread',turnId:'turn-1',role:'worker',diff:'x'.repeat(PASS_GIT_DIFF_MAX_TURN_CHARS+20),capturedAt:'1'});expect(target.gitDiff?.status).toBe('partial');expect(target.gitDiff?.turns[0].diff).toHaveLength(PASS_GIT_DIFF_MAX_TURN_CHARS);expect(target.gitDiff?.turns[0].truncated).toBe(true);
  });
  it('caps turn records and labels omitted turns partial',()=>{
    const target=pass();for(let index=0;index<PASS_GIT_DIFF_MAX_TURNS;index++)replaceTurnDiff(target,{threadId:'worker-thread',turnId:`turn-${index}`,role:'worker',diff:`diff ${index}`,capturedAt:`${index}`});replaceTurnDiff(target,{threadId:'worker-thread',turnId:'turn-overflow',role:'worker',diff:'omitted',capturedAt:'overflow'});expect(target.gitDiff?.turns).toHaveLength(PASS_GIT_DIFF_MAX_TURNS);expect(target.gitDiff?.status).toBe('partial');
  });
});
