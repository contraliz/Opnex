import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalPolicy, Assignment, Receipt } from './contracts.js';
import type { WorkerContextStatus, WorkerStage } from './worker-staging.js';
import type { TaskAttachment } from './attachments.js';
import { stateDirectory } from './paths.js';
import { assignmentSchema, receiptSchema } from './contracts.js';
import { normalizeAgentWorkspaceUrl } from './workspace-tools.js';

export type TaskPhase = 'intake' | 'routing' | 'direct_running' | 'simple_running' | 'planning' | 'worker_running' | 'escalated' | 'reviewing' | 'accepted' | 'needs_attention' | 'cancelled' | 'paused_after_restart';
export type WorkflowRole='router'|'direct'|'simple'|'orchestrator'|'worker';
export type Message = { id: string; role: 'user'|'router'|'direct'|'simple'|'orchestrator'|'worker'|'system'; text: string; createdAt: string; passId?:string; attachments?:TaskAttachment[]; submissionKind?:'steering'; deliveryStatus?:'pending'|'steered'|'unconfirmed' };
export type ActivityRole='direct'|'simple'|'orchestrator'|'worker';
export type ReasoningSummary = { role:ActivityRole; threadId:string; turnId:string; itemId:string; summaryIndex:number; text:string; passId?:string; requestedModel?:string; requestedEffort?:string; effectiveModel?:string; updatedAt?:string };
export type LiveActivity = { role:ActivityRole; threadId:string; turnId:string; itemId:string; kind:'commentary'|'tool'; itemType:string; title:string; text?:string; detail?:string; output?:string; status:'running'|'completed'|'failed'|'interrupted'; startedAt:string; updatedAt:string; passId?:string };
export type ReasoningTurn = { role:ActivityRole; threadId:string; turnId:string; requestedModel:string; requestedEffort:string; effectiveModel?:string; startedAt?:string; status:'streaming'|'completed'|'interrupted'|'failed' };
export type PassTokenUsage = { totalTokens:number; inputTokens:number; cachedInputTokens:number|null; cacheWriteInputTokens:number|null; outputTokens:number; reasoningOutputTokens:number|null; modelContextWindow:number|null; source:'thread'|'thread-estimate' };
export type PassUsageGroup = { model:string|null; reasoningEffort:string|null; speed:string|null; estimatedCreditsMicros:string; netNewInputTokens:string|null; cachedInputTokens:string|null; inputTokens:string|null; outputTokens:string|null; totalTokens:string|null };
export type PassAllowanceWindow = { sampleCount:number; firstSampledAt:string; lastSampledAt:string; windowDurationMins:number; resetsAt:number; boundariesChanged:boolean };
export type PassAllowanceUsage = { fiveHourPercent:number|null; weeklyPercent:number|null; fiveHourWindow?:PassAllowanceWindow; weeklyWindow?:PassAllowanceWindow };
export type PassRoleUsage = { threadId:string; tokenStatus:'pending'|'available'|'unavailable'; tokens?:PassTokenUsage; creditStatus:'pending'|'available'|'unavailable'; estimateSource?:'codex-app-server-thread-usage'; estimatedCreditsMicros?:string; estimatedUsdMicros?:string|null; allowance?:PassAllowanceUsage; groups?:PassUsageGroup[]; updatedAt?:string };
export type PassUsage = Partial<Record<WorkflowRole,PassRoleUsage>>;
export type AgentMemAuditCall={id:string;source:'application'|'model';role:WorkflowRole;method:string;status:'running'|'completed'|'failed'|'interrupted';startedAt:string;updatedAt:string;contextId?:string;purpose?:string;projectId?:string;repositoryId?:string;threadId?:string;turnId?:string;service?:'knowledge'|'repository_index'|'unknown';operation?:'read'|'write'|'unknown';resultSummary?:string;error?:string};
export type AgentMemAuditContext={id:string;role:ActivityRole;purpose:string;queryHash:string;status:'running'|'retrieved'|'supplied'|'failed'|'disabled'|'interrupted'|'pending';startedAt:string;updatedAt:string;threadId?:string;turnId?:string;projectId?:string;resultSummary?:string;error?:string};
export type AgentMemAudit={recorded:boolean;coverage?:'full_pass'|'from_first_recorded_call';selectedProjectId:string|null;workspaceRoot:string;identityStatus:'unknown'|'unverified'|'verified'|'mismatch'|'unavailable'|'disabled';verifiedProjectId?:string;verifiedRoot?:string;verifiedRepositoryId?:string;modelMcpStatus:'unknown'|'disabled'|'available'|'unavailable'|'no_calls_observed'|'observed';contexts:AgentMemAuditContext[];calls:AgentMemAuditCall[]};
export type ReceiptProvenance={producerRole:'simple'|'worker';threadId:string;turnId:string;recordedAt:string;artifactRefs:string[]};
export type AgentReceiptRecord=ReceiptProvenance&{receipt:Receipt};
export type TurnSourceChangeRecord={role:'simple'|'worker';threadId:string;turnId:string;status:'verified'|'unavailable';workspaceRoot:string;baselineCapturedAt:string;completedAt:string;changedPaths:string[];repositoryRevisionChanged:boolean;reason?:string};
export type PassGitDiffTurn={threadId:string;turnId:string;role:'simple'|'orchestrator'|'worker';diff:string;capturedAt:string;truncated?:boolean};
export type PassGitDiff={status:'recorded'|'partial';source:'codex-turn-diff';updatedAt:string;turns:PassGitDiffTurn[]};
export type ApprovalRequest = { requestId: string|number; method: 'item/commandExecution/requestApproval'|'item/fileChange/requestApproval'|'item/permissions/requestApproval'|'mcpServer/elicitation/request'; itemId:string; threadId:string; turnId:string; reason?:string; command?:string; cwd?:string; grantRoot?:string; availableDecisions?:string[]; kind?:string; networkHost?:string; networkProtocol?:string; serverName?:string; mode?:string; message?:string; requestedSchema?:Record<string,unknown>; url?:string };
export type RouteDecision={route:'direct_answer'|'simple_implementation'|'hard_task';effectiveRoute?:'direct_answer'|'simple_implementation'|'hard_task';rule_id:string;justification:string;model:string;effort:string;speed:string;decidedAt:string;fallback?:boolean};
export type ExecutionEscalation={from:'direct_answer'|'simple_implementation';to:'simple_implementation'|'hard_task';reason:string;completedActions:string[];evidence:string[]};
export type SavedSkillSnapshot={id:string;revision:string;name:string;description:string;source:string;instructions:string;files:{path:string;size:number}[];role?:WorkflowRole;loadedAt?:string};
export type SkillSaveRecord={id:string;revision:string;name:string;description:string;source:string;role:string;action:'create'|'update';savedAt:string};
export type TaskPass = { id:string; index:number; createdAt:string; userInput:string; userInputs:string[]; userMessageIds:string[]; attachments?:TaskAttachment[]; selectedSkills?:SavedSkillSnapshot[]; loadedSkills?:SavedSkillSnapshot[]; savedSkills?:SkillSaveRecord[]; phase:TaskPhase; agentmemAudit?:AgentMemAudit; receiptProvenance?:ReceiptProvenance; agentReceipts?:AgentReceiptRecord[]; turnSourceChanges?:TurnSourceChangeRecord[]; approvalPolicy?:ApprovalPolicy; agentContextVersion?:number; legacyUnassociated?:boolean; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; publicAnswer?:string; assignment?:Assignment; receipt?:Receipt; reviewNote?:string; resolution?:'direct'|'simple'|'delegated'; routingNote?:string; error?:string; escalation?:unknown; workerStage?:WorkerStage; workerContextStatus?:WorkerContextStatus; workerContextSummary?:string; reasoningSummaries?:ReasoningSummary[]; reasoningTurns?:ReasoningTurn[]; liveActivity?:LiveActivity[]; usage?:PassUsage; gitDiff?:PassGitDiff; correctionCount:number; routerThreadId?:string; directThreadId?:string; simpleThreadId?:string; orchestratorThreadId?:string; workerThreadId?:string; activeTurnId?:string; activeRole?:WorkflowRole; processedTurns:string[]; agentmemTaskId?:string; agentmemLease?:string; agentmemRecordStatus?:string; agentmemRecordError?:string; agentmemReceiptId?:string }
export type GitHubTaskLink={repository:string;branch:string;baseBranch?:string;pullRequestUrl?:string;updatedAt:string};
export type Task = { projectId?:string; lastInteractedAt?:string; githubLink?:GitHubTaskLink; workspaceCommand?:{id:string;mode:'browser'|'github';placement:'side'|'full';url?:string;createdAt:string}; id: string; title: string; phase: TaskPhase; createdAt: string; updatedAt: string; userRoot: string; agentmemProjectId: string; userMessages: string[]; messages: Message[]; passes?:TaskPass[]; currentPassId?:string; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; assignment?: Assignment; receipt?: Receipt; reviewNote?: string; resolution?:'direct'|'simple'|'delegated'; allowDirectResponse?:boolean;routingNote?:string;workerStage?:WorkerStage;workerContextStatus?:WorkerContextStatus;workerContextSummary?:string;reasoningSummaries?:ReasoningSummary[];reasoningTurns?:ReasoningTurn[];liveActivity?:LiveActivity[];activeModelId?:string;activeEffort?:string;correctionCount:number;routerThreadId?:string;directThreadId?:string;simpleThreadId?:string;orchestratorThreadId?:string;workerThreadId?:string;activeTurnId?:string;activeRole?:WorkflowRole;processedTurns:string[];error?:string;escalation?:unknown;approvalRequests?:ApprovalRequest[];agentmemTaskId?:string;agentmemLease?:string;agentmemRecordStatus?:string;agentmemRecordError?:string;agentmemReceiptId?:string;pendingRevision?:boolean };
export type Project = { id:string; name:string; projectRoot:string; agentmemProjectId:string; agentmemEnabled:boolean; agentmemAutoSetup:boolean; pinned:boolean; createdAt:string; updatedAt:string };
export type Settings = { projectRoot: string; agentmemProjectId: string; agentmemAutoSetup?:boolean; orchestratorModel: string; orchestratorEffort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'; approvalPolicy: ApprovalPolicy };
export type State = { version: 3; settings: Settings; tasks: Task[]; activeTaskId: string|null; projects:Project[]; selectedProjectId:string|null; expandedProjectIds:string[] };
const dataDir = stateDirectory();
const statePath = path.join(dataDir, 'state.json');
const defaults: State = { version: 3, settings: { projectRoot: '', agentmemProjectId: '', agentmemAutoSetup:false, orchestratorModel: 'gpt-6-sol', orchestratorEffort: 'high', approvalPolicy: 'on-request' }, tasks: [], activeTaskId: null, projects:[], selectedProjectId:null, expandedProjectIds:['unclassified'] };
let current = structuredClone(defaults);
let loaded = false;
let stateLoading:Promise<State>|undefined;
let writeQueue = Promise.resolve();
const listeners = new Set<(state: State) => void>();
const approvalPolicies:ApprovalPolicy[]=['on-request','untrusted','never','full-access'];
const savedApprovalPolicy=(value:unknown):ApprovalPolicy=>approvalPolicies.includes(value as ApprovalPolicy)?value as ApprovalPolicy:'on-request';
function isStoredRecord(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function hasValidStoredArrayFields(value:Record<string,any>,fields:string[]){return fields.every(field=>value[field]===undefined||Array.isArray(value[field]));}
function hasSupportedSettingsShape(value:unknown){
  if(value===undefined)return true;
  if(!isStoredRecord(value))return false;
  const optionalString=(field:string,max:number,allowEmpty=true)=>value[field]===undefined||typeof value[field]==='string'&&value[field].length<=max&&value[field]===value[field].trim()&&(allowEmpty||value[field].length>0);
  return optionalString('projectRoot',1024)&&optionalString('agentmemProjectId',64)&&(value.agentmemAutoSetup===undefined||typeof value.agentmemAutoSetup==='boolean')&&
    (value.agentmemProjectId===undefined||/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value.agentmemProjectId))&&
    optionalString('orchestratorModel',200,false)&&
    (value.orchestratorEffort===undefined||['low','medium','high','xhigh','max','ultra'].includes(value.orchestratorEffort))&&
    (value.approvalPolicy===undefined||approvalPolicies.includes(value.approvalPolicy));
}
const taskPhases:TaskPhase[]=['intake','routing','direct_running','simple_running','planning','worker_running','escalated','reviewing','accepted','needs_attention','cancelled','paused_after_restart'];
const workflowRoles:WorkflowRole[]=['router','direct','simple','orchestrator','worker'];
const activityRoles:ActivityRole[]=['direct','simple','orchestrator','worker'];
function isString(value:unknown){return typeof value==='string';}
function isOptionalString(value:Record<string,any>,field:string){return value[field]===undefined||isString(value[field]);}
function isDate(value:unknown){return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function strings(value:unknown){return Array.isArray(value)&&value.every(isString);}
function isAttachment(value:unknown){return isStoredRecord(value)&&isString(value.name)&&value.name.length>0&&value.name.length<=160&&['image/png','image/jpeg','image/webp','text/plain','text/markdown','text/csv','application/json'].includes(value.type)&&Number.isInteger(value.size)&&value.size>0&&value.size<=5*1024*1024&&isString(value.data)&&value.data.length<=Math.ceil(5*1024*1024*4/3)+8&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data);}
function isMessage(value:unknown,legacy:boolean){
  if(!isStoredRecord(value)||!isString(value.id)||!['user','router','direct','simple','orchestrator','worker','system'].includes(value.role)||!isString(value.text))return false;
  if(value.createdAt===undefined?!legacy:!isDate(value.createdAt))return false;
  return isOptionalString(value,'passId')&&(!value.attachments||Array.isArray(value.attachments)&&value.attachments.every(isAttachment))&&
    (value.submissionKind===undefined||value.submissionKind==='steering')&&
    (value.deliveryStatus===undefined||['pending','steered','unconfirmed'].includes(value.deliveryStatus));
}
function validRole(value:unknown){return workflowRoles.includes(value as WorkflowRole);}
function isSummary(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&['threadId','turnId','itemId','text'].every(k=>isString(value[k]))&&Number.isInteger(value.summaryIndex)&&isOptionalString(value,'passId')&&isOptionalString(value,'requestedModel')&&isOptionalString(value,'requestedEffort')&&isOptionalString(value,'effectiveModel')&&(value.updatedAt===undefined||isDate(value.updatedAt));}
function isReasoningTurn(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&isString(value.threadId)&&isString(value.turnId)&&isString(value.requestedModel)&&isString(value.requestedEffort)&&(value.effectiveModel===undefined||isString(value.effectiveModel))&&(value.startedAt===undefined||isDate(value.startedAt))&&['streaming','completed','interrupted','failed'].includes(value.status);}
function isLiveActivity(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&['threadId','turnId','itemId','itemType','title'].every(k=>isString(value[k]))&&isDate(value.startedAt)&&isDate(value.updatedAt)&&['commentary','tool'].includes(value.kind)&&['running','completed','failed','interrupted'].includes(value.status)&&['text','detail','output','passId'].every(k=>isOptionalString(value,k));}
function isRouteDecision(value:unknown){return isStoredRecord(value)&&['route','rule_id','justification','model','effort','speed','decidedAt'].every(k=>isString(value[k]))&&['direct_answer','simple_implementation','hard_task'].includes(value.route)&&isDate(value.decidedAt)&&(value.effectiveRoute===undefined||['direct_answer','simple_implementation','hard_task'].includes(value.effectiveRoute))&&(value.fallback===undefined||typeof value.fallback==='boolean');}
function isExecutionEscalation(value:unknown){return isStoredRecord(value)&&['direct_answer','simple_implementation'].includes(value.from)&&['simple_implementation','hard_task'].includes(value.to)&&isString(value.reason)&&strings(value.completedActions)&&strings(value.evidence);}
function isSavedSkill(value:unknown){return isStoredRecord(value)&&['id','revision','name','description','source','instructions'].every(k=>isString(value[k]))&&Array.isArray(value.files)&&value.files.every((file:any)=>isStoredRecord(file)&&isString(file.path)&&Number.isInteger(file.size)&&file.size>=0)&&(value.role===undefined||validRole(value.role))&&(value.loadedAt===undefined||isDate(value.loadedAt));}
function isAgentReceipt(value:unknown){return isStoredRecord(value)&&['simple','worker'].includes(value.producerRole)&&['threadId','turnId'].every(k=>isString(value[k]))&&isDate(value.recordedAt)&&Array.isArray(value.artifactRefs)&&value.artifactRefs.every(isString)&&receiptSchema.safeParse(value.receipt).success;}
function isTurnSourceChange(value:unknown){return isStoredRecord(value)&&['simple','worker'].includes(value.role)&&['threadId','turnId','workspaceRoot'].every(k=>isString(value[k]))&&['verified','unavailable'].includes(value.status)&&isDate(value.baselineCapturedAt)&&isDate(value.completedAt)&&strings(value.changedPaths)&&typeof value.repositoryRevisionChanged==='boolean'&&isOptionalString(value,'reason');}
function isAgentMemAudit(value:unknown){
  const contexts=(row:any)=>isStoredRecord(row)&&['id','purpose','queryHash'].every(k=>isString(row[k]))&&activityRoles.includes(row.role)&&['running','retrieved','supplied','failed','disabled','interrupted','pending'].includes(row.status)&&isDate(row.startedAt)&&isDate(row.updatedAt)&&['threadId','turnId','projectId','resultSummary','error'].every(k=>isOptionalString(row,k));
  const calls=(row:any)=>isStoredRecord(row)&&isString(row.id)&&['application','model'].includes(row.source)&&validRole(row.role)&&isString(row.method)&&['running','completed','failed','interrupted'].includes(row.status)&&isDate(row.startedAt)&&isDate(row.updatedAt)&&['contextId','purpose','projectId','repositoryId','threadId','turnId','resultSummary','error'].every(k=>isOptionalString(row,k))&&(row.service===undefined||['knowledge','repository_index','unknown'].includes(row.service))&&(row.operation===undefined||['read','write','unknown'].includes(row.operation));
  return isStoredRecord(value)&&typeof value.recorded==='boolean'&&(value.coverage===undefined||['full_pass','from_first_recorded_call'].includes(value.coverage))&&(value.selectedProjectId===null||isString(value.selectedProjectId))&&isString(value.workspaceRoot)&&['unknown','unverified','verified','mismatch','unavailable','disabled'].includes(value.identityStatus)&&['unknown','disabled','available','unavailable','no_calls_observed','observed'].includes(value.modelMcpStatus)&&Array.isArray(value.contexts)&&value.contexts.every(contexts)&&Array.isArray(value.calls)&&value.calls.every(calls)&&['verifiedProjectId','verifiedRoot','verifiedRepositoryId'].every(k=>isOptionalString(value,k));
}
function isPassUsage(value:unknown){
  if(!isStoredRecord(value))return false;
  const nullableNumber=(v:unknown)=>v===null||Number.isFinite(v);
  return Object.entries(value).every(([role,row]:[string,any])=>workflowRoles.includes(role as WorkflowRole)&&isStoredRecord(row)&&isString(row.threadId)&&['pending','available','unavailable'].includes(row.tokenStatus)&&['pending','available','unavailable'].includes(row.creditStatus)&&
    (row.tokens===undefined||isStoredRecord(row.tokens)&&['totalTokens','inputTokens','outputTokens'].every(k=>Number.isFinite(row.tokens[k]))&&['cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','modelContextWindow'].every(k=>nullableNumber(row.tokens[k]))&&['thread','thread-estimate'].includes(row.tokens.source))&&
    ['estimatedCreditsMicros','estimatedUsdMicros'].every(k=>row[k]===undefined||row[k]===null||isString(row[k]))&&(row.updatedAt===undefined||isDate(row.updatedAt))&&
    (row.groups===undefined||Array.isArray(row.groups)&&row.groups.every((group:any)=>isStoredRecord(group)&&['estimatedCreditsMicros'].every(k=>isString(group[k]))&&['model','reasoningEffort','speed','netNewInputTokens','cachedInputTokens','inputTokens','outputTokens','totalTokens'].every(k=>group[k]===null||isString(group[k]))))&&
    (row.allowance===undefined||isStoredRecord(row.allowance)&&['fiveHourPercent','weeklyPercent'].every(k=>nullableNumber(row.allowance[k]))&&['fiveHourWindow','weeklyWindow'].every(k=>row.allowance[k]===undefined||isStoredRecord(row.allowance[k])&&Number.isInteger(row.allowance[k].sampleCount)&&isDate(row.allowance[k].firstSampledAt)&&isDate(row.allowance[k].lastSampledAt)&&Number.isFinite(row.allowance[k].windowDurationMins)&&Number.isFinite(row.allowance[k].resetsAt)&&typeof row.allowance[k].boundariesChanged==='boolean')));
}
function isApprovalRequest(value:unknown){return isStoredRecord(value)&&(typeof value.requestId==='string'||typeof value.requestId==='number')&&['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','mcpServer/elicitation/request'].includes(value.method)&&['itemId','threadId','turnId'].every(k=>isString(value[k]))&&['reason','command','cwd','grantRoot','kind','networkHost','networkProtocol','serverName','mode','message','url'].every(k=>isOptionalString(value,k))&&(value.availableDecisions===undefined||strings(value.availableDecisions))&&(value.requestedSchema===undefined||isStoredRecord(value.requestedSchema));}
function isReceiptProvenance(value:unknown){return isStoredRecord(value)&&['simple','worker'].includes(value.producerRole)&&['threadId','turnId'].every(k=>isString(value[k]))&&isDate(value.recordedAt)&&Array.isArray(value.artifactRefs)&&value.artifactRefs.every(isString);}
function isGitDiff(value:unknown){return isStoredRecord(value)&&['recorded','partial'].includes(value.status)&&value.source==='codex-turn-diff'&&isDate(value.updatedAt)&&Array.isArray(value.turns)&&value.turns.every((row:any)=>isStoredRecord(row)&&['threadId','turnId','diff'].every(k=>isString(row[k]))&&['simple','orchestrator','worker'].includes(row.role)&&isDate(row.capturedAt)&&(row.truncated===undefined||typeof row.truncated==='boolean'));}
function hasValidNestedArrays(value:Record<string,any>){
  const arrays=(fields:string[],check:(row:unknown)=>boolean)=>fields.every(field=>value[field]===undefined||Array.isArray(value[field])&&value[field].every(check));
  if(!arrays(['reasoningSummaries'],isSummary)||!arrays(['reasoningTurns'],isReasoningTurn)||!arrays(['liveActivity'],isLiveActivity))return false;
  if(value.assignment!==undefined&&!assignmentSchema.safeParse(value.assignment).success||value.receipt!==undefined&&!receiptSchema.safeParse(value.receipt).success)return false;
  if(value.routeDecision!==undefined&&!isRouteDecision(value.routeDecision)||value.executionEscalation!==undefined&&!isExecutionEscalation(value.executionEscalation))return false;
  if(value.escalation!==undefined&&(!isStoredRecord(value.escalation)||!isString(value.escalation.decision_needed)||value.escalation.evidence!==undefined&&!strings(value.escalation.evidence)||value.escalation.options!==undefined&&!strings(value.escalation.options)||!isOptionalString(value.escalation,'recommendation')))return false;
  return true;
}
function hasSupportedPassShape(pass:unknown){
  if(!isStoredRecord(pass)||!isString(pass.id)||!Number.isInteger(pass.index)||pass.index<1||!isDate(pass.createdAt)||!isString(pass.userInput)||!strings(pass.userInputs)||!strings(pass.userMessageIds)||!taskPhases.includes(pass.phase)||!Number.isInteger(pass.correctionCount)||pass.correctionCount<0||!strings(pass.processedTurns))return false;
  if(!hasValidStoredArrayFields(pass,['userInputs','userMessageIds','attachments','selectedSkills','loadedSkills','savedSkills','processedTurns','reasoningSummaries','reasoningTurns','liveActivity','agentReceipts','turnSourceChanges']))return false;
  if(pass.attachments!==undefined&&!pass.attachments.every(isAttachment)||pass.selectedSkills!==undefined&&!pass.selectedSkills.every(isSavedSkill)||pass.loadedSkills!==undefined&&!pass.loadedSkills.every(isSavedSkill)||
    pass.savedSkills!==undefined&&!pass.savedSkills.every((row:any)=>isStoredRecord(row)&&['id','revision','name','description','source','role','savedAt'].every(k=>isString(row[k]))&&['create','update'].includes(row.action))||
    pass.agentReceipts!==undefined&&!pass.agentReceipts.every(isAgentReceipt)||pass.turnSourceChanges!==undefined&&!pass.turnSourceChanges.every(isTurnSourceChange)||!hasValidNestedArrays(pass))return false;
  if(pass.approvalPolicy!==undefined&&!approvalPolicies.includes(pass.approvalPolicy)||pass.agentContextVersion!==undefined&&!Number.isInteger(pass.agentContextVersion))return false;
  if(pass.activeRole!==undefined&&!validRole(pass.activeRole))return false;
  if(pass.agentmemAudit!==undefined&&!isAgentMemAudit(pass.agentmemAudit)||pass.receiptProvenance!==undefined&&!isReceiptProvenance(pass.receiptProvenance)||pass.usage!==undefined&&!isPassUsage(pass.usage)||pass.gitDiff!==undefined&&!isGitDiff(pass.gitDiff))return false;
  if(pass.workerStage!==undefined&&!['context_plan','context_compose','execute'].includes(pass.workerStage)||pass.workerContextStatus!==undefined&&(!isStoredRecord(pass.workerContextStatus)||!['retrieved','disabled','unavailable'].includes(pass.workerContextStatus.status)||!isString(pass.workerContextStatus.detail)))return false;
  if(pass.resolution!==undefined&&!['direct','simple','delegated'].includes(pass.resolution)||pass.legacyUnassociated!==undefined&&typeof pass.legacyUnassociated!=='boolean')return false;
  return ['routerThreadId','directThreadId','simpleThreadId','orchestratorThreadId','workerThreadId','activeTurnId','agentmemTaskId','agentmemLease','agentmemRecordStatus','agentmemRecordError','agentmemReceiptId','publicAnswer','reviewNote','routingNote','error','workerContextSummary'].every(field=>isOptionalString(pass,field));
}
function hasSupportedTaskShape(task:unknown,legacy:boolean){
  if(!isStoredRecord(task)||!isString(task.id)||!isString(task.title)||!taskPhases.includes(task.phase)||!isDate(task.createdAt)||!(isDate(task.updatedAt)||legacy&&task.updatedAt===undefined)||!(isString(task.userRoot)||legacy&&task.userRoot===undefined)||!isString(task.agentmemProjectId??'' )||!(strings(task.userMessages)||legacy&&task.userMessages===undefined)||!(Array.isArray(task.messages)&&task.messages.every(row=>isMessage(row,legacy))||legacy&&task.messages===undefined)||!(Number.isInteger(task.correctionCount)&&task.correctionCount>=0||legacy&&task.correctionCount===undefined)||!(strings(task.processedTurns)||legacy&&task.processedTurns===undefined))return false;
  if(!hasValidStoredArrayFields(task,['userMessages','messages','passes','processedTurns','reasoningSummaries','reasoningTurns','liveActivity','approvalRequests']))return false;
  if(task.passes!==undefined&&!task.passes.every(hasSupportedPassShape)||!hasValidNestedArrays(task))return false;
  if(task.approvalRequests!==undefined&&!task.approvalRequests.every(isApprovalRequest))return false;
  if(task.workspaceCommand!==undefined&&(!isStoredRecord(task.workspaceCommand)||!isString(task.workspaceCommand.id)||!['browser','github'].includes(task.workspaceCommand.mode)||!['side','full'].includes(task.workspaceCommand.placement)||!isDate(task.workspaceCommand.createdAt)||!isOptionalString(task.workspaceCommand,'url')||task.workspaceCommand.url!==undefined&&!safeWorkspaceUrl(task.workspaceCommand.url)))return false;
  if(task.githubLink!==undefined&&(!isStoredRecord(task.githubLink)||!isString(task.githubLink.repository)||!isString(task.githubLink.branch)||!isDate(task.githubLink.updatedAt)||!isOptionalString(task.githubLink,'baseBranch')||!isOptionalString(task.githubLink,'pullRequestUrl')))return false;
  if(task.activeRole!==undefined&&!validRole(task.activeRole))return false;
  if(task.workerStage!==undefined&&!['context_plan','context_compose','execute'].includes(task.workerStage)||task.workerContextStatus!==undefined&&(!isStoredRecord(task.workerContextStatus)||!['retrieved','disabled','unavailable'].includes(task.workerContextStatus.status)||!isString(task.workerContextStatus.detail))||task.resolution!==undefined&&!['direct','simple','delegated'].includes(task.resolution)||task.allowDirectResponse!==undefined&&typeof task.allowDirectResponse!=='boolean'||task.pendingRevision!==undefined&&typeof task.pendingRevision!=='boolean')return false;
  if(task.passes?.length&&task.currentPassId!==undefined&&!task.passes.some((pass:any)=>pass.id===task.currentPassId))return false;
  if(task.projectId!==undefined&&!isUuid(task.projectId))return false;
  if(task.lastInteractedAt!==undefined&&!isDate(task.lastInteractedAt))return false;
  return ['currentPassId','activeTurnId','routerThreadId','directThreadId','simpleThreadId','orchestratorThreadId','workerThreadId','agentmemTaskId','agentmemLease','agentmemRecordStatus','agentmemRecordError','agentmemReceiptId','activeModelId','activeEffort','error','workerContextSummary','routingNote','reviewNote'].every(field=>isOptionalString(task,field));
}
const isUuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function isProject(value:unknown){return isStoredRecord(value)&&isUuid(value.id)&&isString(value.name)&&value.name.trim().length>0&&value.name.length<=80&&isString(value.projectRoot)&&value.projectRoot.length<=1024&&isString(value.agentmemProjectId)&&/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value.agentmemProjectId)&&typeof value.agentmemEnabled==='boolean'&&typeof value.agentmemAutoSetup==='boolean'&&(!value.agentmemEnabled&&!value.agentmemProjectId||value.agentmemEnabled&&(!!value.agentmemProjectId||value.agentmemAutoSetup))&&typeof value.pinned==='boolean'&&isDate(value.createdAt)&&isDate(value.updatedAt);}
function safeWorkspaceUrl(value:unknown){try{return normalizeAgentWorkspaceUrl(value)===value;}catch{return false;}}
function hasSupportedStoredShape(value:any){
  if(!isStoredRecord(value)||![1,2,3].includes(value.version)||!Array.isArray(value.tasks))return false;
  if(!hasSupportedSettingsShape(value.settings))return false;
  if(value.activeTaskId!==undefined&&value.activeTaskId!==null&&typeof value.activeTaskId!=='string')return false;
  if(value.version===3&&(!Array.isArray(value.projects)||!value.projects.every(isProject)||new Set(value.projects.map((project:any)=>project.id)).size!==value.projects.length||value.selectedProjectId!==null&&!isUuid(value.selectedProjectId)||!Array.isArray(value.expandedProjectIds)||!value.expandedProjectIds.every((id:any)=>id==='unclassified'||isUuid(id))||value.selectedProjectId&&!value.projects.some((project:any)=>project.id===value.selectedProjectId)||value.tasks.some((task:any)=>task.projectId&&!value.projects.some((project:any)=>project.id===task.projectId))))return false;
  return value.tasks.every((task:any)=>hasSupportedTaskShape(task,value.version===1));
}

export function loadState(): Promise<State> {
  if (loaded) return Promise.resolve(structuredClone(current));
  if(stateLoading)return stateLoading;
  const operation=loadStateOnce();
  stateLoading=operation;
  return operation.finally(()=>{if(stateLoading===operation)stateLoading=undefined;});
}

async function loadStateOnce(): Promise<State> {
  await mkdir(dataDir, { recursive: true });
  let source:string;
  try { source=await readFile(statePath, 'utf8'); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`Could not read Pseudoharness local state at ${statePath}. Check that the file is readable; its contents were left unchanged.`,{cause:error});
    loaded=true;
    return structuredClone(current);
  }
  let value:any;
  try { value=JSON.parse(source); }
  catch(error) { throw new Error(`Pseudoharness local state at ${statePath} is malformed. Preserve or repair this file before restarting; it will not be replaced automatically.`,{cause:error}); }
  if (!hasSupportedStoredShape(value)) {
    throw new Error(`Pseudoharness local state at ${statePath} has an unsupported format. Preserve or restore a supported state file before restarting; it will not be replaced automatically.`);
  }
  try {
    const containedRawReasoning=value.tasks.some((task:any)=>Array.isArray(task.reasoningRawContent)&&task.reasoningRawContent.length>0||Array.isArray(task.passes)&&task.passes.some((pass:any)=>Array.isArray(pass.reasoningRawContent)&&pass.reasoningRawContent.length>0));
    current = upgradeStoredState(value);
    // Validate the normalized state too. Version-specific shape validation
    // permits only explicit migration defaults; consumers receive a complete
    // current-version state after upgrade.
    if(!hasSupportedStoredShape(current))throw new Error('The migrated state does not satisfy the current state schema.');
    if(containedRawReasoning||value.version!==3){const tmp=`${statePath}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(current,null,2),{mode:0o600});await rename(tmp,statePath);}
  } catch(error) {
    current=structuredClone(defaults);
    throw new Error(`Pseudoharness local state at ${statePath} could not be migrated safely. Preserve or repair this file before restarting; it will not be replaced automatically.`,{cause:error});
  }
  loaded = true;
  return structuredClone(current);
}
export function upgradeStoredState(value:any):State{
  let migratedProjects:Project[]=Array.isArray(value.projects)?value.projects.filter(isProject).map((row:any)=>({...row})):[];
  let selectedProjectId: string|null=typeof value.selectedProjectId==='string'?value.selectedProjectId:null;
  if(value.version!==3&&value.settings?.projectRoot){
    const now=new Date().toISOString();const id=randomUUID();
    migratedProjects=[{id,name:path.basename(value.settings.projectRoot.replace(/[\\/]+$/,''))||'Project',projectRoot:value.settings.projectRoot,agentmemProjectId:value.settings.agentmemProjectId||'',agentmemEnabled:!!value.settings.agentmemProjectId||!!value.settings.agentmemAutoSetup,agentmemAutoSetup:!!value.settings.agentmemAutoSetup,pinned:false,createdAt:now,updatedAt:now}];selectedProjectId=id;
  }
  if(selectedProjectId&&!migratedProjects.some(row=>row.id===selectedProjectId))selectedProjectId=null;
  const tasks=(value.tasks||[]).map((t:any)=>{
    const task={...t,agentmemProjectId:typeof t.agentmemProjectId==='string'?t.agentmemProjectId:(value.settings?.agentmemProjectId||defaults.settings.agentmemProjectId)} as Task;
    if(value.version===1){
      task.userRoot=typeof t.userRoot==='string'?t.userRoot:value.settings?.projectRoot||'';
      task.userMessages=Array.isArray(t.userMessages)?t.userMessages:[];
      task.messages=Array.isArray(t.messages)?t.messages:[];
      task.updatedAt=typeof t.updatedAt==='string'?t.updatedAt:task.createdAt;
      task.correctionCount=Number.isInteger(t.correctionCount)&&t.correctionCount>=0?t.correctionCount:0;
      task.processedTurns=Array.isArray(t.processedTurns)?t.processedTurns:[];
      for(const message of task.messages)if(!message.createdAt)message.createdAt=task.createdAt;
    }
    if(!isDate(task.lastInteractedAt)){const lastUserTime=(task.messages||[]).reduce((latest:number,message:any)=>message.role==='user'&&isDate(message.createdAt)?Math.max(latest,Date.parse(message.createdAt)):latest,Date.parse(task.createdAt));task.lastInteractedAt=new Date(lastUserTime).toISOString();}
    if(!Array.isArray(task.passes)||task.passes.length===0){
      task.passes=[{id:randomUUID(),index:1,createdAt:task.createdAt,userInput:task.userMessages?.[0]||task.title,userInputs:[...(task.userMessages||[])],userMessageIds:[],phase:task.phase,approvalPolicy:savedApprovalPolicy(value.settings?.approvalPolicy),legacyUnassociated:true,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,reasoningSummaries:task.reasoningSummaries,reasoningTurns:task.reasoningTurns,liveActivity:task.liveActivity,correctionCount:task.correctionCount||0,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,processedTurns:[...(task.processedTurns||[])],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId}];
      task.currentPassId=undefined;
    }
    for(const pass of task.passes){pass.approvalPolicy=savedApprovalPolicy(pass.approvalPolicy??value.settings?.approvalPolicy);if(pass.agentContextVersion!==1)pass.agentContextVersion=0;}
    for(const message of task.messages||[])if(message.role==='user'&&message.submissionKind==='steering'&&message.deliveryStatus==='pending'){message.deliveryStatus='unconfirmed';const pass=task.passes.find(row=>row.id===message.passId);if(pass&&!pass.userMessageIds.includes(message.id)){pass.userInputs.push(message.text);pass.userMessageIds.push(message.id);pass.attachments=[...(pass.attachments||[]),...(message.attachments||[])];}if(!task.userMessages.includes(message.text))task.userMessages.push(message.text);}
    const current=task.passes.find(pass=>pass.id===task.currentPassId);
    if(['routing','direct_running','simple_running','planning','worker_running','reviewing'].includes(t.phase)){
      task.phase='paused_after_restart';task.activeRole=undefined;task.activeTurnId=undefined;task.approvalRequests=[];
      task.error=current?.agentContextVersion===1?'The process restarted during this turn. Resume explicitly after checking the Codex agent thread.':'This session used an older Codex thread and cannot be resumed with the current Pseudoharness role configuration. Send a follow-up to start a fresh pass.';
      for(const turn of task.reasoningTurns||[])if(turn.status==='streaming')turn.status='interrupted';
      const interruptedAt=new Date().toISOString();for(const activity of task.liveActivity||[])if(activity.status==='running'){activity.status='interrupted';activity.updatedAt=interruptedAt;}
      for(const pass of task.passes||[]){for(const context of pass.agentmemAudit?.contexts||[])if(context.status==='running'){context.status='interrupted';context.updatedAt=interruptedAt;}for(const call of pass.agentmemAudit?.calls||[])if(call.status==='running'){call.status='interrupted';call.updatedAt=interruptedAt;}}
    }
    delete (task as any).reasoningRawContent;
    for(const pass of task.passes||[])delete (pass as any).reasoningRawContent;
    syncCurrentPass(task);
    return task;
  });
  return {...defaults,...value,version:3,settings:{...defaults.settings,...value.settings,approvalPolicy:savedApprovalPolicy(value.settings?.approvalPolicy)},tasks,projects:migratedProjects,selectedProjectId,expandedProjectIds:Array.isArray(value.expandedProjectIds)?value.expandedProjectIds.filter((id:string)=>id==='unclassified'||migratedProjects.some(row=>row.id===id)):[...migratedProjects.map(row=>row.id),'unclassified']};
}
export function getState() { return structuredClone(current); }
export function getTask(id: string) { return current.tasks.find(t => t.id === id); }
export function selectProjectInState(state:State,id:string|null){if(id!==null&&!state.projects.some(project=>project.id===id))throw new Error('Project not found.');state.selectedProjectId=id;return id===null?null:state.projects.find(project=>project.id===id)!;}
export function saveProjectInState(state:State,input:Omit<Project,'createdAt'|'updatedAt'> & Partial<Pick<Project,'createdAt'|'updatedAt'>>){
  if(!input.id||input.id.length>128||!input.name.trim()||input.name.trim().length>80||input.projectRoot.length>1024||!/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(input.agentmemProjectId))throw new Error('Enter a valid project name, root, and AgentMem ID.');
  const existing=state.projects.find(project=>project.id===input.id);const now=new Date().toISOString();
  const project:Project={id:input.id,name:input.name.trim(),projectRoot:input.projectRoot,agentmemProjectId:input.agentmemEnabled?input.agentmemProjectId:'',agentmemEnabled:input.agentmemEnabled,agentmemAutoSetup:input.agentmemEnabled&&input.agentmemAutoSetup,pinned:!!input.pinned,createdAt:existing?.createdAt||input.createdAt||now,updatedAt:now};
  if(existing)state.projects=state.projects.map(row=>row.id===project.id?project:row);else state.projects.push(project);
  return project;
}
export function moveTaskProjectInState(state:State,taskId:string,projectId:string|null){
  const task=state.tasks.find(row=>row.id===taskId);if(!task)throw new Error('Session not found.');
  if(projectId!==null&&!state.projects.some(project=>project.id===projectId))throw new Error('Project not found.');
  const waitingForAgentmem=[task,...(task.passes||[])].some(row=>row.agentmemRecordStatus==='saving'||row.agentmemRecordStatus==='in_progress'||!!row.agentmemLease);
  const blocked=['intake','routing','direct_running','simple_running','planning','worker_running','reviewing','escalated','paused_after_restart'].includes(task.phase)||!!task.activeTurnId||!!task.activeRole||!!task.approvalRequests?.length||waitingForAgentmem;
  if(blocked)throw new Error(waitingForAgentmem?'Wait for AgentMem receipt completion before moving this session.':'Stop or finish this session, resolve approvals, or explicitly resume it before moving projects. Its current execution keeps the original project context.');
  task.projectId=projectId||undefined;
  if(projectId){const project=state.projects.find(row=>row.id===projectId)!;task.userRoot=project.projectRoot;task.agentmemProjectId=project.agentmemEnabled?project.agentmemProjectId:'';}else{task.userRoot=state.settings.projectRoot||task.userRoot;task.agentmemProjectId=state.settings.agentmemProjectId;}
  task.lastInteractedAt=new Date().toISOString();return task;
}
export function noteTaskInteractionInState(state:State,taskId:string){const task=state.tasks.find(row=>row.id===taskId);if(task)task.lastInteractedAt=new Date().toISOString();}
export function taskDeletionBlockReason(task:Task){
  if(['intake','routing','direct_running','simple_running','planning','worker_running','reviewing','escalated'].includes(task.phase)||task.activeTurnId||task.activeRole)return 'Stop or finish the active turn before deleting this session.';
  const records=[task,...(task.passes||[])];
  if(records.some(x=>x.agentmemRecordStatus==='saving'||!!x.agentmemLease))return 'Wait for AgentMem receipt completion before deleting this session.';
  return null;
}
export function renameTaskInState(state:State,id:string,title:string){
  const task=state.tasks.find(x=>x.id===id);if(!task)throw new Error('Session not found.');
  task.title=title;task.updatedAt=new Date().toISOString();task.lastInteractedAt=task.updatedAt;return task;
}
export function deleteTaskInState(state:State,id:string){
  const task=state.tasks.find(x=>x.id===id);if(!task)throw new Error('Session not found.');
  const blocked=taskDeletionBlockReason(task);if(blocked)throw new Error(blocked);
  state.tasks=state.tasks.filter(x=>x.id!==id);if(state.activeTaskId===id)state.activeTaskId=null;return task;
}
export function subscribe(fn: (s: State) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export async function mutate(fn: (state: State) => void) {
  await loadState();
  const operation=writeQueue.then(async()=>{
    const rollback=structuredClone(current);
    try {
      fn(current); current.version=3; current.tasks.forEach(syncCurrentPass); current.tasks.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
      await mkdir(dataDir,{recursive:true});
      const tmp=`${statePath}.${randomUUID()}.tmp`;
      try { await writeFile(tmp,JSON.stringify(current,null,2),{mode:0o600}); await rename(tmp,statePath); }
      catch(error) { try { await rm(tmp,{force:true}); } catch { /* Preserve the original persistence error. */ } throw error; }
    } catch(error) {
      // A failed persistence operation must not become visible as committed
      // state. The caller receives the original error and can safely retry.
      current=rollback;
      throw error;
    }
    for(const listener of listeners)listener(getState());
    return getState();
  });
  // Keep the caller's operation rejected on failure, while recovering the
  // internal queue so a later mutation can retry persistence.
  writeQueue=operation.then(()=>undefined,()=>undefined);
  return operation;
}
export async function createTask(message: string, root: string, agentmemProjectId: string, approvalPolicy:ApprovalPolicy='on-request',attachments:TaskAttachment[]=[],projectId?:string ) {
  const now = new Date().toISOString(); const id = randomUUID();
  const task: Task = { id, ...(projectId?{projectId}:{}),lastInteractedAt:now,title: message.slice(0, 72)||attachments[0]?.name||'Image task', phase: 'intake', createdAt: now, updatedAt: now, userRoot: root, agentmemProjectId, userMessages: [message], correctionCount: 0, processedTurns: [], messages: [{id:randomUUID(),role:'user',text:message,createdAt:now,attachments}] };
  beginPass(task,message,task.messages[0].id,approvalPolicy,attachments);
  await mutate(s => { s.tasks.unshift(task); s.activeTaskId=id; }); return task;
}
export async function createTaskForProject(message:string,projectId:string|null|undefined,attachments:TaskAttachment[]=[],selectedSkills:SavedSkillSnapshot[]=[]){
  const id=randomUUID();
  await mutate(state=>{
    const selectedId=projectId===undefined?state.selectedProjectId:projectId;
    const project=selectedId?state.projects.find(row=>row.id===selectedId):undefined;
    if(selectedId&&!project)throw new Error('The selected project no longer exists. Select a project again before starting a session.');
    const root=project?.projectRoot||state.settings.projectRoot;
    if(!root)throw new Error('Choose or create a project before starting a task.');
    const agentmemProjectId=project?(project.agentmemEnabled?project.agentmemProjectId:''):state.settings.agentmemProjectId;
    const approvalPolicy=state.settings.approvalPolicy;const now=new Date().toISOString();const firstMessage={id:randomUUID(),role:'user' as const,text:message,createdAt:now,...(attachments.length?{attachments:structuredClone(attachments)}:{})};
    const created:Task={id,title:message.slice(0,72)||attachments[0]?.name||'Image task',phase:'intake',createdAt:now,updatedAt:now,lastInteractedAt:now,...(project?{projectId:project.id}:{}),userRoot:root,agentmemProjectId,userMessages:[message],correctionCount:0,processedTurns:[],messages:[firstMessage]};
    beginPass(created,message,firstMessage.id,approvalPolicy,attachments,selectedSkills);state.tasks.unshift(created);state.activeTaskId=id;
  });
  return getTask(id)!;
}
export function beginPass(task:Task,message:string,userMessageId?:string,approvalPolicy:ApprovalPolicy='on-request',attachments:TaskAttachment[]=[],selectedSkills:SavedSkillSnapshot[]=[]){
  const now=new Date().toISOString();const pass:TaskPass={id:randomUUID(),index:(task.passes?.reduce((n,p)=>Math.max(n,p.index),0)||0)+1,createdAt:now,userInput:message,userInputs:[message],userMessageIds:userMessageId?[userMessageId]:[],attachments,selectedSkills:structuredClone(selectedSkills),loadedSkills:[],phase:'intake',agentmemAudit:{recorded:true,coverage:'full_pass',selectedProjectId:task.agentmemProjectId||null,workspaceRoot:task.userRoot,identityStatus:task.agentmemProjectId?'unverified':'disabled',modelMcpStatus:'unknown',contexts:[],calls:[]},approvalPolicy,agentContextVersion:1,correctionCount:0,processedTurns:[]};
  task.passes=[...(task.passes||[]),pass];task.currentPassId=pass.id;
  task.phase='intake';task.routeDecision=undefined;task.executionEscalation=undefined;task.assignment=undefined;task.receipt=undefined;task.reviewNote=undefined;task.resolution=undefined;task.routingNote=undefined;task.workerStage=undefined;task.workerContextStatus=undefined;task.workerContextSummary=undefined;task.reasoningSummaries=[];task.reasoningTurns=[];task.liveActivity=[];task.activeModelId=undefined;task.activeEffort=undefined;task.correctionCount=0;task.routerThreadId=undefined;task.directThreadId=undefined;task.simpleThreadId=undefined;task.orchestratorThreadId=undefined;task.workerThreadId=undefined;task.activeTurnId=undefined;task.activeRole=undefined;task.processedTurns=[];task.error=undefined;task.escalation=undefined;task.approvalRequests=[];task.agentmemTaskId=undefined;task.agentmemLease=undefined;task.agentmemRecordStatus=undefined;task.agentmemRecordError=undefined;task.agentmemReceiptId=undefined;task.pendingRevision=false;
  if(userMessageId){const msg=task.messages.find(m=>m.id===userMessageId);if(msg)msg.passId=pass.id;}
  return pass;
}
export function currentPass(task:Task){return task.passes?.find(p=>p.id===task.currentPassId);}
export function passForThread(task:Task,threadId:string){return task.passes?.find(p=>[p.routerThreadId,p.directThreadId,p.simpleThreadId,p.orchestratorThreadId,p.workerThreadId].includes(threadId));}
export function isCurrentPassThread(task:Task,threadId:string){const pass=currentPass(task);return !!pass&&[pass.routerThreadId,pass.directThreadId,pass.simpleThreadId,pass.orchestratorThreadId,pass.workerThreadId].includes(threadId);}
export function passThreadRole(pass:TaskPass,threadId:string):WorkflowRole|undefined{return (['router','direct','simple','orchestrator','worker'] as const).find(role=>pass[`${role}ThreadId` as 'routerThreadId'|'directThreadId'|'simpleThreadId'|'orchestratorThreadId'|'workerThreadId']===threadId);}
export function syncCurrentPass(task:Task){
  const p=currentPass(task);if(!p)return;
  Object.assign(p,{phase:task.phase,routeDecision:task.routeDecision,executionEscalation:task.executionEscalation,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,workerStage:task.workerStage,workerContextStatus:task.workerContextStatus,workerContextSummary:task.workerContextSummary,reasoningSummaries:structuredClone(task.reasoningSummaries||[]),reasoningTurns:structuredClone(task.reasoningTurns||[]),liveActivity:structuredClone(task.liveActivity||[]),correctionCount:task.correctionCount,routerThreadId:task.routerThreadId,directThreadId:task.directThreadId,simpleThreadId:task.simpleThreadId,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,activeTurnId:task.activeTurnId,activeRole:task.activeRole,processedTurns:[...task.processedTurns],agentmemTaskId:task.agentmemTaskId,agentmemLease:task.agentmemLease,agentmemRecordStatus:task.agentmemRecordStatus,agentmemRecordError:task.agentmemRecordError,agentmemReceiptId:task.agentmemReceiptId});
}
export function addMessage(task: Task, role: Message['role'], text: string, attachments?:TaskAttachment[],passId=task.currentPassId,id:string=randomUUID(),submissionKind?:Message['submissionKind'],deliveryStatus?:Message['deliveryStatus']) { const message:Message={id,role,text,createdAt:new Date().toISOString(),...(passId?{passId}:{}),...(attachments?.length?{attachments:structuredClone(attachments)}:{}),...(submissionKind?{submissionKind}:{}),...(deliveryStatus?{deliveryStatus}:{})};task.messages.push(message);task.updatedAt = message.createdAt;if(role==='user')task.lastInteractedAt=message.createdAt;return message; }
