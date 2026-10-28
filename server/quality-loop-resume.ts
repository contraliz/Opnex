export type QACorrectionPlannerDispatch={roundId:string;status:'preflight'|'dispatch_unknown'|'active'|'interrupted'|'completed';threadId?:string;turnId?:string};
export type QualityLoopResumeState={enabled:boolean;status:string;resumeAction?:'audit'|'corrections';correctionPlanner?:QACorrectionPlannerDispatch;rounds:Array<{roundId:string;status:string;findings?:unknown[]}>};

export function qualityCorrectionPlannerBlocksResume(planner:QACorrectionPlannerDispatch|undefined){return !!planner&&['preflight','dispatch_unknown','active'].includes(planner.status);}
export function qualityCorrectionPlannerMayHaveBeenSent(planner:QACorrectionPlannerDispatch|undefined){return !!planner&&['dispatch_unknown','active'].includes(planner.status);}

export function qualityLoopResumeAction(loop:QualityLoopResumeState|undefined):'audit'|'corrections'|undefined{
  if(!loop?.enabled)return undefined;
  if(qualityCorrectionPlannerBlocksResume(loop.correctionPlanner))return undefined;
  if(loop.status==='needs_attention')return loop.resumeAction==='audit'?'audit':undefined;
  if(!['paused','paused_after_restart'].includes(loop.status))return undefined;
  if(loop.resumeAction==='audit')return 'audit';
  if(loop.resumeAction!=='corrections')return undefined;
  const round=loop.rounds.at(-1);
  if(round?.status!=='awaiting_corrections'||!round.findings?.length)return undefined;
  return 'corrections';
}
