export type QACorrectionPlannerDispatch={roundId:string;status:'preflight'|'dispatch_unknown'|'active'|'interrupted'|'completed';threadId?:string;turnId?:string};
export type QualityLoopResumeState={enabled:boolean;status:string;resumeAction?:'audit'|'corrections';correctionPlanner?:QACorrectionPlannerDispatch;correctionPlannerNotDispatchedRoundId?:string;rounds:Array<{roundId:string;status:string;resultStatus?:string;findings?:unknown[]}>};

export function qualityCorrectionPlannerInFlight(planner:QACorrectionPlannerDispatch|undefined){return !!planner&&['preflight','dispatch_unknown','active'].includes(planner.status);}
export function qualityCorrectionPlannerMayHaveBeenSent(planner:QACorrectionPlannerDispatch|undefined){return !!planner&&['dispatch_unknown','active'].includes(planner.status);}

export function qualityLoopCanAcceptFindings(loop:QualityLoopResumeState|undefined,expectedRoundId?:string){
  if(!loop?.enabled||!['awaiting_corrections','needs_attention','paused','paused_after_restart'].includes(loop.status))return false;
  const round=loop.rounds.at(-1),planner=loop.correctionPlanner;
  if(!round||!round.findings?.length||expectedRoundId&&round.roundId!==expectedRoundId)return false;
  const correctionFindings=round.status==='awaiting_corrections';
  const stoppedAuditFindings=round.status==='completed'&&round.resultStatus==='issues_found';
  if(!correctionFindings&&!stoppedAuditFindings)return false;
  if(planner){
    if(qualityCorrectionPlannerInFlight(planner)||!['interrupted','completed'].includes(planner.status)||!planner.threadId||!planner.turnId)return false;
    if(!loop.rounds.some(saved=>saved.roundId===planner.roundId))return false;
    if(planner.roundId===round.roundId)return true;
    if(correctionFindings)return ['paused','paused_after_restart'].includes(loop.status)&&loop.correctionPlannerNotDispatchedRoundId===round.roundId;
    return ['needs_attention','paused','paused_after_restart'].includes(loop.status);
  }
  if(correctionFindings)return ['paused','paused_after_restart'].includes(loop.status)&&loop.correctionPlannerNotDispatchedRoundId===round.roundId;
  return ['needs_attention','paused','paused_after_restart'].includes(loop.status);
}

export function qualityLoopResumeAction(loop:QualityLoopResumeState|undefined):'audit'|'corrections'|undefined{
  if(!loop?.enabled)return undefined;
  if(qualityCorrectionPlannerInFlight(loop.correctionPlanner))return undefined;
  if(loop.status==='needs_attention')return loop.resumeAction==='audit'?'audit':undefined;
  if(!['paused','paused_after_restart'].includes(loop.status))return undefined;
  if(loop.resumeAction==='audit')return 'audit';
  if(loop.resumeAction!=='corrections')return undefined;
  const round=loop.rounds.at(-1);
  if(round?.status!=='awaiting_corrections'||!round.findings?.length)return undefined;
  return 'corrections';
}
