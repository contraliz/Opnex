import { describe, expect, it } from 'vitest';
import { qualityLoopCanAcceptFindings, qualityLoopResumeAction } from '../server/quality-loop-resume.js';

const round={roundId:'round-1',status:'awaiting_corrections',findings:[{findingId:'finding-1'}]};
type PlannerStatus='preflight'|'dispatch_unknown'|'active'|'interrupted'|'completed';
type LoopStatus='disabled'|'awaiting_audit'|'auditing'|'awaiting_corrections'|'correcting'|'complete'|'user_accepted'|'needs_attention'|'paused'|'paused_after_restart'|'cancelled';
const loop=(status:LoopStatus,plannerStatus?:PlannerStatus)=>({enabled:true,status,resumeAction:'corrections' as const,rounds:[round],...(plannerStatus?{correctionPlanner:{roundId:round.roundId,status:plannerStatus,threadId:'planner-thread',turnId:'planner-turn'}}:{})});

describe('QA resume eligibility',()=>{
  it.each(['preflight','dispatch_unknown','active'] as const)('keeps paused correction planning unavailable while dispatch is %s',(plannerStatus:PlannerStatus)=>{
    expect(qualityLoopResumeAction(loop('paused',plannerStatus))).toBeUndefined();
    expect(qualityLoopResumeAction(loop('paused_after_restart',plannerStatus))).toBeUndefined();
    expect(qualityLoopResumeAction(loop('needs_attention',plannerStatus))).toBeUndefined();
  });
  it.each(['interrupted','completed'] as const)('allows the saved findings after a terminal planner outcome (%s)',(plannerStatus:PlannerStatus)=>{
    expect(qualityLoopResumeAction(loop('paused',plannerStatus))).toBe('corrections');
    expect(qualityLoopResumeAction(loop('paused_after_restart',plannerStatus))).toBe('corrections');
  });
  it.each(['disabled','awaiting_audit','auditing','awaiting_corrections','correcting','complete','user_accepted','needs_attention','paused','paused_after_restart','cancelled'] as const)('never exposes a resume action while a planner dispatch is unknown in %s state',(status:LoopStatus)=>{
    expect(qualityLoopResumeAction(loop(status,'dispatch_unknown'))).toBeUndefined();
    expect(qualityLoopResumeAction(loop(status,'active'))).toBeUndefined();
  });
  it('blocks every QA resume action while a correction planner may still be running',()=>{
    expect(qualityLoopResumeAction({...loop('needs_attention','dispatch_unknown'),resumeAction:'audit'})).toBeUndefined();
    expect(qualityLoopResumeAction({...loop('paused','active'),resumeAction:'audit'})).toBeUndefined();
    expect(qualityLoopResumeAction({...loop('needs_attention','completed'),resumeAction:'audit'})).toBe('audit');
  });
});

describe('QA finding acceptance eligibility',()=>{
  const completedIssueRound={...round,status:'completed',resultStatus:'issues_found'};
  const terminalPlanner=(roundId='round-1')=>({roundId,status:'completed' as const,threadId:'planner-thread',turnId:'planner-turn'});
  const allStatuses:LoopStatus[]=['disabled','awaiting_audit','auditing','awaiting_corrections','correcting','complete','user_accepted','needs_attention','paused','paused_after_restart','cancelled'];
  it.each(allStatuses)('requires a known stopped state for unplanned findings in %s',status=>{
    const state={...loop(status),correctionPlannerNotDispatchedRoundId:round.roundId};
    expect(qualityLoopCanAcceptFindings(state as any,'round-1')).toBe(['paused','paused_after_restart'].includes(status));
  });
  it.each(allStatuses)('accepts terminal audit findings only in a stopped state for %s',status=>{
    const state={...loop(status),rounds:[completedIssueRound]};
    expect(qualityLoopCanAcceptFindings(state as any,'round-1')).toBe(['needs_attention','paused','paused_after_restart'].includes(status));
  });
  it.each(['awaiting_corrections','needs_attention','paused','paused_after_restart'] as const)('allows current terminal planner outcomes in %s',status=>{
    for(const plannerStatus of ['interrupted','completed'] as const)expect(qualityLoopCanAcceptFindings(loop(status,plannerStatus) as any,'round-1')).toBe(true);
  });
  it.each(['preflight','dispatch_unknown','active'] as const)('blocks all acceptance while current planner is %s',plannerStatus=>{
    for(const status of ['awaiting_corrections','needs_attention','paused','paused_after_restart'] as const)expect(qualityLoopCanAcceptFindings(loop(status,plannerStatus) as any,'round-1')).toBe(false);
  });
  it('allows known no-dispatch pause but rejects an unmarked or stale correction planner',()=>{
    expect(qualityLoopCanAcceptFindings({...loop('paused'),correctionPlannerNotDispatchedRoundId:'round-1'} as any,'round-1')).toBe(true);
    expect(qualityLoopCanAcceptFindings(loop('paused') as any,'round-1')).toBe(false);
    expect(qualityLoopCanAcceptFindings({...loop('paused'),correctionPlannerNotDispatchedRoundId:'round-old',correctionPlanner:terminalPlanner('round-old'),rounds:[{...round,roundId:'round-old'},round]} as any,'round-1')).toBe(false);
    expect(qualityLoopCanAcceptFindings({...loop('paused'),correctionPlanner:terminalPlanner('round-old'),rounds:[{...round,roundId:'round-old'},round]} as any,'round-1')).toBe(false);
  });
  it('allows round-limit findings after a previous terminal planner without treating it as the current planner',()=>{
    const state={...loop('needs_attention','completed'),correctionPlanner:terminalPlanner('round-old'),rounds:[{roundId:'round-old',status:'correcting'},completedIssueRound]};
    expect(qualityLoopCanAcceptFindings(state as any,'round-1')).toBe(true);
  });
  const illegal=[
    ['a no-dispatch pause without authoritative round identity',loop('paused')],
    ['a current terminal planner without a recorded turn',{...loop('paused','completed'),correctionPlanner:{roundId:'round-1',status:'completed',threadId:'planner-thread'}}],
    ['a terminal planner with unknown round ownership',{...loop('needs_attention'),rounds:[completedIssueRound],correctionPlanner:terminalPlanner('unknown-round')}],
    ['a clean completed audit', {...loop('needs_attention'),rounds:[{...completedIssueRound,resultStatus:'no_actionable_issues'}]}],
    ['a failed audit round', {...loop('needs_attention'),rounds:[{...round,status:'failed'}]}],
    ['a stale expected round',loop('paused','completed')],
    ['an empty finding list',{...loop('paused','completed'),rounds:[{...round,findings:[]}]}],
    ['a loop state that is already correcting',loop('correcting','completed')],
    ['a disabled QA loop',{...loop('paused','completed'),enabled:false}],
  ] as const;
  it.each(illegal)('blocks acceptance for %s',(_name,state)=>expect(qualityLoopCanAcceptFindings(state as any,_name==='a stale expected round'?'round-old':'round-1')).toBe(false));
});
