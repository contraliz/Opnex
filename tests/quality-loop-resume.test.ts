import { describe, expect, it } from 'vitest';
import { qualityLoopResumeAction } from '../server/quality-loop-resume.js';

const round={roundId:'round-1',status:'awaiting_corrections',findings:[{findingId:'finding-1'}]};
type PlannerStatus='preflight'|'dispatch_unknown'|'active'|'interrupted'|'completed';
type LoopStatus='paused'|'paused_after_restart'|'needs_attention';
const loop=(status:LoopStatus,plannerStatus?:PlannerStatus)=>({enabled:true,status,resumeAction:'corrections' as const,rounds:[round],...(plannerStatus?{correctionPlanner:{roundId:round.roundId,status:plannerStatus}}:{})});

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
  it('blocks every QA resume action while a correction planner may still be running',()=>{
    expect(qualityLoopResumeAction({...loop('needs_attention','dispatch_unknown'),resumeAction:'audit'})).toBeUndefined();
    expect(qualityLoopResumeAction({...loop('paused','active'),resumeAction:'audit'})).toBeUndefined();
    expect(qualityLoopResumeAction({...loop('needs_attention','completed'),resumeAction:'audit'})).toBe('audit');
  });
});
