import type { AgentMemAudit, AgentMemAuditCall, TaskPass, WorkflowRole } from './state.js';
import type { Receipt } from './contracts.js';

function callsForTurn(audit:AgentMemAudit|undefined,role:WorkflowRole,threadId:string,turnId:string){
  return (audit?.calls||[]).filter(call=>call.source==='model'&&call.role===role&&call.threadId===threadId&&call.turnId===turnId&&call.status==='completed');
}
function hasOperation(calls:AgentMemAuditCall[],service:AgentMemAuditCall['service'],operation:AgentMemAuditCall['operation']){
  return calls.some(call=>call.service===service&&call.operation===operation);
}
function hasNoKnowledgeUpdateReason(receipt:Receipt){
  return receipt.knowledge.updated.some(note=>/no\s+(?:meaningful\s+)?(?:agentmem\s+)?(?:knowledge|kb)\s+(?:update|change|entry|record)\s+was\s+needed\s+because\s+.{8,}/i.test(note));
}
function hasNoResyncReason(receipt:Receipt){
  return receipt.knowledge.updated.some(note=>/no\s+(?:repository\s+)?(?:index\s+)?resync\s+was\s+needed\s+because\s+.{8,}/i.test(note));
}
function sameWorkspaceRoot(left:string|undefined,right:string|undefined){
  const normalize=(value:string|undefined)=>value?.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  return !!left&&!!right&&normalize(left)===normalize(right);
}

export function agentMemArtifactUsageGaps(audit:AgentMemAudit|undefined,pass:TaskPass,role:'simple'|'worker',threadId:string,turnId:string,receipt:Receipt){
  if(!audit||!audit.recorded)return ['This pass has no current AgentMem audit record.'];
  if(audit.identityStatus!=='verified'||audit.verifiedProjectId!==audit.selectedProjectId||!sameWorkspaceRoot(audit.verifiedRoot,audit.workspaceRoot))return ['The selected AgentMem project and workspace identity are not verified.'];
  const repositoryId=audit.repositories?.find(row=>row.threadId===threadId)?.repositoryId||audit.verifiedRepositoryId;
  if(!repositoryId)return ['The selected workspace has no verified repository-index identity.'];
  if(audit.modelMcpStatus==='unavailable'||audit.modelMcpStatus==='disabled')return ['The AgentMem MCP catalog was unavailable to this execution role.'];
  const calls=callsForTurn(audit,role,threadId,turnId);
  const knowledgeReads=calls.filter(call=>call.service==='knowledge'&&call.operation==='read'&&call.projectId===audit.verifiedProjectId);
  const repositoryReads=calls.filter(call=>call.service==='repository_index'&&call.operation==='read'&&call.repositoryId===repositoryId&&['repository_search','repository_retrieve'].includes(call.method));
  if(!knowledgeReads.length)return ['The model did not complete a knowledge-base read against the selected project during the artifact-producing turn.'];
  if(!repositoryReads.length)return ['The model did not search or retrieve code from the selected repository index during the artifact-producing turn.'];
  const kbWrite=hasOperation(calls,'knowledge','write');
  if(kbWrite&&!receipt.knowledge.updated.length)return ['A model-issued knowledge write completed but the receipt does not identify the updated knowledge entry.'];
  if(!kbWrite&&!hasNoKnowledgeUpdateReason(receipt))return ['The receipt must name a completed knowledge write or explain why no AgentMem knowledge update was needed.'];
  const sourceChange=pass.turnSourceChanges?.find(row=>row.role===role&&row.threadId===threadId&&row.turnId===turnId);
  if(!sourceChange||sourceChange.status!=='verified')return [`A complete before/after workspace snapshot is unavailable for this artifact-producing turn. ${sourceChange?.reason||'The selected workspace change state is unverified.'}`];
  const changed=sourceChange.changedPaths.length>0||sourceChange.repositoryRevisionChanged;
  const resync=calls.find(call=>call.service==='repository_index'&&call.operation==='write'&&call.method==='repository_resync'&&call.repositoryId===repositoryId);
  if(changed){
    if(!resync)return ['Repository files changed or the change snapshot was truncated, but the model did not complete a repository-index resync in this turn.'];
    const mutationTimes=[...pass.liveActivity||[]].filter(item=>item.threadId===threadId&&item.turnId===turnId&&item.kind==='tool'&&item.status==='completed'&&['commandExecution','fileChange'].includes(item.itemType)).map(item=>Date.parse(item.updatedAt));
    const codexDiff=pass.gitDiff?.turns?.find(row=>row.role===role&&row.threadId===threadId&&row.turnId===turnId);
    if(codexDiff)mutationTimes.push(Date.parse(codexDiff.capturedAt));
    const resyncAt=Date.parse(resync.updatedAt);const latestMutationAt=Math.max(...mutationTimes.filter(Number.isFinite));
    if(!Number.isFinite(resyncAt)||Number.isFinite(latestMutationAt)&&resyncAt<latestMutationAt)return ['The repository-index resync did not complete after the latest recorded file-change or command event.'];
    if(!receipt.knowledge.updated.length)return ['The receipt does not record the repository-index refresh outcome.'];
  }else if(!resync&&!hasNoResyncReason(receipt))return ['The receipt must explain why no repository-index resync was needed for this turn.'];
  return [];
}
