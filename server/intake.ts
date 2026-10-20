import { assignmentSchema, initialOrchestratorSchema, type Assignment, type InitialOrchestratorOutcome } from './contracts.js';

export async function dispatchIntakeOutcome(
  raw:unknown,
  allowDirect:boolean,
  handlers:{direct:(outcome:Extract<InitialOrchestratorOutcome,{type:'direct_answer'}>)=>Promise<void>;delegate:(assignment:Assignment)=>Promise<void>},
) {
  if(!allowDirect) {
    const assignment=assignmentSchema.parse(raw);
    await handlers.delegate(assignment);
    return 'delegated' as const;
  }
  const outcome=initialOrchestratorSchema.parse(raw);
  if(outcome.type==='direct_answer') {
    await handlers.direct(outcome);
    return 'direct' as const;
  }
  await handlers.delegate(outcome.assignment);
  return 'delegated' as const;
}
