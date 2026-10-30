import { routeDecisionSchema, type Receipt } from './contracts.js';

export const ROUTING_RULE_PROMPT=`Classify only the current user operation; use prior conversation only to resolve references, not to redo completed work. Example: after a feature is completed, "commit and push this branch" is routine Git; one request to implement a feature and open a PR is hard.
Do not infer hard work from file count alone. Supporting tests or docs for a known bounded correction remain simple, as can a mechanical internal rename across multiple files when persisted and public contracts stay unchanged. Fixing a known bug can change behavior without being a new feature. hard_multi_component_change means coordinated behavior or contracts across application components.

Routes and rule IDs:
- direct_answer / direct_explanation_or_transform: explanations, calculations, summaries, comparisons, or transforms with limited investigation and no implementation. Complex analysis can still be hard.
- simple_implementation / simple_bounded_correction: a known, localized correction with clear verification. Verifying a specified known fix with a focused test is still simple; routine focused verification alone does not make the cause unknown. Use hard_unknown_cause_diagnosis only when substantial diagnostic work is needed to discover the cause.
- simple_implementation / simple_internal_rename: an internal rename with no persisted or public contract change. A persisted/API field rename is hard.
- simple_implementation / simple_mechanical_dependency_upgrade: clearly bounded compatible patch/minor upgrades can be simple when verification is specified. Major upgrades are hard by default; a major-version exception is simple only when the request gives the complete bounded migration delta, confirms no persisted or public contract changes, and specifies verification. Briefly explain the evidence in the request and its verification without relying on a required phrase.
- simple_implementation / simple_established_documentation: documentation of established behavior/design without new architecture choices.
- simple_implementation / simple_routine_git: routine commit, push, branch, merge/rebase, or PR operations for already-completed work.
- hard_task / hard_new_feature: any new behavior or feature, even if an existing pattern can be followed.
- hard_task / hard_multi_component_change: substantive work spanning multiple application components.
- hard_task / hard_migration: data or schema migrations, and broad dependency migrations. The explicitly bounded mechanical dependency exception above takes precedence when every stated condition is met.
- hard_task / hard_major_dependency_upgrade: major upgrades with unknown compatibility or broad migration work. Major upgrades are hard by default unless the user request meets the exact bounded mechanical exception above; patch/minor upgrades are not automatically hard.
- hard_task / hard_public_contract_change: persisted or public API/field contract change.
- hard_task / hard_lifecycle_change: task, process, or resource lifecycle changes.
- hard_task / hard_unknown_cause_diagnosis: substantial diagnosis where the cause is unknown, including failures or performance regressions.
- hard_task / hard_mixed_scope: any request mixing a substantive hard part with a simpler task.
- hard_task / hard_significant_uncertainty: important requirements or facts remain uncertain for reasons other than an unknown failure cause. When the operation is diagnosis of an unknown cause, use hard_unknown_cause_diagnosis.
- hard_task / hard_explicit_project_knowledge: the user explicitly asks for substantive project-knowledge research as part of the answer. Use the generic project skills and configured tools when available; the application does not retrieve or attach knowledge itself.

When a mixed request has any substantive hard part, route the whole operation as hard. Return only route, matching rule_id, and a brief justification.`;

export function buildRouterPrompt(currentOperation:string){return `${ROUTING_RULE_PROMPT}\n\n${currentOperation}`;}

export type RouteOutputResult=
  | {valid:true;decision:ReturnType<typeof routeDecisionSchema.parse>}
  | {valid:false;reason:string};

export function validateRouteOutput(value:unknown):RouteOutputResult{
  const result=routeDecisionSchema.safeParse(value);
  return result.success
    ? {valid:true,decision:result.data}
    : {valid:false,reason:`The router output failed validation: ${result.error.issues.map(issue=>issue.path.join('.')||'result').join(', ')}.`};
}

export async function dispatchRouteOutput<T>(value:unknown,onInvalid:(reason:string)=>Promise<T>,onSelected:(decision:ReturnType<typeof routeDecisionSchema.parse>)=>Promise<T>):Promise<T>{
  const result=validateRouteOutput(value);
  return result.valid?onSelected(result.decision):onInvalid(result.reason);
}

export function simpleReceiptVerified(receipt:Receipt){
  return receipt.status==='complete'&&receipt.acceptance.unmet.length===0&&receipt.decision_required===null&&receipt.verification.some(item=>item.result==='passed')&&!receipt.verification.some(item=>item.result==='failed');
}

export async function awaitCurrentPassOperation<T>(operation:()=>Promise<T>,isCurrent:()=>boolean,onStale?:(value:T)=>Promise<void>):Promise<T|undefined>{
  if(!isCurrent())return undefined;
  const value=await operation();
  if(isCurrent())return value;
  await onStale?.(value);
  return undefined;
}

export async function startRoutingSafely(start:()=>Promise<void>,onFailure:(error:unknown)=>Promise<void>):Promise<boolean>{
  try{await start();return true;}catch(error){await onFailure(error);return false;}
}
