import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccessMode, ApprovalPolicy, Assignment, Receipt } from './contracts.js';
import type { TaskAttachment } from './attachments.js';
import type { DeepSeekHarnessMcpToolCatalog, DeepSeekHarnessRuntimeInfo } from './deepseek-harness.js';
import { stateDirectory } from './paths.js';
import { accessModeFromApproval, assignmentSchema, forgeAccessModeOf, receiptSchema, runtimeApprovalForAccess } from './contracts.js';
import { normalizeAgentWorkspaceUrl } from './workspace-tools.js';
import { createToolCallLog, interruptRunningToolCalls, recordToolCall, type ToolCallEvent, type ToolCallLog } from './tool-call-log.js';
import { qualityCorrectionPlannerMayHaveBeenSent, qualityLoopResumeAction, type QACorrectionPlannerDispatch } from './quality-loop-resume.js';
import { assertProjectIdentityChangeAllowed, projectPathKey, sameProjectRoot } from './project-identity.js';
import { forgeTicketSchema } from './forge-contracts.js';
import { applyForgeCommand, createForgeTicket } from './forge-state.js';
import type { ForgeCommand, ForgeTicket, ForgeTicketCreateInput } from './forge-contracts.js';
import { mcpServerRegistrationsSchema, type McpServerRegistration } from './mcp-registration.js';
import { migrateLegacyStateDirectory } from './state-directory-migration.js';

export type TaskPhase = 'intake' | 'routing' | 'direct_running' | 'simple_running' | 'planning' | 'worker_running' | 'escalated' | 'reviewing' | 'accepted' | 'needs_attention' | 'cancelled' | 'paused_after_restart';
export type WorkflowRole='router'|'direct'|'simple'|'orchestrator'|'worker';
export type Message = { id: string; role: 'user'|'router'|'direct'|'simple'|'orchestrator'|'worker'|'system'; text: string; createdAt: string; passId?:string; attachments?:TaskAttachment[]; submissionKind?:'steering'; deliveryStatus?:'pending'|'steered'|'unconfirmed' };
export type ActivityRole='direct'|'simple'|'orchestrator'|'worker';
export type DeepSeekExecutionProfile={kind:'deepseek-harness-sdk';provider:string;model:string;nativeReasoningEffort:string};
export type DeepSeekConversationStoragePreference={mode:'native'|'isolated';directory?:string};
export type ExecutionProfile={provider:'codex'|'deepseek';model:string;effort:'low'|'medium'|'high'|'xhigh'|'max'|'ultra'};
export type DeepSeekProviderEventSummary={type:string;sequence?:number;turn?:number;step?:number;status?:string;messageRole?:string;contentBlockTypes?:string[];textCharacters?:number;toolName?:string;toolCallId?:string;sourceEventSequences?:number[];toolError?:boolean;hasError?:boolean;errorCode?:string;dataKeys?:string[];reasonKeys?:string[];reasonKind?:string;reasonErrorName?:string;reasonErrorCode?:string;reasonErrorMessagePresent?:boolean};
export type DeepSeekPhaseRun={stage:'execute';sessionId:string;turnId:string;provider:string;model:string;requestedProviderRoute?:string;requestedReasoningEffort?:string;permissionMode:DeepSeekHarnessRuntimeInfo['permissionMode'];approvalPolicy:ApprovalPolicy;workspaceRoot:string;writeScope:string[];access:DeepSeekHarnessRuntimeInfo['access'];filesystemScope:DeepSeekHarnessRuntimeInfo['filesystemScope'];status:'running'|'completed'|'interrupted'|'failed';startedAt:string;updatedAt:string;profileName?:string;configuredMcpServers?:string[];mcpToolCatalog?:DeepSeekHarnessMcpToolCatalog;providerEvents?:DeepSeekProviderEventSummary[];serverInfo?:{name:string;version:string};harnessVersion?:string;capabilities?:DeepSeekHarnessRuntimeInfo['capabilities'];error?:string};
export type ReasoningSummary = { role:ActivityRole; threadId:string; turnId:string; itemId:string; summaryIndex:number; text:string; passId?:string; provider?:string; requestedModel?:string; requestedEffort?:string; effectiveModel?:string; updatedAt?:string };
export type LiveActivity = { role:ActivityRole; threadId:string; turnId:string; itemId:string; kind:'commentary'|'tool'; itemType:string; title:string; text?:string; detail?:string; output?:string; status:'running'|'completed'|'failed'|'interrupted'; startedAt:string; updatedAt:string; passId?:string };
export type ReasoningTurn = { role:ActivityRole; threadId:string; turnId:string; provider?:string; requestedModel:string; requestedEffort:string; effectiveModel?:string; startedAt?:string; status:'streaming'|'completed'|'interrupted'|'failed' };
export type PassTokenUsage = { totalTokens:number; inputTokens:number; cachedInputTokens:number|null; cacheWriteInputTokens:number|null; outputTokens:number; reasoningOutputTokens:number|null; modelContextWindow:number|null; source:'thread'|'thread-estimate' };
export type PassUsageGroup = { model:string|null; reasoningEffort:string|null; speed:string|null; estimatedCreditsMicros:string; netNewInputTokens:string|null; cachedInputTokens:string|null; inputTokens:string|null; outputTokens:string|null; totalTokens:string|null };
export type PassAllowanceWindow = { sampleCount:number; firstSampledAt:string; lastSampledAt:string; windowDurationMins:number; resetsAt:number; boundariesChanged:boolean };
export type PassAllowanceUsage = { fiveHourPercent:number|null; weeklyPercent:number|null; fiveHourWindow?:PassAllowanceWindow; weeklyWindow?:PassAllowanceWindow };
export type PassRoleUsage = { threadId:string; tokenStatus:'pending'|'available'|'unavailable'; tokens?:PassTokenUsage; creditStatus:'pending'|'available'|'unavailable'; estimateSource?:'codex-app-server-thread-usage'; estimatedCreditsMicros?:string; estimatedUsdMicros?:string|null; allowance?:PassAllowanceUsage; groups?:PassUsageGroup[]; updatedAt?:string };
export type PassUsage = Partial<Record<WorkflowRole,PassRoleUsage>>;
export type AgentMemAuditCall={id:string;source:'application'|'model';role:WorkflowRole;method:string;status:'running'|'completed'|'failed'|'interrupted';startedAt:string;updatedAt:string;contextId?:string;purpose?:string;projectId?:string;repositoryId?:string;threadId?:string;turnId?:string;providerEventSequence?:number;service?:'knowledge'|'repository_index'|'unknown';operation?:'read'|'write'|'unknown';resultSummary?:string;error?:string};
export type AgentMemAuditContext={id:string;role:ActivityRole;purpose:string;queryHash:string;status:'running'|'retrieved'|'supplied'|'failed'|'disabled'|'interrupted'|'pending';startedAt:string;updatedAt:string;threadId?:string;turnId?:string;projectId?:string;resultSummary?:string;error?:string};
export type AgentMemRepositoryBinding={root:string;repositoryId:string;threadId?:string;purpose:string;registeredAt:string};
export type AgentMemAudit={recorded:boolean;coverage?:'full_pass'|'from_first_recorded_call';selectedProjectId:string|null;workspaceRoot:string;identityStatus:'unknown'|'unverified'|'verified'|'mismatch'|'unavailable'|'disabled';verifiedProjectId?:string;verifiedRoot?:string;verifiedRepositoryId?:string;repositories?:AgentMemRepositoryBinding[];modelMcpStatus:'unknown'|'disabled'|'available'|'unavailable'|'no_calls_observed'|'observed';contexts:AgentMemAuditContext[];calls:AgentMemAuditCall[]};
export type ReceiptProducerRole='simple'|'worker'|'integrator';
export type ReceiptProvenance={producerRole:ReceiptProducerRole;threadId:string;turnId:string;recordedAt:string;artifactRefs:string[];origin?:'model_turn'|'application_failure'|'application_status';workerId?:string;teamId?:string;passId?:string};
export type AgentReceiptRecord=ReceiptProvenance&{receipt:Receipt};
export type TurnSourceChangeRecord={role:'simple'|'worker';threadId:string;turnId:string;status:'verified'|'unavailable';workspaceRoot:string;baselineCapturedAt:string;completedAt:string;changedPaths:string[];repositoryRevisionChanged:boolean;reason?:string};
export type RecruitmentStatus='recruiting'|'running'|'integrating'|'complete'|'failed'|'cancelled'|'needs_attention'|'paused_after_restart';
export type RecruitmentWorkerStatus='queued'|'running'|'complete'|'escalated'|'failed'|'blocked'|'cancelled'|'paused_after_restart';
export type RecruitmentWorker={workerId:string;name:string;step?:string;dependsOn?:string[];assignment:Assignment;effort:'high'|'xhigh'|'max';skills:SavedSkillSnapshot[];branch?:string;worktreeRoot?:string;status:RecruitmentWorkerStatus;workerStage?:'execute';executionProfile?:ExecutionProfile;deepSeekExecution?:DeepSeekExecutionProfile;deepSeekRuntime?:DeepSeekHarnessRuntimeInfo;deepSeekPhaseRuns?:DeepSeekPhaseRun[];threadId?:string;activeTurnId?:string;headCommit?:string;startedAt?:string;executionStartedAt?:string;completedAt?:string;receipt?:Receipt;error?:string};
export type RecruitmentIntegration={status:'queued'|'preparing'|'running'|'complete'|'failed'|'cancelled'|'paused_after_restart'|'not_required';branch?:string;worktreeRoot?:string;assignment?:Assignment;effort?:'high'|'xhigh'|'max';skills?:SavedSkillSnapshot[];workerStage?:'execute';executionProfile?:ExecutionProfile;deepSeekExecution?:DeepSeekExecutionProfile;deepSeekRuntime?:DeepSeekHarnessRuntimeInfo;deepSeekPhaseRuns?:DeepSeekPhaseRun[];threadId?:string;activeTurnId?:string;headCommit?:string;startedAt?:string;executionStartedAt?:string;completedAt?:string;receipt?:Receipt;error?:string};
export type WorkerReceiptBundleRecord={workerId:string;name:string;status:RecruitmentWorkerStatus;branch?:string;headCommit:string|null;receipt:Receipt;producer:ReceiptProvenance|null};
export type RecruitmentTeam={teamId:string;passId:string;createdAt:string;canonicalProjectRoot:string;mode?:'worktree'|'read_only';workspaceParent?:string;baseRef?:string;baseCommit?:string;status:RecruitmentStatus;sealed:boolean;workers:RecruitmentWorker[];integration:RecruitmentIntegration;toolCallIds:string[];completionWakeSent:boolean;workerReceiptBundle?:WorkerReceiptBundleRecord[];integrationReceiptProducer?:ReceiptProvenance;combinedReceipt?:Receipt;legacyAgentMem?:Record<string,unknown>};
export type QAFinding={findingId:string;fingerprint:string;title:string;severity:'critical'|'high'|'medium'|'low';issue:string;requiredFix:string;evidence:string[];file?:string;line?:number};
export type QAAuditRound={roundId:string;index:number;status:'starting'|'auditing'|'completed'|'awaiting_corrections'|'correcting'|'interrupted'|'failed'|'paused_after_restart';createdAt:string;startedAt:string;completedAt?:string;threadId?:string;turnId?:string;model:'gpt-6.1-terra';requestedEffort:'high';reportedModel?:string;reportedEffort?:string;workspaceRoot:string;integrationBranch:string;integrationHead:string;summary?:string;resultStatus?:'issues_found'|'no_actionable_issues';findings?:QAFinding[];findingsFingerprint?:string;teamId?:string;error?:string};
export type QualityLoop={enabled:boolean;status:'disabled'|'awaiting_audit'|'auditing'|'awaiting_corrections'|'correcting'|'complete'|'user_accepted'|'needs_attention'|'paused'|'paused_after_restart'|'cancelled';rounds:QAAuditRound[];maxRounds:number;terminalReason?:string;userAcceptedAt?:string;userAcceptanceNote?:string;resumeAction?:'audit'|'corrections';correctionPlanner?:QACorrectionPlannerDispatch;correctionPlannerNotDispatchedRoundId?:string};
export const terminalRecruitmentWorkerStatuses:RecruitmentWorkerStatus[]=['complete','failed','blocked','escalated','cancelled'];
export function sealRecruitmentTeam(team:RecruitmentTeam){if(team.sealed)throw new Error('Recruitment team is already sealed.');if(team.workers.length<1||team.workers.length>9)throw new Error('Recruitment teams must contain between one and nine workers.');team.sealed=true;team.status='running';}
export function claimRecruitmentIntegration(team:RecruitmentTeam){if(team.mode==='read_only'||!team.sealed||team.status!=='running'||team.integration.status!=='queued'||!team.workers.every(worker=>terminalRecruitmentWorkerStatuses.includes(worker.status)))return false;team.status='integrating';team.integration.status='preparing';return true;}
export function claimRecruitmentCompletion(team:RecruitmentTeam){if(!team.sealed||team.completionWakeSent)return false;team.completionWakeSent=true;return true;}
function markRecruitmentDeepSeekRunsInterrupted(records:(RecruitmentWorker|RecruitmentIntegration)[],reason:string){const updatedAt=new Date().toISOString();for(const record of records)for(const run of record.deepSeekPhaseRuns||[])if(run.status==='running'){run.status='interrupted';run.updatedAt=updatedAt;run.error=reason.slice(0,1000);}}
export function cancelRecruitmentTeamState(team:RecruitmentTeam){team.status='cancelled';if(team.integration.status!=='not_required'){team.integration.status='cancelled';team.integration.activeTurnId=undefined;}for(const worker of team.workers)if(!terminalRecruitmentWorkerStatuses.includes(worker.status)){worker.status='cancelled';worker.activeTurnId=undefined;}markRecruitmentDeepSeekRunsInterrupted([...team.workers,...(team.integration.status==='not_required'?[]:[team.integration])],'The task was cancelled by the user.');}
export function pauseRecruitmentTeamAfterRestart(team:RecruitmentTeam){if(!team.sealed||['complete','failed','cancelled','needs_attention','paused_after_restart'].includes(team.status))return;team.status='paused_after_restart';for(const worker of team.workers)if(['queued','running'].includes(worker.status)){worker.status='paused_after_restart';worker.activeTurnId=undefined;}if(team.integration.status!=='not_required'&&!['complete','failed','cancelled','paused_after_restart'].includes(team.integration.status)){team.integration.status='paused_after_restart';team.integration.activeTurnId=undefined;}markRecruitmentDeepSeekRunsInterrupted([...team.workers,...(team.integration.status==='not_required'?[]:[team.integration])],'The kernel restarted; the execution phase was not replayed automatically.');}
export type PassGitDiffTurn={threadId:string;turnId:string;role:'simple'|'orchestrator'|'worker';diff:string;capturedAt:string;truncated?:boolean};
export type PassGitDiff={status:'recorded'|'partial';source:'codex-turn-diff';updatedAt:string;turns:PassGitDiffTurn[]};
export type ForgeApprovalContext={ticketId:string;targetType:'planning'|'final_review'|'worker_attempt'|'integration';targetId:string;ownerId:string;claimToken?:string};
export type ForgeApprovalIdentity=ForgeApprovalContext&{threadId:string;turnId:string};
export type ApprovalRequest = { requestId: string|number; method: 'item/commandExecution/requestApproval'|'item/fileChange/requestApproval'|'item/permissions/requestApproval'|'mcpServer/elicitation/request'; itemId:string; threadId:string; turnId:string; reason?:string; command?:string; cwd?:string; grantRoot?:string; availableDecisions?:string[]; kind?:string; networkHost?:string; networkProtocol?:string; serverName?:string; mode?:string; message?:string; requestedSchema?:Record<string,unknown>; url?:string;forgeContext?:ForgeApprovalContext };
export type ForgeApprovalRequest=ApprovalRequest&{forgeContext:ForgeApprovalContext};
export type RouteDecision={route:'direct_answer'|'simple_implementation'|'hard_task';effectiveRoute?:'direct_answer'|'simple_implementation'|'hard_task';rule_id:string;justification:string;model:string;effort:string;speed:string;decidedAt:string;fallback?:boolean};
export type ExecutionEscalation={from:'direct_answer'|'simple_implementation';to:'simple_implementation'|'hard_task';reason:string;completedActions:string[];evidence:string[]};
export type SavedSkillSnapshot={id:string;revision:string;name:string;description:string;source:string;instructions:string;files:{path:string;size:number}[];role?:WorkflowRole;loadedAt?:string};
export type SkillSaveRecord={id:string;revision:string;name:string;description:string;source:string;role:string;action:'create'|'update';savedAt:string};
export type TaskPass = { id:string; index:number; createdAt:string; userInput:string; userInputs:string[]; userMessageIds:string[]; attachments?:TaskAttachment[]; selectedSkills?:SavedSkillSnapshot[]; loadedSkills?:SavedSkillSnapshot[]; savedSkills?:SkillSaveRecord[]; interruptedApprovals?:ApprovalRequest[]; phase:TaskPhase; agentmemAudit?:AgentMemAudit; legacyAgentMem?:Record<string,unknown>; receiptProvenance?:ReceiptProvenance; agentReceipts?:AgentReceiptRecord[]; turnSourceChanges?:TurnSourceChangeRecord[]; recruitmentTeam?:RecruitmentTeam; recruitmentHistory?:RecruitmentTeam[]; qualityLoop?:QualityLoop; approvalPolicy?:ApprovalPolicy; accessMode?:AccessMode; executionProfile?:ExecutionProfile; deepSeekExecution?:DeepSeekExecutionProfile; deepSeekConversationStorage?:DeepSeekConversationStoragePreference; mcpServers?:McpServerRegistration[]; toolCalls?:ToolCallLog; toolCallTrackingIssueCount?:number; agentContextVersion?:number; legacyUnassociated?:boolean; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; publicAnswer?:string; assignment?:Assignment; receipt?:Receipt; reviewNote?:string; resolution?:'direct'|'simple'|'delegated'; routingNote?:string; error?:string; escalation?:unknown; reasoningSummaries?:ReasoningSummary[]; reasoningTurns?:ReasoningTurn[]; liveActivity?:LiveActivity[]; usage?:PassUsage; gitDiff?:PassGitDiff; correctionCount:number; workerStage?:'execute'; routerThreadId?:string; directThreadId?:string; simpleThreadId?:string; orchestratorThreadId?:string; workerThreadId?:string; activeTurnId?:string; activeRole?:WorkflowRole; processedTurns:string[] }
export type GitHubTaskLink={repository:string;branch:string;baseBranch?:string;pullRequestUrl?:string;updatedAt:string};
export type Task = { sessionType:'conversation'|'forge';forge?:ForgeTicket;toolCalls?:ToolCallLog; projectId?:string; lastInteractedAt?:string; requiresFreshSession?:boolean; legacyAgentMem?:Record<string,unknown>; githubLink?:GitHubTaskLink; workspaceCommand?:{id:string;mode:'browser'|'github';placement:'side'|'full';url?:string;createdAt:string}; id: string; title: string; phase: TaskPhase; createdAt: string; updatedAt: string; userRoot: string; userMessages: string[]; messages: Message[]; passes?:TaskPass[]; currentPassId?:string; routeDecision?:RouteDecision; executionEscalation?:ExecutionEscalation; assignment?: Assignment; receipt?: Receipt; reviewNote?: string; resolution?:'direct'|'simple'|'delegated'; allowDirectResponse?:boolean;routingNote?:string;reasoningSummaries?:ReasoningSummary[];reasoningTurns?:ReasoningTurn[];liveActivity?:LiveActivity[];gitDiff?:PassGitDiff;activeModelId?:string;activeEffort?:string;correctionCount:number;workerStage?:'execute';routerThreadId?:string;directThreadId?:string;simpleThreadId?:string;orchestratorThreadId?:string;workerThreadId?:string;activeTurnId?:string;activeRole?:WorkflowRole;processedTurns:string[];error?:string;escalation?:unknown;approvalRequests?:ApprovalRequest[];pendingRevision?:boolean };
export type Project = { id:string; name:string; projectRoot:string; needsLocation:boolean; pinned:boolean; createdAt:string; updatedAt:string; legacyAgentMem?:Record<string,unknown> };
export type Settings = { orchestratorModel: string; orchestratorEffort: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'; approvalPolicy: ApprovalPolicy; accessMode?:AccessMode; executionProfile?:ExecutionProfile; deepseekProvider?:string; deepseekModel?:string; deepseekReasoningEffort?:string; deepseekConversationStorageMode?:'native'|'isolated'; deepseekConversationStorageDirectory?:string; mcpServers?:McpServerRegistration[] };
export type State = { version: 7; revision:number; settings: Settings; tasks: Task[]; activeTaskId: string|null; projects:Project[]; selectedProjectId:string|null; expandedProjectIds:string[] };
if(process.env.NODE_ENV!=='test'){
  const migration=migrateLegacyStateDirectory();
  if(migration.status==='legacy-preserved')console.warn(`Opnex left legacy state at ${migration.legacy} because the new directory at ${migration.current} already contains data. No merge was attempted.`);
}
const dataDir = stateDirectory();
const statePath = path.join(dataDir, 'state.json');
const defaults: State = { version: 7, revision:0, settings: { orchestratorModel: 'gpt-6-sol', orchestratorEffort: 'high', approvalPolicy: 'on-request', executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'}, deepseekProvider:'opencode-go', deepseekModel:'deepseek-v4.1-flash', deepseekReasoningEffort:'max', deepseekConversationStorageMode:'isolated', mcpServers:[] }, tasks: [], activeTaskId: null, projects:[], selectedProjectId:null, expandedProjectIds:['unclassified'] };
export function deepSeekExecutionProfileForSettings(settings:Partial<Settings>):DeepSeekExecutionProfile{return {kind:'deepseek-harness-sdk',provider:settings.deepseekProvider||'opencode-go',model:settings.deepseekModel||'deepseek-v4.1-flash',nativeReasoningEffort:settings.deepseekReasoningEffort||'max'};}
export function executionProfileForSettings(settings:Partial<Settings>):ExecutionProfile{return settings.executionProfile?structuredClone(settings.executionProfile):{provider:'codex',model:'gpt-6-luna',effort:'max'};}
export function deepSeekConversationStorageForSettings(settings:Partial<Settings>):DeepSeekConversationStoragePreference{
  const mode=settings.deepseekConversationStorageMode||'isolated';
  if(mode==='native')return {mode};
  return {mode,directory:settings.deepseekConversationStorageDirectory||path.join(stateDirectory(),'dsh-conversations')};
}
let current = structuredClone(defaults);
let loaded = false;
let stateLoading:Promise<State>|undefined;
let writeQueue = Promise.resolve();
const listeners = new Set<(state: State) => void>();
const approvalPolicies:ApprovalPolicy[]=['on-request','untrusted','never','full-access'];
const savedApprovalPolicy=(value:unknown):ApprovalPolicy=>approvalPolicies.includes(value as ApprovalPolicy)?value as ApprovalPolicy:'on-request';
function isStoredRecord(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function validProviderValue(value:unknown){return typeof value==='string'&&value.length>0&&value.length<=160&&value===value.trim()&&!value.includes('\r')&&!value.includes('\n')&&!value.includes(String.fromCharCode(0));}
function isDeepSeekExecutionProfile(value:unknown):value is DeepSeekExecutionProfile{return isStoredRecord(value)&&value.kind==='deepseek-harness-sdk'&&validProviderValue(value.provider)&&validProviderValue(value.model)&&validProviderValue(value.nativeReasoningEffort);}
function isDeepSeekMcpToolCatalog(value:unknown){return isStoredRecord(value)&&['not-configured','pending','ready','missing-tools'].includes(value.status)&&['configuredServerNames','availableServerNames','missingServerNames','toolNames'].every(key=>Array.isArray(value[key])&&value[key].every(isString))&&(value.observedAtSequence===undefined||Number.isSafeInteger(value.observedAtSequence)&&value.observedAtSequence>=0);}
function isDeepSeekRuntimeInfo(value:unknown):value is DeepSeekHarnessRuntimeInfo{return isStoredRecord(value)&&validProviderValue(value.provider)&&validProviderValue(value.model)&&isOptionalString(value,'requestedReasoningEffort')&&isOptionalString(value,'requestedProviderRoute')&&['read-only','workspace-write','danger-full-access','native-profile'].includes(value.permissionMode)&&approvalPolicies.includes(value.selectedApprovalPolicy)&&isString(value.workspaceRoot)&&Array.isArray(value.writeScope)&&value.writeScope.every(isString)&&['read-only','unrestricted','native-profile'].includes(value.access)&&['assignment-instruction-only','read-only-preset','native-profile'].includes(value.filesystemScope)&&isString(value.sessionId)&&isStoredRecord(value.serverInfo)&&isString(value.serverInfo.name)&&isString(value.serverInfo.version)&&isOptionalString(value,'profileName')&&(value.configuredMcpServers===undefined||strings(value.configuredMcpServers))&&(value.mcpToolCatalog===undefined||isDeepSeekMcpToolCatalog(value.mcpToolCatalog))&&isOptionalString(value,'harnessVersion')&&isStoredRecord(value.capabilities)&&typeof value.capabilities.sessionResume==='boolean'&&typeof value.capabilities.workingDirectory==='boolean'&&typeof value.capabilities.approvalResponse==='boolean'&&typeof value.capabilities.steering==='boolean'&&typeof value.capabilities.gracefulSessionCancellation==='boolean'&&value.capabilities.cancellation==='process-tree-termination';}
function isDeepSeekCapabilities(value:unknown){return isStoredRecord(value)&&value.sessionResume===true&&value.workingDirectory===true&&value.approvalResponse===false&&value.steering===false&&value.gracefulSessionCancellation===false&&value.cancellation==='process-tree-termination';}
function isDeepSeekProviderEventSummary(value:unknown){const boundedKeys=(candidate:unknown)=>candidate===undefined||Array.isArray(candidate)&&candidate.length<=32&&candidate.every((row:unknown)=>isString(row)&&row.length<=64);return isStoredRecord(value)&&isString(value.type)&&value.type.length<=128&&(value.sequence===undefined||Number.isSafeInteger(value.sequence)&&value.sequence>=0)&&(value.turn===undefined||Number.isSafeInteger(value.turn)&&value.turn>=0)&&(value.step===undefined||Number.isSafeInteger(value.step)&&value.step>=0)&&isOptionalString(value,'status')&&isOptionalString(value,'messageRole')&&(value.contentBlockTypes===undefined||strings(value.contentBlockTypes))&&(value.textCharacters===undefined||Number.isSafeInteger(value.textCharacters)&&value.textCharacters>=0)&&isOptionalString(value,'toolName')&&isOptionalString(value,'toolCallId')&&(value.sourceEventSequences===undefined||Array.isArray(value.sourceEventSequences)&&value.sourceEventSequences.every((row:unknown)=>Number.isSafeInteger(row)&&Number(row)>=0))&&(value.toolError===undefined||typeof value.toolError==='boolean')&&(value.hasError===undefined||typeof value.hasError==='boolean')&&isOptionalString(value,'errorCode')&&boundedKeys(value.dataKeys)&&boundedKeys(value.reasonKeys)&&isOptionalString(value,'reasonKind')&&isOptionalString(value,'reasonErrorName')&&isOptionalString(value,'reasonErrorCode')&&(value.reasonErrorMessagePresent===undefined||typeof value.reasonErrorMessagePresent==='boolean');}
function isDeepSeekPhaseRun(value:unknown,legacy=false){return isStoredRecord(value)&&(value.stage==='execute'||legacy&&['context_plan','context_compose'].includes(value.stage))&&isString(value.sessionId)&&isString(value.turnId)&&validProviderValue(value.provider)&&validProviderValue(value.model)&&isOptionalString(value,'requestedReasoningEffort')&&isOptionalString(value,'requestedProviderRoute')&&['read-only','workspace-write','danger-full-access','native-profile'].includes(value.permissionMode)&&approvalPolicies.includes(value.approvalPolicy)&&isString(value.workspaceRoot)&&strings(value.writeScope)&&['read-only','unrestricted','native-profile'].includes(value.access)&&['assignment-instruction-only','read-only-preset','native-profile'].includes(value.filesystemScope)&&['running','completed','interrupted','failed'].includes(value.status)&&isDate(value.startedAt)&&isDate(value.updatedAt)&&isOptionalString(value,'profileName')&&(value.configuredMcpServers===undefined||strings(value.configuredMcpServers))&&(value.mcpToolCatalog===undefined||isDeepSeekMcpToolCatalog(value.mcpToolCatalog))&&(value.providerEvents===undefined||Array.isArray(value.providerEvents)&&value.providerEvents.length<=256&&value.providerEvents.every(isDeepSeekProviderEventSummary))&&(value.latestNonAgentMemToolSequence===undefined||legacy&&Number.isSafeInteger(value.latestNonAgentMemToolSequence)&&value.latestNonAgentMemToolSequence>=0)&&(!('legacyAgentMem'in value)||isStoredRecord(value.legacyAgentMem))&&isOptionalString(value,'harnessVersion')&&isOptionalString(value,'error')&&(value.capabilities===undefined||isDeepSeekCapabilities(value.capabilities))&&(value.serverInfo===undefined||isStoredRecord(value.serverInfo)&&isString(value.serverInfo.name)&&isString(value.serverInfo.version));}
function hasValidStoredArrayFields(value:Record<string,any>,fields:string[]){return fields.every(field=>value[field]===undefined||Array.isArray(value[field]));}
function hasSupportedSettingsShape(value:unknown,version:number){
  if(value===undefined)return true;
  if(!isStoredRecord(value))return false;
  const optionalString=(field:string,max:number,allowEmpty=true)=>value[field]===undefined||typeof value[field]==='string'&&value[field].length<=max&&value[field]===value[field].trim()&&(allowEmpty||value[field].length>0);
  const legacyWorkspace=version<5||!('projectRoot' in value)&&!('agentmemProjectId' in value)&&!('agentmemAutoSetup' in value);
  return (legacyWorkspace||(value.projectRoot===undefined&&value.agentmemProjectId===undefined&&value.agentmemAutoSetup===undefined))&&optionalString('projectRoot',1024)&&optionalString('agentmemProjectId',64)&&(value.agentmemAutoSetup===undefined||typeof value.agentmemAutoSetup==='boolean')&&
    (value.agentmemProjectId===undefined||/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value.agentmemProjectId))&&
    optionalString('orchestratorModel',200,false)&&
    optionalString('deepseekProvider',160,false)&&optionalString('deepseekModel',160,false)&&optionalString('deepseekReasoningEffort',160,false)&&
    (value.deepseekConversationStorageMode===undefined||value.deepseekConversationStorageMode==='native'||value.deepseekConversationStorageMode==='isolated')&&
    optionalString('deepseekConversationStorageDirectory',1024,false)&&(value.deepseekConversationStorageDirectory===undefined||isAbsoluteProjectPath(value.deepseekConversationStorageDirectory)&&![...value.deepseekConversationStorageDirectory].some((character:string)=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))&&
    (value.executionProfile===undefined||isExecutionProfile(value.executionProfile))&&
    (value.mcpServers===undefined||mcpServerRegistrationsSchema.safeParse(value.mcpServers).success)&&
    (value.orchestratorEffort===undefined||['low','medium','high','xhigh','max','ultra'].includes(value.orchestratorEffort))&&
    (value.approvalPolicy===undefined||approvalPolicies.includes(value.approvalPolicy));
}
const taskPhases:TaskPhase[]=['intake','routing','direct_running','simple_running','planning','worker_running','escalated','reviewing','accepted','needs_attention','cancelled','paused_after_restart'];
const workflowRoles:WorkflowRole[]=['router','direct','simple','orchestrator','worker'];
const activityRoles:ActivityRole[]=['direct','simple','orchestrator','worker'];
function isString(value:unknown){return typeof value==='string';}
function isExecutionProfile(value:unknown):value is ExecutionProfile{return isStoredRecord(value)&&['codex','deepseek'].includes(value.provider as string)&&isString(value.model)&&value.model.length>0&&value.model.length<=200&&['low','medium','high','xhigh','max','ultra'].includes(value.effort as string);}
function legacyPassExecutionProfile(task:Task,pass:TaskPass):ExecutionProfile|undefined{
  if(isExecutionProfile(pass.executionProfile))return structuredClone(pass.executionProfile);
  const teams=[...(pass.recruitmentTeam?[pass.recruitmentTeam]:[]),...(pass.recruitmentHistory||[])];
  const records=teams.flatMap(team=>[...team.workers,team.integration]);
  const deepSeekRun=records.flatMap(record=>record.deepSeekPhaseRuns||[]).reverse().find(run=>isString(run.model)&&run.model.length>0&&['low','medium','high','xhigh','max','ultra'].includes(run.requestedReasoningEffort||''));
  if(deepSeekRun)return {provider:'deepseek',model:deepSeekRun.model,effort:deepSeekRun.requestedReasoningEffort as ExecutionProfile['effort']};
  const deepSeekRuntimeRecord=records.find(record=>record.deepSeekRuntime&&isDeepSeekExecutionProfile(record.deepSeekExecution)&&['low','medium','high','xhigh','max','ultra'].includes(record.deepSeekExecution.nativeReasoningEffort));
  if(deepSeekRuntimeRecord?.deepSeekExecution)return {provider:'deepseek',model:deepSeekRuntimeRecord.deepSeekExecution.model,effort:deepSeekRuntimeRecord.deepSeekExecution.nativeReasoningEffort as ExecutionProfile['effort']};
  const passThreadIds=new Set([pass.directThreadId,pass.simpleThreadId,pass.workerThreadId,...records.map(record=>record.threadId)].filter((id):id is string=>typeof id==='string'&&id.length>0));
  const currentPassTurns=task.currentPassId===pass.id?(task.reasoningTurns||[]).filter(turn=>turn.turnId===task.activeTurnId&&turn.role===task.activeRole):[];
  const taskTurns=(task.reasoningTurns||[]).filter(turn=>passThreadIds.has(turn.threadId)||currentPassTurns.includes(turn));
  const turns=[...(pass.reasoningTurns||[]),...taskTurns],turn=[...turns].reverse().find(row=>['direct','simple','worker'].includes(row.role)&&isString(row.requestedModel)&&row.requestedModel.length>0&&['low','medium','high','xhigh','max','ultra'].includes(row.requestedEffort));
  if(turn){const provider=turn.provider==='deepseek'?'deepseek':turn.provider==='codex'||/^gpt-/i.test(turn.requestedModel)?'codex':undefined;if(provider)return {provider,model:turn.requestedModel,effort:turn.requestedEffort as ExecutionProfile['effort']};}
  return undefined;
}
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
function isSummary(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&['threadId','turnId','itemId','text'].every(k=>isString(value[k]))&&Number.isInteger(value.summaryIndex)&&isOptionalString(value,'passId')&&isOptionalString(value,'provider')&&isOptionalString(value,'requestedModel')&&isOptionalString(value,'requestedEffort')&&isOptionalString(value,'effectiveModel')&&(value.updatedAt===undefined||isDate(value.updatedAt));}
function isReasoningTurn(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&isString(value.threadId)&&isString(value.turnId)&&isOptionalString(value,'provider')&&isString(value.requestedModel)&&isString(value.requestedEffort)&&(value.effectiveModel===undefined||isString(value.effectiveModel))&&(value.startedAt===undefined||isDate(value.startedAt))&&['streaming','completed','interrupted','failed'].includes(value.status);}
function isLiveActivity(value:unknown){return isStoredRecord(value)&&activityRoles.includes(value.role)&&['threadId','turnId','itemId','itemType','title'].every(k=>isString(value[k]))&&isDate(value.startedAt)&&isDate(value.updatedAt)&&['commentary','tool'].includes(value.kind)&&['running','completed','failed','interrupted'].includes(value.status)&&['text','detail','output','passId'].every(k=>isOptionalString(value,k));}
function isToolCallLog(value:unknown){
  if(!isStoredRecord(value)||value.schemaVersion!==1||!Number.isSafeInteger(value.total)||value.total<0||!Number.isSafeInteger(value.omittedCount)||value.omittedCount<0||!isStoredRecord(value.statusCounts)||!isStoredRecord(value.seen)||!Array.isArray(value.calls)||value.calls.length>1000)return false;
  const statuses=['started','completed','failed','interrupted'];
  if(!statuses.every(status=>Number.isSafeInteger(value.statusCounts[status])&&value.statusCounts[status]>=0)||Object.values(value.statusCounts).reduce((sum:number,count:any)=>sum+count,0)!==value.total)return false;
  const seenEntries=Object.entries(value.seen);if(seenEntries.length!==value.total||seenEntries.some(([key,status])=>!isString(key)||!statuses.includes(status as string)))return false;
  return value.calls.every((row:any)=>isStoredRecord(row)&&isString(row.key)&&isStoredRecord(row.identity)&&['provider','agentId','threadId','turnId','callId'].every(key=>isString(row.identity[key])&&row.identity[key].length>0&&row.identity[key].length<=256)&&['name','type'].every(key=>isString(row[key])&&row[key].length>0&&row[key].length<=160)&&statuses.includes(row.status)&&Array.isArray(row.sources)&&row.sources.length>0&&row.sources.every((source:any)=>source==='application'||source==='model')&&isDate(row.firstSeenAt)&&isDate(row.lastSeenAt)&&isOptionalString(row,'agentRole')&&isOptionalString(row,'summary')&&(row.startedAt===undefined||isDate(row.startedAt))&&(row.finishedAt===undefined||isDate(row.finishedAt))&&value.seen[row.key]===row.status);
}
function isRouteDecision(value:unknown){return isStoredRecord(value)&&['route','rule_id','justification','model','effort','speed','decidedAt'].every(k=>isString(value[k]))&&['direct_answer','simple_implementation','hard_task'].includes(value.route)&&isDate(value.decidedAt)&&(value.effectiveRoute===undefined||['direct_answer','simple_implementation','hard_task'].includes(value.effectiveRoute))&&(value.fallback===undefined||typeof value.fallback==='boolean');}
function isExecutionEscalation(value:unknown){return isStoredRecord(value)&&['direct_answer','simple_implementation'].includes(value.from)&&['simple_implementation','hard_task'].includes(value.to)&&isString(value.reason)&&strings(value.completedActions)&&strings(value.evidence);}
function isSavedSkill(value:unknown){return isStoredRecord(value)&&['id','revision','name','description','source','instructions'].every(k=>isString(value[k]))&&Array.isArray(value.files)&&value.files.every((file:any)=>isStoredRecord(file)&&isString(file.path)&&Number.isInteger(file.size)&&file.size>=0)&&(value.role===undefined||validRole(value.role))&&(value.loadedAt===undefined||isDate(value.loadedAt));}
function isAgentReceipt(value:unknown){return isStoredRecord(value)&&['simple','worker','integrator'].includes(value.producerRole)&&['threadId','turnId'].every(k=>isString(value[k]))&&isDate(value.recordedAt)&&Array.isArray(value.artifactRefs)&&value.artifactRefs.every(isString)&&(value.origin===undefined||['model_turn','application_failure','application_status'].includes(value.origin))&&['workerId','teamId','passId'].every(k=>isOptionalString(value,k))&&receiptSchema.safeParse(value.receipt).success;}
function isTurnSourceChange(value:unknown){return isStoredRecord(value)&&['simple','worker'].includes(value.role)&&['threadId','turnId','workspaceRoot'].every(k=>isString(value[k]))&&['verified','unavailable'].includes(value.status)&&isDate(value.baselineCapturedAt)&&isDate(value.completedAt)&&strings(value.changedPaths)&&typeof value.repositoryRevisionChanged==='boolean'&&isOptionalString(value,'reason');}
function isAgentMemAudit(value:unknown){
  const contexts=(row:any)=>isStoredRecord(row)&&['id','purpose','queryHash'].every(k=>isString(row[k]))&&activityRoles.includes(row.role)&&['running','retrieved','supplied','failed','disabled','interrupted','pending'].includes(row.status)&&isDate(row.startedAt)&&isDate(row.updatedAt)&&['threadId','turnId','projectId','resultSummary','error'].every(k=>isOptionalString(row,k));
  const calls=(row:any)=>isStoredRecord(row)&&isString(row.id)&&['application','model'].includes(row.source)&&validRole(row.role)&&isString(row.method)&&['running','completed','failed','interrupted'].includes(row.status)&&isDate(row.startedAt)&&isDate(row.updatedAt)&&['contextId','purpose','projectId','repositoryId','threadId','turnId','resultSummary','error'].every(k=>isOptionalString(row,k))&&(row.providerEventSequence===undefined||Number.isSafeInteger(row.providerEventSequence)&&row.providerEventSequence>=0)&&(row.service===undefined||['knowledge','repository_index','unknown'].includes(row.service))&&(row.operation===undefined||['read','write','unknown'].includes(row.operation));
  const repositories=(row:any)=>isStoredRecord(row)&&isString(row.root)&&isString(row.repositoryId)&&isString(row.purpose)&&isDate(row.registeredAt)&&isOptionalString(row,'threadId');
  return isStoredRecord(value)&&typeof value.recorded==='boolean'&&(value.coverage===undefined||['full_pass','from_first_recorded_call'].includes(value.coverage))&&(value.selectedProjectId===null||isString(value.selectedProjectId))&&isString(value.workspaceRoot)&&['unknown','unverified','verified','mismatch','unavailable','disabled'].includes(value.identityStatus)&&['unknown','disabled','available','unavailable','no_calls_observed','observed'].includes(value.modelMcpStatus)&&Array.isArray(value.contexts)&&value.contexts.every(contexts)&&Array.isArray(value.calls)&&value.calls.every(calls)&&(value.repositories===undefined||Array.isArray(value.repositories)&&value.repositories.every(repositories))&&['verifiedProjectId','verifiedRoot','verifiedRepositoryId'].every(k=>isOptionalString(value,k));
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
function isApprovalRequest(value:unknown){
  if(!isStoredRecord(value)||(typeof value.requestId!=='string'&&typeof value.requestId!=='number')||!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','mcpServer/elicitation/request'].includes(value.method)||!['itemId','threadId','turnId'].every(k=>isString(value[k]))||!['reason','command','cwd','grantRoot','kind','networkHost','networkProtocol','serverName','mode','message','url'].every(k=>isOptionalString(value,k))||(value.availableDecisions!==undefined&&!strings(value.availableDecisions))||(value.requestedSchema!==undefined&&!isStoredRecord(value.requestedSchema)))return false;
  if(value.forgeContext===undefined)return true;
  const context=value.forgeContext;
  return isStoredRecord(context)&&isString(context.ticketId)&&['planning','final_review','worker_attempt','integration'].includes(context.targetType)&&isString(context.targetId)&&isString(context.ownerId)&&isOptionalString(context,'claimToken')&&Object.keys(context).every(key=>['ticketId','targetType','targetId','ownerId','claimToken'].includes(key));
}
function isForgeApprovalRequest(value:unknown,ticket:ForgeTicket):value is ForgeApprovalRequest{
  if(!isApprovalRequest(value))return false;
  const request=value as Record<string,any>;
  if(!request.forgeContext)return false;
  const context=request.forgeContext;
  if(context.ticketId!==ticket.id)return false;
  if(context.targetType==='planning'||context.targetType==='final_review'){
    const run=ticket.orchestratorRuns.find(row=>row.id===context.targetId&&row.purpose===context.targetType);
    return !!run&&run.ownerId===context.ownerId&&run.threadId===request.threadId&&run.turnId===request.turnId&&!context.claimToken;
  }
  if(context.targetType==='worker_attempt'){
    const attempt=ticket.attempts.find(row=>row.id===context.targetId);
    if(!attempt)return false;
    return attempt.claim.ownerId===context.ownerId&&attempt.claim.token===context.claimToken&&attempt.threadId===request.threadId&&attempt.turnId===request.turnId;
  }
  const run=ticket.integration.runs.find(row=>row.id===context.targetId);
  return !!run&&run.ownerId===context.ownerId&&run.threadId===request.threadId&&run.turnId===request.turnId&&!context.claimToken;
}
function isReceiptProvenance(value:unknown){return isStoredRecord(value)&&['simple','worker','integrator'].includes(value.producerRole)&&['threadId','turnId'].every(k=>isString(value[k]))&&isDate(value.recordedAt)&&Array.isArray(value.artifactRefs)&&value.artifactRefs.every(isString)&&(value.origin===undefined||['model_turn','application_failure','application_status'].includes(value.origin))&&['workerId','teamId','passId'].every(k=>isOptionalString(value,k));}
function isStoredIntegrationAssignment(value:unknown,nativeDsh:boolean){
  if(assignmentSchema.safeParse(value).success)return true;
  if(!nativeDsh||!isStoredRecord(value)||!Array.isArray(value.receipt_requirements)||value.receipt_requirements.length!==0)return false;
  return assignmentSchema.safeParse({...value,receipt_requirements:['validation-only placeholder']}).success;
}
function isGitDiff(value:unknown){return isStoredRecord(value)&&['recorded','partial'].includes(value.status)&&value.source==='codex-turn-diff'&&isDate(value.updatedAt)&&Array.isArray(value.turns)&&value.turns.every((row:any)=>isStoredRecord(row)&&['threadId','turnId','diff'].every(k=>isString(row[k]))&&['simple','orchestrator','worker'].includes(row.role)&&isDate(row.capturedAt)&&(row.truncated===undefined||typeof row.truncated==='boolean'));}
const recruitmentStatuses=['recruiting','running','integrating','complete','failed','cancelled','needs_attention','paused_after_restart'];
const recruitmentWorkerStatuses=['queued','running','complete','escalated','failed','blocked','cancelled','paused_after_restart'];
const integrationStatuses=['queued','running','complete','failed','cancelled','paused_after_restart'];
function isRecruitmentBranch(value:unknown){return isString(value)&&value.length<=240&&/^recruitment\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!/[~^:?*\x5b\\\s]/.test(value)&&!value.endsWith('/')&&!value.endsWith('.');}
function isRecruitmentTeam(value:unknown,legacy=false){
  if(!isStoredRecord(value)||!['teamId','passId','canonicalProjectRoot'].every(k=>isString(value[k]))||value.mode!==undefined&&!['worktree','read_only'].includes(value.mode)||!isDate(value.createdAt)||!recruitmentStatuses.includes(value.status)||typeof value.sealed!=='boolean'||typeof value.completionWakeSent!=='boolean'||!strings(value.toolCallIds)||!Array.isArray(value.workers)||value.workers.length<1||value.workers.length>9||!isStoredRecord(value.integration))return false;
  const readOnly=value.mode==='read_only';
  if(readOnly?['workspaceParent','baseRef','baseCommit'].some(k=>k in value):!['workspaceParent','baseRef','baseCommit'].every(k=>isString(value[k])))return false;
  if(value.agentmemProjectId!==undefined&&(!legacy||!isString(value.agentmemProjectId)))return false;
  const workers=value.workers;
  if(new Set(workers.map((row:any)=>row.workerId)).size!==workers.length||!readOnly&&new Set(workers.map((row:any)=>row.branch)).size!==workers.length)return false;
  const ids=new Set(workers.map((row:any)=>row.workerId));
  const validWorker=(row:any)=>{
    if(!isStoredRecord(row)||!['workerId','name'].every(k=>isString(row[k]))||!['high','xhigh','max'].includes(row.effort)||!(recruitmentWorkerStatuses.includes(row.status)||legacy&&['context_plan','context_compose'].includes(row.status))||!assignmentSchema.safeParse(row.assignment).success||!Array.isArray(row.skills)||!row.skills.every(isSavedSkill))return false;
    if(readOnly?(row.branch!==undefined||row.worktreeRoot!==undefined||row.assignment.write_scope.length>0||row.dependsOn?.length>0):(!isString(row.worktreeRoot)||!isRecruitmentBranch(row.branch)))return false;
    return (row.step===undefined||isString(row.step))&&(row.dependsOn===undefined||strings(row.dependsOn)&&row.dependsOn.every((id:string)=>ids.has(id)&&id!==row.workerId))&&['threadId','activeTurnId','error','headCommit'].every(k=>isOptionalString(row,k))&&(row.executionProfile===undefined||isExecutionProfile(row.executionProfile))&&(legacy||(!('contextStatus'in row)&&!('contextSummary'in row)))&&(legacy&&['contextSummary'].every(k=>isOptionalString(row,k))||!legacy)&&['startedAt','executionStartedAt','completedAt'].every(k=>row[k]===undefined||isDate(row[k]))&&(row.deepSeekExecution===undefined||isDeepSeekExecutionProfile(row.deepSeekExecution))&&(row.deepSeekRuntime===undefined||isDeepSeekRuntimeInfo(row.deepSeekRuntime))&&(row.deepSeekPhaseRuns===undefined||Array.isArray(row.deepSeekPhaseRuns)&&row.deepSeekPhaseRuns.every((run:unknown)=>isDeepSeekPhaseRun(run,legacy)))&&(row.workerStage===undefined||row.workerStage==='execute'||legacy&&['context_plan','context_compose'].includes(row.workerStage))&&(row.contextStatus===undefined||legacy&&isStoredRecord(row.contextStatus)&&['retrieved','disabled','unavailable'].includes(row.contextStatus.status)&&isString(row.contextStatus.detail))&&(row.receipt===undefined||receiptSchema.safeParse(row.receipt).success);
  };
  const visiting=new Set<string>(),visited=new Set<string>();const visit=(id:string):boolean=>{if(visiting.has(id))return false;if(visited.has(id))return true;const node=workers.find((row:any)=>row.workerId===id);if(!node)return false;visiting.add(id);const valid=(node.dependsOn||[]).every((dependency:string)=>visit(dependency));visiting.delete(id);if(valid)visited.add(id);return valid;};
  if(!workers.every((worker:any)=>visit(worker.workerId)))return false;
  const integration=value.integration;
  const validBundle=(row:any)=>isStoredRecord(row)&&['workerId','name'].every(k=>isString(row[k]))&&(readOnly?row.branch===undefined:isString(row.branch)&&isRecruitmentBranch(row.branch))&&(recruitmentWorkerStatuses.includes(row.status)||legacy&&['context_plan','context_compose'].includes(row.status))&&(row.headCommit===null||isString(row.headCommit))&&receiptSchema.safeParse(row.receipt).success&&(row.producer===null||isReceiptProvenance(row.producer));
  const integrationStatus=[...integrationStatuses,'preparing'];
  const validIntegration=readOnly?integration.status==='not_required'&&Object.keys(integration).every(key=>key==='status'):isRecruitmentBranch(integration.branch)&&isString(integration.worktreeRoot)&&(integrationStatus.includes(integration.status)||legacy&&['context_plan','context_compose'].includes(integration.status))&&isStoredIntegrationAssignment(integration.assignment,integration.deepSeekExecution!==undefined)&&['high','xhigh','max'].includes(integration.effort)&&Array.isArray(integration.skills)&&integration.skills.every(isSavedSkill)&&['threadId','activeTurnId','headCommit','error'].every(k=>isOptionalString(integration,k))&&(integration.executionProfile===undefined||isExecutionProfile(integration.executionProfile))&&(legacy||!('contextStatus'in integration)&&!('contextSummary'in integration))&&(legacy&&isOptionalString(integration,'contextSummary')||!legacy)&&['startedAt','executionStartedAt','completedAt'].every(k=>integration[k]===undefined||isDate(integration[k]))&&(integration.deepSeekExecution===undefined||isDeepSeekExecutionProfile(integration.deepSeekExecution))&&(integration.deepSeekRuntime===undefined||isDeepSeekRuntimeInfo(integration.deepSeekRuntime))&&(integration.deepSeekPhaseRuns===undefined||Array.isArray(integration.deepSeekPhaseRuns)&&integration.deepSeekPhaseRuns.every((run:unknown)=>isDeepSeekPhaseRun(run,legacy)))&&(integration.workerStage===undefined||integration.workerStage==='execute'||legacy&&['context_plan','context_compose'].includes(integration.workerStage))&&(integration.contextStatus===undefined||legacy&&isStoredRecord(integration.contextStatus)&&['retrieved','disabled','unavailable'].includes(integration.contextStatus.status)&&isString(integration.contextStatus.detail))&&(integration.receipt===undefined||receiptSchema.safeParse(integration.receipt).success);
  return workers.every(validWorker)&&validIntegration&&(value.workerReceiptBundle===undefined||Array.isArray(value.workerReceiptBundle)&&value.workerReceiptBundle.length===workers.length&&value.workerReceiptBundle.every(validBundle))&&(value.integrationReceiptProducer===undefined||isReceiptProvenance(value.integrationReceiptProducer))&&(value.combinedReceipt===undefined||receiptSchema.safeParse(value.combinedReceipt).success);
}
function isQAFinding(value:unknown){return isStoredRecord(value)&&['findingId','fingerprint','title','issue','requiredFix'].every(k=>isString(value[k]))&&['critical','high','medium','low'].includes(value.severity)&&strings(value.evidence)&&value.evidence.length>0&&(value.file===undefined||isString(value.file))&&(value.line===undefined||Number.isInteger(value.line)&&value.line>0);}
function isQAAuditRound(value:unknown){return isStoredRecord(value)&&isString(value.roundId)&&Number.isInteger(value.index)&&value.index>0&&['starting','auditing','completed','awaiting_corrections','correcting','interrupted','failed','paused_after_restart'].includes(value.status)&&isDate(value.createdAt)&&isDate(value.startedAt)&&(value.completedAt===undefined||isDate(value.completedAt))&&value.model==='gpt-6.1-terra'&&value.requestedEffort==='high'&&['threadId','turnId','reportedModel','reportedEffort','summary','findingsFingerprint','teamId','error'].every(k=>isOptionalString(value,k))&&isString(value.workspaceRoot)&&isString(value.integrationBranch)&&isString(value.integrationHead)&&(value.resultStatus===undefined||['issues_found','no_actionable_issues'].includes(value.resultStatus))&&(value.findings===undefined||Array.isArray(value.findings)&&value.findings.every(isQAFinding));}
function isQACorrectionPlannerDispatch(value:unknown){return isStoredRecord(value)&&isString(value.roundId)&&['preflight','dispatch_unknown','active','interrupted','completed'].includes(value.status)&&['threadId','turnId'].every(k=>isOptionalString(value,k));}
function isQualityLoop(value:unknown){return isStoredRecord(value)&&typeof value.enabled==='boolean'&&['disabled','awaiting_audit','auditing','awaiting_corrections','correcting','complete','user_accepted','needs_attention','paused','paused_after_restart','cancelled'].includes(value.status)&&Number.isInteger(value.maxRounds)&&value.maxRounds>=1&&value.maxRounds<=9&&Array.isArray(value.rounds)&&value.rounds.length<=value.maxRounds&&value.rounds.every(isQAAuditRound)&&['terminalReason','userAcceptanceNote','correctionPlannerNotDispatchedRoundId'].every(k=>isOptionalString(value,k))&&(value.userAcceptedAt===undefined||isDate(value.userAcceptedAt))&&(value.resumeAction===undefined||['audit','corrections'].includes(value.resumeAction))&&(value.correctionPlanner===undefined||isQACorrectionPlannerDispatch(value.correctionPlanner));}
function hasValidNestedArrays(value:Record<string,any>){
  const arrays=(fields:string[],check:(row:unknown)=>boolean)=>fields.every(field=>value[field]===undefined||Array.isArray(value[field])&&value[field].every(check));
  if(!arrays(['reasoningSummaries'],isSummary)||!arrays(['reasoningTurns'],isReasoningTurn)||!arrays(['liveActivity'],isLiveActivity))return false;
  if(value.assignment!==undefined&&!assignmentSchema.safeParse(value.assignment).success||value.receipt!==undefined&&!receiptSchema.safeParse(value.receipt).success)return false;
  if(value.routeDecision!==undefined&&!isRouteDecision(value.routeDecision)||value.executionEscalation!==undefined&&!isExecutionEscalation(value.executionEscalation))return false;
  if(value.escalation!==undefined&&(!isStoredRecord(value.escalation)||!isString(value.escalation.decision_needed)||value.escalation.evidence!==undefined&&!strings(value.escalation.evidence)||value.escalation.options!==undefined&&!strings(value.escalation.options)||!isOptionalString(value.escalation,'recommendation')))return false;
  return true;
}
function hasSupportedPassShape(pass:unknown,legacyAgentMem:boolean){
  if(!isStoredRecord(pass)||!isString(pass.id)||!Number.isInteger(pass.index)||pass.index<1||!isDate(pass.createdAt)||!isString(pass.userInput)||!strings(pass.userInputs)||!strings(pass.userMessageIds)||!taskPhases.includes(pass.phase)||!Number.isInteger(pass.correctionCount)||pass.correctionCount<0||!strings(pass.processedTurns))return false;
  if(!hasValidStoredArrayFields(pass,['userInputs','userMessageIds','attachments','selectedSkills','loadedSkills','savedSkills','interruptedApprovals','processedTurns','reasoningSummaries','reasoningTurns','liveActivity','agentReceipts','turnSourceChanges','recruitmentHistory']))return false;
  if(pass.attachments!==undefined&&!pass.attachments.every(isAttachment)||pass.interruptedApprovals!==undefined&&!pass.interruptedApprovals.every(isApprovalRequest)||pass.selectedSkills!==undefined&&!pass.selectedSkills.every(isSavedSkill)||pass.loadedSkills!==undefined&&!pass.loadedSkills.every(isSavedSkill)||
    pass.savedSkills!==undefined&&!pass.savedSkills.every((row:any)=>isStoredRecord(row)&&['id','revision','name','description','source','role','savedAt'].every(k=>isString(row[k]))&&['create','update'].includes(row.action))||
    pass.agentReceipts!==undefined&&!pass.agentReceipts.every(isAgentReceipt)||pass.turnSourceChanges!==undefined&&!pass.turnSourceChanges.every(isTurnSourceChange)||pass.recruitmentTeam!==undefined&&!isRecruitmentTeam(pass.recruitmentTeam,legacyAgentMem)||pass.recruitmentHistory!==undefined&&(!pass.recruitmentHistory.every((team:unknown)=>isRecruitmentTeam(team,legacyAgentMem))||pass.recruitmentHistory.length>8)||pass.qualityLoop!==undefined&&!isQualityLoop(pass.qualityLoop)||!hasValidNestedArrays(pass))return false;
  if(pass.approvalPolicy!==undefined&&!approvalPolicies.includes(pass.approvalPolicy)||pass.executionProfile!==undefined&&!isExecutionProfile(pass.executionProfile)||pass.deepSeekExecution!==undefined&&!isDeepSeekExecutionProfile(pass.deepSeekExecution)||pass.deepSeekConversationStorage!==undefined&&(!isStoredRecord(pass.deepSeekConversationStorage)||!['native','isolated'].includes(pass.deepSeekConversationStorage.mode)||pass.deepSeekConversationStorage.directory!==undefined&&(!isString(pass.deepSeekConversationStorage.directory)||pass.deepSeekConversationStorage.directory.length>1024||!isAbsoluteProjectPath(pass.deepSeekConversationStorage.directory)||[...pass.deepSeekConversationStorage.directory].some((character:string)=>character.charCodeAt(0)<32||character.charCodeAt(0)===127)))||pass.mcpServers!==undefined&&!mcpServerRegistrationsSchema.safeParse(pass.mcpServers).success||pass.toolCalls!==undefined&&!isToolCallLog(pass.toolCalls)||pass.toolCallTrackingIssueCount!==undefined&&(!Number.isSafeInteger(pass.toolCallTrackingIssueCount)||pass.toolCallTrackingIssueCount<0)||pass.agentContextVersion!==undefined&&!Number.isInteger(pass.agentContextVersion))return false;
  if(pass.activeRole!==undefined&&!validRole(pass.activeRole))return false;
  if(pass.agentmemAudit!==undefined&&!isAgentMemAudit(pass.agentmemAudit)||pass.legacyAgentMem!==undefined&&!isStoredRecord(pass.legacyAgentMem)||!legacyAgentMem&&['agentmemSetupMode','agentmemSetupTurnId','agentmemTaskId','agentmemLease','agentmemRecordStatus','agentmemRecordError','agentmemReceiptId'].some(field=>field in pass)||pass.receiptProvenance!==undefined&&!isReceiptProvenance(pass.receiptProvenance)||pass.usage!==undefined&&!isPassUsage(pass.usage)||pass.gitDiff!==undefined&&!isGitDiff(pass.gitDiff))return false;
  if((pass.workerContextStatus!==undefined||pass.workerContextSummary!==undefined)&&!legacyAgentMem)return false;
  if(pass.workerStage!==undefined&&!(pass.workerStage==='execute'||legacyAgentMem&&['context_plan','context_compose'].includes(pass.workerStage))||pass.workerContextStatus!==undefined&&(!isStoredRecord(pass.workerContextStatus)||!['retrieved','disabled','unavailable'].includes(pass.workerContextStatus.status)||!isString(pass.workerContextStatus.detail))||pass.workerContextSummary!==undefined&&!isString(pass.workerContextSummary))return false;
  if(pass.resolution!==undefined&&!['direct','simple','delegated'].includes(pass.resolution)||pass.legacyUnassociated!==undefined&&typeof pass.legacyUnassociated!=='boolean')return false;
  return ['routerThreadId','directThreadId','simpleThreadId','orchestratorThreadId','workerThreadId','activeTurnId','agentmemTaskId','agentmemLease','agentmemRecordStatus','agentmemRecordError','agentmemReceiptId','agentmemSetupTurnId','publicAnswer','reviewNote','routingNote','error','workerContextSummary'].every(field=>isOptionalString(pass,field));
}
function hasSupportedTaskShape(task:unknown,legacy:boolean,legacyAgentMem:boolean,forgeState:boolean,forgeToolLog:boolean){
  if(!isStoredRecord(task)||!isString(task.id)||!isString(task.title)||!taskPhases.includes(task.phase)||!isDate(task.createdAt)||!(isDate(task.updatedAt)||legacy&&task.updatedAt===undefined)||!(isString(task.userRoot)||legacy&&task.userRoot===undefined)||legacyAgentMem&&!isString(task.agentmemProjectId??'')||!legacyAgentMem&&task.agentmemProjectId!==undefined||task.legacyAgentMem!==undefined&&!isStoredRecord(task.legacyAgentMem)||task.requiresFreshSession!==undefined&&typeof task.requiresFreshSession!=='boolean'||!(strings(task.userMessages)||legacy&&task.userMessages===undefined)||!(Array.isArray(task.messages)&&task.messages.every(row=>isMessage(row,legacy))||legacy&&task.messages===undefined)||!(Number.isInteger(task.correctionCount)&&task.correctionCount>=0||legacy&&task.correctionCount===undefined)||!(strings(task.processedTurns)||legacy&&task.processedTurns===undefined))return false;
  if(!hasValidStoredArrayFields(task,['userMessages','messages','passes','processedTurns','reasoningSummaries','reasoningTurns','liveActivity','approvalRequests']))return false;
  if(task.passes!==undefined&&!task.passes.every((pass:unknown)=>hasSupportedPassShape(pass,legacyAgentMem))||!hasValidNestedArrays(task))return false;
  if(task.approvalRequests!==undefined&&!task.approvalRequests.every(isApprovalRequest))return false;
  if(task.workspaceCommand!==undefined&&(!isStoredRecord(task.workspaceCommand)||!isString(task.workspaceCommand.id)||!['browser','github'].includes(task.workspaceCommand.mode)||!['side','full'].includes(task.workspaceCommand.placement)||!isDate(task.workspaceCommand.createdAt)||!isOptionalString(task.workspaceCommand,'url')||task.workspaceCommand.url!==undefined&&!safeWorkspaceUrl(task.workspaceCommand.url)))return false;
  if(task.githubLink!==undefined&&(!isStoredRecord(task.githubLink)||!isString(task.githubLink.repository)||!isString(task.githubLink.branch)||!isDate(task.githubLink.updatedAt)||!isOptionalString(task.githubLink,'baseBranch')||!isOptionalString(task.githubLink,'pullRequestUrl')))return false;
  if(task.activeRole!==undefined&&!validRole(task.activeRole))return false;
  if((task.workerContextStatus!==undefined||task.workerContextSummary!==undefined)&&!legacyAgentMem)return false;
  if(task.workerStage!==undefined&&!(task.workerStage==='execute'||legacyAgentMem&&['context_plan','context_compose'].includes(task.workerStage))||task.workerContextStatus!==undefined&&(!isStoredRecord(task.workerContextStatus)||!['retrieved','disabled','unavailable'].includes(task.workerContextStatus.status)||!isString(task.workerContextStatus.detail))||task.workerContextSummary!==undefined&&!isString(task.workerContextSummary)||task.resolution!==undefined&&!['direct','simple','delegated'].includes(task.resolution)||task.allowDirectResponse!==undefined&&typeof task.allowDirectResponse!=='boolean'||task.pendingRevision!==undefined&&typeof task.pendingRevision!=='boolean')return false;
  if(task.passes?.length&&task.currentPassId!==undefined&&!task.passes.some((pass:any)=>pass.id===task.currentPassId))return false;
  if(task.toolCalls!==undefined&&(task.sessionType!=='forge'||!isToolCallLog(task.toolCalls))||forgeToolLog&&task.sessionType==='forge'&&!isToolCallLog(task.toolCalls))return false;
  const parsedForge=forgeState&&task.sessionType==='forge'?forgeTicketSchema.safeParse(task.forge):undefined;
  if(forgeState&&(!['conversation','forge'].includes(task.sessionType)||task.sessionType==='conversation'&&task.forge!==undefined||task.sessionType==='forge'&&(!parsedForge?.success||task.forge.id!==task.id||task.forge.projectId!==task.projectId||task.forge.title!==task.title||!sameProjectRoot(task.forge.workspaceRoot,task.userRoot)||!!task.currentPassId||!!task.passes?.length||!!task.activeRole||!!task.activeTurnId)))return false;
  if(task.sessionType==='forge'&&task.approvalRequests!==undefined&&(!parsedForge?.success||!task.approvalRequests.every((request:unknown)=>isForgeApprovalRequest(request,parsedForge.data))))return false;
  if(task.projectId!==undefined&&!isUuid(task.projectId))return false;
  if(task.lastInteractedAt!==undefined&&!isDate(task.lastInteractedAt))return false;
  return ['currentPassId','activeTurnId','routerThreadId','directThreadId','simpleThreadId','orchestratorThreadId','workerThreadId','agentmemTaskId','agentmemLease','agentmemRecordStatus','agentmemRecordError','agentmemReceiptId','activeModelId','activeEffort','error','workerContextSummary','routingNote','reviewNote'].every(field=>isOptionalString(task,field));
}
const isUuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function isProject(value:unknown){return isStoredRecord(value)&&isUuid(value.id)&&isString(value.name)&&value.name.trim().length>0&&value.name.length<=80&&isString(value.projectRoot)&&value.projectRoot.length<=1024&&typeof value.needsLocation==='boolean'&&typeof value.pinned==='boolean'&&isDate(value.createdAt)&&isDate(value.updatedAt)&&!('agentmemProjectId'in value)&&!('agentmemEnabled'in value)&&(!('legacyAgentMem'in value)||isStoredRecord(value.legacyAgentMem));}
function isV4Project(value:unknown){return isStoredRecord(value)&&isUuid(value.id)&&isString(value.name)&&value.name.trim().length>0&&value.name.length<=80&&isString(value.projectRoot)&&value.projectRoot.length<=1024&&isString(value.agentmemProjectId)&&/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value.agentmemProjectId)&&typeof value.agentmemEnabled==='boolean'&&(value.agentmemEnabled?!!value.agentmemProjectId:!value.agentmemProjectId)&&typeof value.needsLocation==='boolean'&&typeof value.pinned==='boolean'&&isDate(value.createdAt)&&isDate(value.updatedAt);}
function isLegacyProject(value:unknown){return isStoredRecord(value)&&isUuid(value.id)&&isString(value.name)&&value.name.trim().length>0&&value.name.length<=80&&isString(value.projectRoot)&&value.projectRoot.length<=1024&&isString(value.agentmemProjectId)&&/^(?:|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value.agentmemProjectId)&&typeof value.agentmemEnabled==='boolean'&&typeof value.agentmemAutoSetup==='boolean'&&(!value.agentmemEnabled&&!value.agentmemProjectId||value.agentmemEnabled&&(!!value.agentmemProjectId||value.agentmemAutoSetup))&&typeof value.pinned==='boolean'&&isDate(value.createdAt)&&isDate(value.updatedAt);}
function safeWorkspaceUrl(value:unknown){try{return normalizeAgentWorkspaceUrl(value)===value;}catch{return false;}}
function hasSupportedStoredShape(value:any){
  if(!isStoredRecord(value)||![1,2,3,4,5,6,7].includes(value.version)||!Array.isArray(value.tasks))return false;
  if(value.revision!==undefined&&(!Number.isSafeInteger(value.revision)||value.revision<0))return false;
  if(!hasSupportedSettingsShape(value.settings,value.version))return false;
  if(value.activeTaskId!==undefined&&value.activeTaskId!==null&&typeof value.activeTaskId!=='string')return false;
  if(value.version>=3&&(!Array.isArray(value.projects)||!value.projects.every(value.version>=5?isProject:value.version===4?isV4Project:isLegacyProject)||new Set(value.projects.map((project:any)=>project.id)).size!==value.projects.length||value.selectedProjectId!==null&&!isUuid(value.selectedProjectId)||!Array.isArray(value.expandedProjectIds)||!value.expandedProjectIds.every((id:any)=>id==='unclassified'||isUuid(id))||value.selectedProjectId&&!value.projects.some((project:any)=>project.id===value.selectedProjectId)||value.tasks.some((task:any)=>task.projectId&&!value.projects.some((project:any)=>project.id===task.projectId))))return false;
  return value.tasks.every((task:any)=>hasSupportedTaskShape(task,value.version===1,value.version<5,value.version>=6,value.version>=7)&&(value.version<6||task.sessionType!=='forge'||['complete','cancelled'].includes(task.forge.phase)||sameProjectRoot(value.projects.find((project:any)=>project.id===task.projectId)?.projectRoot||'',task.forge.workspaceRoot)));
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
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`Could not read Opnex local state at ${statePath}. Check that the file is readable; its contents were left unchanged.`,{cause:error});
    loaded=true;
    return structuredClone(current);
  }
  let value:any;
  try { value=JSON.parse(source); }
  catch(error) { throw new Error(`Opnex local state at ${statePath} is malformed. Preserve or repair this file before restarting; it will not be replaced automatically.`,{cause:error}); }
  if (!hasSupportedStoredShape(value)) {
    throw new Error(`Opnex local state at ${statePath} has an unsupported format. Preserve or restore a supported state file before restarting; it will not be replaced automatically.`);
  }
  try {
    const containedRawReasoning=value.tasks.some((task:any)=>Array.isArray(task.reasoningRawContent)&&task.reasoningRawContent.length>0||Array.isArray(task.passes)&&task.passes.some((pass:any)=>Array.isArray(pass.reasoningRawContent)&&pass.reasoningRawContent.length>0));
    current = upgradeStoredState(value);
    // Validate the normalized state too. Version-specific shape validation
    // permits only explicit migration defaults; consumers receive a complete
    // current-version state after upgrade.
    if(!hasSupportedStoredShape(current))throw new Error('The migrated state does not satisfy the current state schema.');
    // Persist every normalization that changes the stored state, including
    // v3 in-flight task recovery. Otherwise restart recovery would only exist
    // in memory and a later crash could replay the same active state again.
    if(containedRawReasoning||JSON.stringify(current)!==JSON.stringify(value))await persistStateMigration(source,current);
  } catch(error) {
    current=structuredClone(defaults);
    throw new Error(`Opnex local state at ${statePath} could not be migrated safely. Preserve or repair this file before restarting; it will not be replaced automatically.`,{cause:error});
  }
  loaded = true;
  return structuredClone(current);
}
async function persistStateMigration(original:string,state:State){
  const backup=`${statePath}.pre-migration-${Date.now()}-${randomUUID()}.bak`;
  await writeFile(backup,original,{flag:'wx',mode:0o600});
  const tmp=`${statePath}.${randomUUID()}.tmp`;
  try{await writeFile(tmp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await rename(tmp,statePath);}
  catch(error){try{await rm(tmp,{force:true});}catch{/* Preserve the original persistence error. */}throw error;}
}
function recoverQualityLoopAfterRestart(pass:TaskPass,at:string,possiblyActiveCorrectionPlanner?:{threadId?:string;turnId?:string}){
  const loop=pass.qualityLoop;if(!loop)return;
  const running=loop.rounds.find(round=>round.status==='starting'||round.status==='auditing');
  if(running){running.status='paused_after_restart';running.completedAt=at;running.error='The kernel restarted before this QA audit returned. Resume starts a new independent audit; no saved result was inferred.';loop.resumeAction='audit';loop.status='paused_after_restart';loop.terminalReason=running.error;return;}
  const latest=loop.rounds.at(-1);
  if(['awaiting_corrections','paused','paused_after_restart','needs_attention'].includes(loop.status)&&latest?.status==='awaiting_corrections'&&latest.findings?.length){
    const knownNotDispatched=loop.correctionPlannerNotDispatchedRoundId===latest.roundId,currentPlanner=loop.correctionPlanner?.roundId===latest.roundId?loop.correctionPlanner:undefined;
    const legacyPausedWithoutDispatch=!knownNotDispatched&&!currentPlanner&&loop.resumeAction==='corrections'&&['paused','paused_after_restart'].includes(loop.status);
    if((possiblyActiveCorrectionPlanner||legacyPausedWithoutDispatch)&&!currentPlanner)loop.correctionPlanner={roundId:latest.roundId,status:'dispatch_unknown',threadId:possiblyActiveCorrectionPlanner?.threadId||pass.orchestratorThreadId,...(possiblyActiveCorrectionPlanner?.turnId?{turnId:possiblyActiveCorrectionPlanner.turnId}:{})};
    if(currentPlanner?.status==='preflight'){loop.correctionPlanner=undefined;loop.correctionPlannerNotDispatchedRoundId=latest.roundId;}
    else if(!currentPlanner&&!possiblyActiveCorrectionPlanner&&!legacyPausedWithoutDispatch)loop.correctionPlannerNotDispatchedRoundId=latest.roundId;
    const ambiguous=qualityCorrectionPlannerMayHaveBeenSent(loop.correctionPlanner);
    loop.status='paused_after_restart';loop.resumeAction='corrections';loop.terminalReason=ambiguous?'The kernel restarted after a QA correction planner turn may have been sent. Resume is unavailable until the exact turn is confirmed stopped; saved findings are preserved.':'The kernel restarted after actionable QA findings were saved and before correction planning began. Resume will reuse the saved findings.';
    if(qualityLoopResumeAction(loop)!=='corrections'&&!ambiguous)loop.resumeAction=undefined;
    return;
  }
  if(loop.status==='awaiting_audit'&&pass.recruitmentTeam?.status==='complete'&&pass.recruitmentTeam.integration.status==='complete'){
    loop.status='paused_after_restart';loop.resumeAction='audit';loop.terminalReason='The kernel restarted before the next QA audit began. Resume will audit the saved integration.';return;
  }
  if(loop.status==='correcting'){
    loop.status='needs_attention';loop.resumeAction=undefined;loop.terminalReason='The kernel restarted while QA correction workers were running. Their saved branches and receipts were preserved, but this runtime cannot safely resume an interrupted provider session; inspect the team and start a deliberate follow-up.';
  }
}
function moveLegacyAgentMemFields(record:Record<string,any>,fields:Record<string,string>){
  const historical=isStoredRecord(record.legacyAgentMem)?{...record.legacyAgentMem}:{};
  for(const [field,key] of Object.entries(fields))if(field in record){if(!(key in historical))historical[key]=record[field];delete record[field];}
  if(Object.keys(historical).length)record.legacyAgentMem=historical;else delete record.legacyAgentMem;
  return historical;
}
function migrateLegacyExecutionRecord(record:any){
  if(!isStoredRecord(record))return undefined;
  const legacy=moveLegacyAgentMemFields(record,{workerContextStatus:'workerContextStatus',workerContextSummary:'workerContextSummary',contextStatus:'contextStatus',contextSummary:'contextSummary'});
  if(record.workerStage==='context_plan'||record.workerStage==='context_compose'){legacy.workerStage=record.workerStage;delete record.workerStage;}
  if(['context_plan','context_compose'].includes(record.status)){legacy.status=record.status;record.status='paused_after_restart';}
  if(Array.isArray(record.deepSeekPhaseRuns)){
    const oldRuns=record.deepSeekPhaseRuns.filter((run:any)=>run.stage!=='execute');
    if(oldRuns.length){legacy.deepSeekPhaseRuns=oldRuns;record.deepSeekPhaseRuns=record.deepSeekPhaseRuns.filter((run:any)=>run.stage==='execute');}
    for(const run of record.deepSeekPhaseRuns){if('latestNonAgentMemToolSequence'in run){(run.legacyAgentMem??={}).latestNonAgentMemToolSequence=run.latestNonAgentMemToolSequence;delete run.latestNonAgentMemToolSequence;}}
  }
  return legacy;
}
function migrateLegacyTeamBinding(team:any){
  if(!isStoredRecord(team))return undefined;
  const legacy=moveLegacyAgentMemFields(team,{agentmemProjectId:'projectId'});
  for(const record of [...(Array.isArray(team.workers)?team.workers:[]),team.integration]){
    const recordLegacy=migrateLegacyExecutionRecord(record);
    if(recordLegacy&&Object.keys(recordLegacy).length)(record.legacyAgentMem??={...recordLegacy});
  }
  if(Object.keys(legacy).length)return legacy;
  return undefined;
}
function auditShowsAgentMemUse(pass:any){const audit=pass?.agentmemAudit;return !!audit&&(audit.identityStatus==='verified'||!!audit.verifiedProjectId||!!audit.calls?.length||!!audit.contexts?.some((row:any)=>row.status==='retrieved'||row.status==='supplied'));}
function legacyRecordShowsServiceUse(value:unknown){return isStoredRecord(value)&&Object.values(value).some(item=>item!==undefined&&item!==null&&item!==''&&item!==false);}
export function upgradeStoredState(value:any):State{
  const originalProjects=(Array.isArray(value.projects)?value.projects:[]).filter((row:any)=>value.version>=5?isProject(row):value.version===4?isV4Project(row):isLegacyProject(row));
  const legacyProjectBindings=new Map<string,string>(originalProjects.map((row:any)=>[row.id,row.agentmemEnabled&&typeof row.agentmemProjectId==='string'?row.agentmemProjectId:'']));
  let migratedProjects:Project[]=originalProjects.map((row:any)=>{
    const historical=isStoredRecord(row.legacyAgentMem)?{...row.legacyAgentMem}:{};
    if(typeof row.agentmemProjectId==='string')historical.projectId=row.agentmemProjectId;
    if(typeof row.agentmemEnabled==='boolean')historical.enabled=row.agentmemEnabled;
    if(typeof row.agentmemAutoSetup==='boolean')historical.autoSetup=row.agentmemAutoSetup;
    return {id:row.id,name:projectDisplayName(row.projectRoot)||row.name,projectRoot:row.projectRoot,needsLocation:value.version>=4?row.needsLocation:!projectDirectoryExists(row.projectRoot),pinned:row.pinned,createdAt:row.createdAt,updatedAt:row.updatedAt,...(Object.keys(historical).length?{legacyAgentMem:historical}:{})};
  });
  let selectedProjectId: string|null=typeof value.selectedProjectId==='string'?value.selectedProjectId:null;
  const legacySettings=value.settings||{};
  const globalRoot=typeof legacySettings.projectRoot==='string'?legacySettings.projectRoot:'';
  const globalAgentMemId=typeof legacySettings.agentmemProjectId==='string'?legacySettings.agentmemProjectId:'';
  const rootRows=new Map<string,{root:string;ids:Set<string>}>();
  const includeRoot=(root:string,identity:string)=>{
    const key=projectPathKeyForMigration(root);if(!key)return;
    const row=rootRows.get(key)||{root,ids:new Set<string>()};if(identity)row.ids.add(identity);rootRows.set(key,row);
  };
  if(value.version<4){
    for(const oldTask of value.tasks||[]){const root=typeof oldTask.userRoot==='string'?oldTask.userRoot:'';const identity=typeof oldTask.agentmemProjectId==='string'?oldTask.agentmemProjectId:(root&&sameProjectRoot(root,globalRoot)?globalAgentMemId:'');includeRoot(root,identity);}
    if(globalRoot)includeRoot(globalRoot,globalAgentMemId);
  }
  for(const row of rootRows.values()){
    if(row.ids.size>1||migratedProjects.some(project=>sameProjectRoot(project.projectRoot,row.root)))continue;
    const now=new Date().toISOString(),projectId=[...row.ids][0]||'';const project={id:randomUUID(),name:projectDisplayName(row.root),projectRoot:row.root,needsLocation:!projectDirectoryExists(row.root),pinned:false,createdAt:now,updatedAt:now,...(projectId?{legacyAgentMem:{projectId,enabled:true,source:'legacy-root-binding'}}:{})};migratedProjects.push(project);legacyProjectBindings.set(project.id,projectId);
  }
  if(selectedProjectId&&!migratedProjects.some(row=>row.id===selectedProjectId))selectedProjectId=null;
  const globalProjects=migratedProjects.filter(project=>sameProjectRoot(project.projectRoot,globalRoot));
  if(!selectedProjectId&&globalProjects.length===1)selectedProjectId=globalProjects[0].id;
  const tasks=(value.tasks||[]).map((t:any)=>{
    const userRoot=typeof t.userRoot==='string'?t.userRoot:'';
    const oldTaskBinding=typeof t.agentmemProjectId==='string'?t.agentmemProjectId:(typeof t.projectId==='string'?legacyProjectBindings.get(t.projectId)||'':sameProjectRoot(userRoot,globalRoot)?globalAgentMemId:'');
    const task={...t,userRoot,sessionType:value.version<6?'conversation':t.sessionType==='forge'?'forge':'conversation'} as Task;
    if(task.sessionType==='forge'){
      task.forge=forgeTicketSchema.parse(task.forge);
      task.toolCalls??=createToolCallLog();
    }
    const taskLegacy=moveLegacyAgentMemFields(task as any,{agentmemProjectId:'projectId',agentmemTaskId:'taskId',agentmemLease:'lease',agentmemRecordStatus:'recordStatus',agentmemRecordError:'recordError',agentmemReceiptId:'receiptId'});
    if(oldTaskBinding&&typeof t.agentmemProjectId!=='string'&&taskLegacy.projectId===undefined){taskLegacy.projectId=oldTaskBinding;task.legacyAgentMem=taskLegacy;}
    const taskContextLegacy=migrateLegacyExecutionRecord(task);
    if(taskContextLegacy&&Object.keys(taskContextLegacy).length)Object.assign(taskLegacy,taskContextLegacy);
    if(value.version<5&&oldTaskBinding)task.requiresFreshSession=true;
    if(value.version<5&&legacyRecordShowsServiceUse(taskContextLegacy))task.requiresFreshSession=true;
    if(value.version===1){
      task.userMessages=Array.isArray(t.userMessages)?t.userMessages:[];
      task.messages=Array.isArray(t.messages)?t.messages:[];
      task.updatedAt=typeof t.updatedAt==='string'?t.updatedAt:task.createdAt;
      task.correctionCount=Number.isInteger(t.correctionCount)&&t.correctionCount>=0?t.correctionCount:0;
      task.processedTurns=Array.isArray(t.processedTurns)?t.processedTurns:[];
      for(const message of task.messages)if(!message.createdAt)message.createdAt=task.createdAt;
    }
    if(!isDate(task.lastInteractedAt)){const lastUserTime=(task.messages||[]).reduce((latest:number,message:any)=>message.role==='user'&&isDate(message.createdAt)?Math.max(latest,Date.parse(message.createdAt)):latest,Date.parse(task.createdAt));task.lastInteractedAt=new Date(lastUserTime).toISOString();}
    if(task.sessionType!=='forge'){
      if(!Array.isArray(task.passes)||task.passes.length===0){
        task.passes=[{id:randomUUID(),index:1,createdAt:task.createdAt,userInput:task.userMessages?.[0]||task.title,userInputs:[...(task.userMessages||[])],userMessageIds:[],phase:task.phase,approvalPolicy:savedApprovalPolicy(value.settings?.approvalPolicy),legacyUnassociated:true,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,reasoningSummaries:task.reasoningSummaries,reasoningTurns:task.reasoningTurns,liveActivity:task.liveActivity,correctionCount:task.correctionCount||0,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,processedTurns:[...(task.processedTurns||[])],...(taskLegacy?{legacyAgentMem:structuredClone(taskLegacy)}:{})}];
        task.currentPassId=undefined;
      }
      for(const pass of task.passes){
        pass.approvalPolicy=savedApprovalPolicy(pass.approvalPolicy??value.settings?.approvalPolicy);pass.accessMode=pass.accessMode??accessModeFromApproval(pass.approvalPolicy);if(pass.agentContextVersion!==1)pass.agentContextVersion=0;
        pass.executionProfile=legacyPassExecutionProfile(task,pass);
        const passLegacy=moveLegacyAgentMemFields(pass as any,{agentmemTaskId:'taskId',agentmemLease:'lease',agentmemRecordStatus:'recordStatus',agentmemRecordError:'recordError',agentmemReceiptId:'receiptId',agentmemSetupMode:'setupMode',agentmemSetupTurnId:'setupTurnId'});
        const passContextLegacy=migrateLegacyExecutionRecord(pass);if(passContextLegacy&&Object.keys(passContextLegacy).length)Object.assign(passLegacy,passContextLegacy);
        const teamLegacy=migrateLegacyTeamBinding(pass.recruitmentTeam);for(const team of pass.recruitmentHistory||[])migrateLegacyTeamBinding(team);
        if(value.version<5&&auditShowsAgentMemUse(pass))task.requiresFreshSession=true;
        if(value.version<5&&(legacyRecordShowsServiceUse(passLegacy)||legacyRecordShowsServiceUse(teamLegacy)))task.requiresFreshSession=true;
      }
    }
    if(task.sessionType!=='forge')for(const message of task.messages||[])if(message.role==='user'&&message.submissionKind==='steering'&&message.deliveryStatus==='pending'){message.deliveryStatus='unconfirmed';const pass=task.passes?.find(row=>row.id===message.passId);if(pass&&!pass.userMessageIds.includes(message.id)){pass.userInputs.push(message.text);pass.userMessageIds.push(message.id);pass.attachments=[...(pass.attachments||[]),...(message.attachments||[])];}if(!task.userMessages.includes(message.text))task.userMessages.push(message.text);}
    const taskPasses=task.passes||[];
    const current=taskPasses.find(pass=>pass.id===task.currentPassId),possiblyActiveCorrectionPlanner=task.activeRole==='orchestrator'&&current?.qualityLoop?.status==='awaiting_corrections'?{threadId:task.orchestratorThreadId,turnId:task.activeTurnId}:undefined;
    const wasActive=['intake','routing','direct_running','simple_running','planning','worker_running','reviewing'].includes(t.phase),recoveringRestart=wasActive||t.phase==='paused_after_restart';
    if(wasActive){
      task.phase='paused_after_restart';task.activeRole=undefined;task.activeTurnId=undefined;task.approvalRequests=[];
      task.error=current?.agentContextVersion===1?'The process restarted during this turn. Resume explicitly after checking the Codex agent thread.':'This session used an older Codex thread and cannot be resumed with the current Opnex role configuration. Send a follow-up to start a fresh pass.';
    }
    if(recoveringRestart){
      for(const turn of task.reasoningTurns||[])if(turn.status==='streaming')turn.status='interrupted';
      const interruptedAt=new Date().toISOString();for(const activity of task.liveActivity||[])if(activity.status==='running'){activity.status='interrupted';activity.updatedAt=interruptedAt;}
      for(const pass of task.passes||[]){if(pass.toolCalls)pass.toolCalls=interruptRunningToolCalls(pass.toolCalls,interruptedAt);for(const context of pass.agentmemAudit?.contexts||[])if(context.status==='running'){context.status='interrupted';context.updatedAt=interruptedAt;}for(const call of pass.agentmemAudit?.calls||[])if(call.status==='running'){call.status='interrupted';call.updatedAt=interruptedAt;}for(const team of recruitmentTeamsForPass(pass))pauseRecruitmentTeamAfterRestart(team);if(pass.id===task.currentPassId)recoverQualityLoopAfterRestart(pass,interruptedAt,possiblyActiveCorrectionPlanner);}
    }
    const requestedProject=typeof t.projectId==='string'?migratedProjects.find(project=>project.id===t.projectId):undefined;
    const requestedLegacyBinding=typeof t.projectId==='string'?legacyProjectBindings.get(t.projectId):undefined;
    const rootMatches=migratedProjects.filter(project=>sameProjectRoot(project.projectRoot,task.userRoot));
    const compatible=rootMatches.filter(project=>{
      const binding=legacyProjectBindings.get(project.id)||'';return binding===oldTaskBinding;
    });
    if(requestedProject&&sameProjectRoot(requestedProject.projectRoot,task.userRoot)&&(value.version>=5||requestedLegacyBinding===oldTaskBinding))task.projectId=requestedProject.id;
    else if(value.version<4&&compatible.length===1&&rootMatches.length===1)task.projectId=compatible[0].id;
    else delete task.projectId;
    delete (task as any).reasoningRawContent;
    for(const pass of task.passes||[])delete (pass as any).reasoningRawContent;
    syncCurrentPass(task);
    return task;
  });
  const {projectRoot:_oldRoot,agentmemProjectId:_oldAgentMemId,agentmemAutoSetup:_oldAutoSetup,...savedSettings}=legacySettings;
  const settings={...defaults.settings,...savedSettings,approvalPolicy:savedApprovalPolicy(legacySettings.approvalPolicy)};settings.accessMode=savedSettings.accessMode??accessModeFromApproval(settings.approvalPolicy);
  if(!isExecutionProfile(savedSettings.executionProfile))settings.executionProfile=structuredClone(defaults.settings.executionProfile!);
  return {...defaults,...value,version:7,revision:Number.isSafeInteger(value.revision)&&value.revision>=0?value.revision:0,settings,tasks,projects:migratedProjects,selectedProjectId,expandedProjectIds:Array.isArray(value.expandedProjectIds)?[...new Set(value.expandedProjectIds.filter((id:string)=>id==='unclassified'||migratedProjects.some(row=>row.id===id)))]:[...migratedProjects.map(row=>row.id),'unclassified']};
}
function isAbsoluteProjectPath(root:string){return path.isAbsolute(root)||path.win32.isAbsolute(root);}
function projectDirectoryExists(root:string){try{return isAbsoluteProjectPath(root)&&existsSync(root)&&statSync(root).isDirectory();}catch{return false;}}
function projectPathKeyForMigration(root:string){return isAbsoluteProjectPath(root)?projectPathKey(root):null;}
function projectDisplayName(root:string){if(!root.trim())return '';const paths=path.win32.isAbsolute(root)?path.win32:path;return paths.basename(root.replace(/[\\/]+$/,''));}
export function getState() { return structuredClone(current); }
export function getTask(id: string) { return current.tasks.find(t => t.id === id); }
export type ForgeSessionCreateInput=Omit<ForgeTicketCreateInput,'id'|'workspaceRoot'|'createdAt'>&Partial<Pick<ForgeTicketCreateInput,'id'|'workspaceRoot'|'createdAt'>>;
export function createForgeSessionInState(state:State,input:ForgeSessionCreateInput){
  const project=state.projects.find(row=>row.id===input.projectId);
  if(!project)throw new Error('Choose an existing workspace before creating a Forge session.');
  if(project.needsLocation||!project.projectRoot||!projectDirectoryExists(project.projectRoot))throw new Error('Choose an existing working directory for this workspace before creating a Forge session.');
  if(input.workspaceRoot&&!sameProjectRoot(input.workspaceRoot,project.projectRoot))throw new Error('A Forge session must use its selected workspace root.');
  const id=input.id||randomUUID();
  if(state.tasks.some(row=>row.id===id))throw new Error('A session with this ID already exists.');
  const createdAt=input.createdAt||new Date().toISOString();
  const forge=createForgeTicket({...input,id,workspaceRoot:project.projectRoot,approvalPolicy:state.settings.approvalPolicy,accessMode:input.accessMode??forgeAccessModeOf({approvalPolicy:state.settings.approvalPolicy}),createdAt});
  const message:Message={id:randomUUID(),role:'user',text:forge.description,createdAt};
  const task:Task={id,title:forge.title,phase:'accepted',createdAt,updatedAt:createdAt,lastInteractedAt:createdAt,projectId:project.id,sessionType:'forge',forge,toolCalls:createToolCallLog(),userRoot:project.projectRoot,userMessages:[forge.description],messages:[message],correctionCount:0,processedTurns:[]};
  state.tasks.unshift(task);state.activeTaskId=id;
  return task;
}
export function getForgeTicketInState(state:State,taskId:string){
  const task=state.tasks.find(row=>row.id===taskId);
  return task?.sessionType==='forge'&&task.forge?structuredClone(task.forge):undefined;
}
export function applyForgeCommandInState(state:State,taskId:string,command:ForgeCommand,now=new Date().toISOString()){
  const task=state.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge session not found.');
  if(task.sessionType!=='forge'||!task.forge)throw new Error('This session is not a Forge ticket.');
  task.forge=applyForgeCommand(task.forge,command,now);task.updatedAt=now;
  return structuredClone(task.forge);
}
export function recordForgeToolCallInState(state:State,taskId:string,event:ToolCallEvent,updatedAt=new Date().toISOString()){
  const task=state.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge session not found.');
  if(task.sessionType!=='forge'||!task.forge)throw new Error('This session is not a Forge ticket.');
  if(!isDate(updatedAt))throw new Error('Forge tool-call updates require a valid timestamp.');
  task.toolCalls=recordToolCall(task.toolCalls||createToolCallLog(),event);task.updatedAt=updatedAt;
  return structuredClone(task.toolCalls);
}
function forgeApprovalTargetIsActive(ticket:ForgeTicket,request:ForgeApprovalRequest){
  const context=request.forgeContext;
  if(context.targetType==='planning'||context.targetType==='final_review'){
    const run=ticket.orchestratorRuns.find(row=>row.id===context.targetId&&row.purpose===context.targetType);
    return !!run&&ticket.activeOrchestratorRunId===run.id&&['running','unknown_after_restart'].includes(run.status);
  }
  if(context.targetType==='worker_attempt'){
    const attempt=ticket.attempts.find(row=>row.id===context.targetId);
    return !!attempt&&ticket.workitems.some(row=>row.id===attempt.taskId&&row.activeAttemptId===attempt.id)&&['claimed','unknown_after_restart'].includes(attempt.status);
  }
  const run=ticket.integration.runs.find(row=>row.id===context.targetId);
  return !!run&&ticket.integration.activeRunId===run.id&&['running','unknown_after_restart'].includes(run.status);
}
export function recordForgeApprovalRequestInState(state:State,taskId:string,request:ForgeApprovalRequest,now=new Date().toISOString()){
  const task=state.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge session not found.');
  if(task.sessionType!=='forge'||!task.forge)throw new Error('This session is not a Forge ticket.');
  if(!isDate(now)||!isForgeApprovalRequest(request,task.forge)||!forgeApprovalTargetIsActive(task.forge,request))throw new Error('The Forge approval request must match an active or recoverable run/attempt owner, claim, thread, and turn.');
  const existing=task.approvalRequests?.find(row=>row.requestId===request.requestId&&row.itemId===request.itemId);
  if(existing){
    if(JSON.stringify(existing)===JSON.stringify(request))return structuredClone(request);
    throw new Error('A Forge approval request ID cannot be reused for different runtime content.');
  }
  task.approvalRequests=[...(task.approvalRequests||[]),structuredClone(request)];task.updatedAt=now;
  return structuredClone(request);
}
export function resolveForgeApprovalRequestInState(state:State,taskId:string,requestId:string|number,context:ForgeApprovalIdentity,now=new Date().toISOString()){
  const task=state.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge session not found.');
  if(task.sessionType!=='forge'||!task.forge)throw new Error('This session is not a Forge ticket.');
  if(!isDate(now))throw new Error('Forge approval updates require a valid timestamp.');
  const index=(task.approvalRequests||[]).findIndex(request=>request.requestId===requestId&&request.forgeContext?.ticketId===context.ticketId&&request.forgeContext.targetType===context.targetType&&request.forgeContext.targetId===context.targetId&&request.forgeContext.ownerId===context.ownerId&&request.forgeContext.claimToken===context.claimToken&&request.threadId===context.threadId&&request.turnId===context.turnId);
  if(index<0)throw new Error('The Forge approval response is stale or belongs to a different run, owner, or claim.');
  const request=task.approvalRequests![index] as ForgeApprovalRequest;
  if(!isForgeApprovalRequest(request,task.forge)||!forgeApprovalTargetIsActive(task.forge,request)||!['planning','review','running','integrating'].includes(task.forge.phase))throw new Error('The Forge approval request is stale or its run is not active.');
  task.approvalRequests=task.approvalRequests!.filter((_row,rowIndex)=>rowIndex!==index);task.updatedAt=now;
  return structuredClone(request);
}
export function clearForgeApprovalAfterProviderCancellationInState(state:State,taskId:string,requestId:string|number,itemId:string,context:ForgeApprovalIdentity,confirmation:{status:'stopped'|'completed';evidence:string},now=new Date().toISOString()){
  const task=state.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('Forge session not found.');
  if(task.sessionType!=='forge'||!task.forge)throw new Error('This session is not a Forge ticket.');
  if(!isDate(now)||!confirmation.evidence.trim())throw new Error('Confirmed Forge approval cancellation requires valid evidence and timestamp.');
  if(confirmation.status!=='stopped'&&confirmation.status!=='completed')throw new Error('Uncertain provider cancellation cannot clear a pending Forge approval.');
  const exact=(request:ApprovalRequest)=>request.requestId===requestId&&request.itemId===itemId&&request.forgeContext?.ticketId===context.ticketId&&request.forgeContext.targetType===context.targetType&&request.forgeContext.targetId===context.targetId&&request.forgeContext.ownerId===context.ownerId&&request.forgeContext.claimToken===context.claimToken&&request.threadId===context.threadId&&request.turnId===context.turnId;
  const index=(task.approvalRequests||[]).findIndex(exact);
  if(index<0){
    if((task.approvalRequests||[]).some(request=>request.requestId===requestId&&request.itemId===itemId))throw new Error('The Forge approval cancellation is stale or belongs to a different run, owner, claim, thread, or turn.');
    return undefined;
  }
  const request=task.approvalRequests![index] as ForgeApprovalRequest;
  if(!isForgeApprovalRequest(request,task.forge))throw new Error('The Forge approval request failed its saved ownership validation.');
  const owner=context.targetType==='planning'||context.targetType==='final_review'
    ?task.forge.orchestratorRuns.find(run=>run.id===context.targetId&&run.purpose===context.targetType&&run.ownerId===context.ownerId)
    :context.targetType==='integration'
      ?task.forge.integration.runs.find(run=>run.id===context.targetId&&run.ownerId===context.ownerId)
      :task.forge.attempts.find(attempt=>attempt.id===context.targetId&&attempt.claim.ownerId===context.ownerId&&attempt.claim.token===context.claimToken);
  const terminal=owner&&(context.targetType==='worker_attempt'
    ?['finished','failed','interrupted','preflight_failed'].includes(owner.status)
    :['completed','failed','interrupted'].includes(owner.status));
  if(!terminal)throw new Error('A Forge approval can be cleared only after its exact provider owner is confirmed stopped or completed.');
  task.approvalRequests=task.approvalRequests!.filter((_row,rowIndex)=>rowIndex!==index);task.updatedAt=now;
  return structuredClone(request);
}
export function recoverForgeSessionsAfterRestartInState(state:State,now=new Date().toISOString()){
  const recovered:string[]=[];
  for(const task of state.tasks){
    if(task.sessionType!=='forge'||!task.forge)continue;
    const hasUnreconciledAttempt=task.forge.attempts.some(attempt=>attempt.status==='claimed');
    const activeOrchestratorRun=task.forge.orchestratorRuns.find(run=>run.id===task.forge!.activeOrchestratorRunId);
    const hasUnreconciledOrchestrator=!!activeOrchestratorRun&&(activeOrchestratorRun.status==='prepared'||activeOrchestratorRun.status==='running');
    const hasUnreconciledMerge=!!task.forge.integration.mergeIntent&&!task.forge.attentionReason?.startsWith('The final merge status is unknown after restart.');
    const activeRun=task.forge.integration.runs.find(run=>run.id===task.forge!.integration.activeRunId);
    const hasUnreconciledIntegration=!!activeRun&&(activeRun.status==='prepared'||activeRun.status==='running');
    const hasRunningToolCall=(task.toolCalls?.statusCounts.started||0)>0;
    if(!hasUnreconciledAttempt&&!hasUnreconciledMerge&&!hasUnreconciledIntegration&&!hasUnreconciledOrchestrator&&!hasRunningToolCall)continue;
    applyForgeCommandInState(state,task.id,{type:'recover_after_restart',actor:{role:'host',id:'state-recovery'}},now);
    if(hasRunningToolCall){task.toolCalls=interruptRunningToolCalls(task.toolCalls!,now);task.updatedAt=now;}
    recovered.push(task.id);
  }
  return recovered;
}
export async function createForgeSession(input:ForgeSessionCreateInput){
  let created:Task|undefined;
  await mutate(state=>{created=createForgeSessionInState(state,input);});
  return structuredClone(created!);
}
export async function mutateForgeSession(taskId:string,command:ForgeCommand,now=new Date().toISOString()){
  let ticket:ForgeTicket|undefined;
  await mutate(state=>{ticket=applyForgeCommandInState(state,taskId,command,now);});
  return structuredClone(ticket!);
}
export async function recordForgeToolCall(taskId:string,event:ToolCallEvent,updatedAt=new Date().toISOString()){
  let toolCalls:ToolCallLog|undefined;
  await mutate(state=>{toolCalls=recordForgeToolCallInState(state,taskId,event,updatedAt);});
  return structuredClone(toolCalls!);
}
export async function recordForgeApprovalRequest(taskId:string,request:ForgeApprovalRequest,now=new Date().toISOString()){
  let saved:ForgeApprovalRequest|undefined;
  await mutate(state=>{saved=recordForgeApprovalRequestInState(state,taskId,request,now);});
  return structuredClone(saved!);
}
export async function resolveForgeApprovalRequest(taskId:string,requestId:string|number,context:ForgeApprovalIdentity,now=new Date().toISOString()){
  let resolved:ForgeApprovalRequest|undefined;
  await mutate(state=>{resolved=resolveForgeApprovalRequestInState(state,taskId,requestId,context,now);});
  return structuredClone(resolved!);
}
export async function recoverForgeSessionsAfterRestart(now=new Date().toISOString()){
  let recovered:string[]=[];
  await mutate(state=>{recovered=recoverForgeSessionsAfterRestartInState(state,now);});
  return recovered;
}
export function pauseActiveTasksForKernelShutdown(state:State,at=new Date().toISOString()){
  let paused=recoverForgeSessionsAfterRestartInState(state,at).length;
  for(const task of state.tasks){
    if(task.sessionType==='forge')continue;
    const active=['intake','routing','direct_running','simple_running','planning','worker_running','reviewing'].includes(task.phase)||!!task.activeRole||!!task.activeTurnId||!!task.approvalRequests?.length;
    if(!active){if(task.phase==='paused_after_restart'){const pass=currentPass(task);if(pass)recoverQualityLoopAfterRestart(pass,at);syncCurrentPass(task);}continue;}
    const pass=currentPass(task),possiblyActiveCorrectionPlanner=task.activeRole==='orchestrator'&&pass?.qualityLoop?.status==='awaiting_corrections'?{threadId:task.orchestratorThreadId,turnId:task.activeTurnId}:undefined;
    if(pass&&task.approvalRequests?.length)pass.interruptedApprovals=[...(pass.interruptedApprovals||[]),...structuredClone(task.approvalRequests)];
    task.phase='paused_after_restart';task.activeRole=undefined;task.activeTurnId=undefined;task.approvalRequests=[];
    task.error='The kernel was explicitly stopped before this pass completed. Saved messages, receipts, and audit records remain available; send a follow-up to continue.';
    for(const turn of task.reasoningTurns||[])if(turn.status==='streaming')turn.status='interrupted';
    for(const activity of task.liveActivity||[])if(activity.status==='running'){activity.status='interrupted';activity.updatedAt=at;}
    for(const row of task.passes||[]){
      for(const turn of row.reasoningTurns||[])if(turn.status==='streaming')turn.status='interrupted';
      if(row.toolCalls)row.toolCalls=interruptRunningToolCalls(row.toolCalls,at);for(const activity of row.liveActivity||[])if(activity.status==='running'){activity.status='interrupted';activity.updatedAt=at;}
      for(const context of row.agentmemAudit?.contexts||[])if(context.status==='running'){context.status='interrupted';context.updatedAt=at;}
      for(const call of row.agentmemAudit?.calls||[])if(call.status==='running'){call.status='interrupted';call.updatedAt=at;}
      for(const team of recruitmentTeamsForPass(row))pauseRecruitmentTeamAfterRestart(team);
      if(row.id===task.currentPassId)recoverQualityLoopAfterRestart(row,at,possiblyActiveCorrectionPlanner);
    }
    syncCurrentPass(task);paused++;
  }
  return paused;
}
export function selectProjectInState(state:State,id:string|null){if(id!==null&&!state.projects.some(project=>project.id===id))throw new Error('Project not found.');state.selectedProjectId=id;return id===null?null:state.projects.find(project=>project.id===id)!;}
export function saveProjectInState(state:State,input:Omit<Project,'name'|'createdAt'|'updatedAt'> & Partial<Pick<Project,'name'|'createdAt'|'updatedAt'>>){
  if(!input.id||input.id.length>128||input.projectRoot.length>1024||!input.needsLocation&&!projectPathKey(input.projectRoot))throw new Error('Choose an absolute workspace directory.');
  const existing=state.projects.find(project=>project.id===input.id);const now=new Date().toISOString();
  const project:Project={id:input.id,name:projectDisplayName(input.projectRoot)||input.name?.trim()||existing?.name||'Workspace',projectRoot:input.projectRoot,needsLocation:!!input.needsLocation,pinned:!!input.pinned,createdAt:existing?.createdAt||input.createdAt||now,updatedAt:now,...(existing?.legacyAgentMem?{legacyAgentMem:structuredClone(existing.legacyAgentMem)}:{})};
  if(existing&&!sameProjectRoot(existing.projectRoot,project.projectRoot)&&state.tasks.some(task=>task.projectId===existing.id&&task.sessionType==='forge'&&task.forge&&!['complete','cancelled'].includes(task.forge.phase)))throw new Error('Finish or cancel the Forge ticket before changing its workspace directory.');
  assertProjectIdentityChangeAllowed(existing||project,project,state.tasks);
  const duplicate=(!existing||!sameProjectRoot(existing.projectRoot,project.projectRoot))?state.projects.find(row=>row.id!==project.id&&sameProjectRoot(row.projectRoot,project.projectRoot)):undefined;
  if(duplicate)throw new Error(`This directory already belongs to the workspace "${duplicate.name}". Open that workspace instead of creating a duplicate.`);
  if(existing)state.projects=state.projects.map(row=>row.id===project.id?project:row);else state.projects.push(project);
  return project;
}
export function moveTaskProjectInState(state:State,taskId:string,projectId:string|null){
  const task=state.tasks.find(row=>row.id===taskId);if(!task)throw new Error('Session not found.');
  if(task.sessionType==='forge'&&projectId!==task.projectId)throw new Error('A Forge session remains owned by its original workspace.');
  const project=projectId?state.projects.find(row=>row.id===projectId):undefined;
  if(projectId&&!project)throw new Error('Project not found.');
  if(project&&!sameProjectRoot(task.userRoot,project.projectRoot))throw new Error('This session belongs to a different project directory. Its saved history stays with the original project; start a new session to work in another project.');
  const blocked=['intake','routing','direct_running','simple_running','planning','worker_running','reviewing','escalated','paused_after_restart'].includes(task.phase)||!!task.activeTurnId||!!task.activeRole||!!task.approvalRequests?.length;
  if(blocked)throw new Error('Stop or finish this session, resolve approvals, or explicitly resume it before moving projects. Its current execution keeps the original project context.');
  task.projectId=projectId||undefined;
  task.lastInteractedAt=new Date().toISOString();return task;
}
export function noteTaskInteractionInState(state:State,taskId:string){const task=state.tasks.find(row=>row.id===taskId);if(task)task.lastInteractedAt=new Date().toISOString();}
export function taskDeletionBlockReason(task:Task){
  if(task.sessionType==='forge'&&task.forge&&!['complete','cancelled'].includes(task.forge.phase))return 'Finish or cancel the Forge ticket before deleting this session.';
  if(['intake','routing','direct_running','simple_running','planning','worker_running','reviewing','escalated'].includes(task.phase)||task.activeTurnId||task.activeRole)return 'Stop or finish the active turn before deleting this session.';
  return null;
}
export function renameTaskInState(state:State,id:string,title:string){
  const task=state.tasks.find(x=>x.id===id);if(!task)throw new Error('Session not found.');
  task.title=title;task.updatedAt=new Date().toISOString();task.lastInteractedAt=task.updatedAt;if(task.sessionType==='forge'&&task.forge){task.forge.title=title;task.forge.updatedAt=task.updatedAt;}return task;
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
      fn(current); current.version=7; current.revision+=1; current.tasks.forEach(syncCurrentPass); current.tasks.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
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
export async function createTaskForProject(message:string,projectId:string|null|undefined,attachments:TaskAttachment[]=[],selectedSkills:SavedSkillSnapshot[]=[],qaEnabled=false){
  const id=randomUUID();
  await mutate(state=>{
    const selectedId=projectId;
    const project=selectedId?state.projects.find(row=>row.id===selectedId):undefined;
    if(!selectedId||!project)throw new Error('Select or create a project before starting a session.');
    if(project.needsLocation||!project.projectRoot||!projectDirectoryExists(project.projectRoot))throw new Error('Choose an existing working directory for this project before starting a session.');
    const root=project.projectRoot;
    const approvalPolicy=state.settings.approvalPolicy;const now=new Date().toISOString();const firstMessage={id:randomUUID(),role:'user' as const,text:message,createdAt:now,...(attachments.length?{attachments:structuredClone(attachments)}:{})};
      const created:Task={id,title:message.slice(0,72)||attachments[0]?.name||'Image task',phase:'intake',createdAt:now,updatedAt:now,lastInteractedAt:now,...(project?{projectId:project.id}:{}),sessionType:'conversation',userRoot:root,userMessages:[message],correctionCount:0,processedTurns:[],messages:[firstMessage]};
    beginPass(created,message,firstMessage.id,approvalPolicy,attachments,selectedSkills,deepSeekExecutionProfileForSettings(state.settings),qaEnabled,executionProfileForSettings(state.settings),state.settings.mcpServers||[]);state.tasks.unshift(created);state.activeTaskId=id;
  });
  return getTask(id)!;
}
export function beginPass(task:Task,message:string,userMessageId?:string,approvalPolicy:ApprovalPolicy='on-request',attachments:TaskAttachment[]=[],selectedSkills:SavedSkillSnapshot[]=[],deepSeekExecution:DeepSeekExecutionProfile=deepSeekExecutionProfileForSettings(current.settings),qaEnabled=false,executionProfile:ExecutionProfile=executionProfileForSettings(current.settings),mcpServers:McpServerRegistration[]=current.settings.mcpServers||[],deepSeekConversationStorage:DeepSeekConversationStoragePreference=deepSeekConversationStorageForSettings(current.settings)){
  if(task.sessionType==='forge')throw new Error('Forge sessions use persisted ticket transitions instead of Conversation passes.');
  const now=new Date().toISOString();const pass:TaskPass={id:randomUUID(),index:(task.passes?.reduce((n,p)=>Math.max(n,p.index),0)||0)+1,createdAt:now,userInput:message,userInputs:[message],userMessageIds:userMessageId?[userMessageId]:[],attachments,selectedSkills:structuredClone(selectedSkills),loadedSkills:[],toolCalls:createToolCallLog(),executionProfile:structuredClone(executionProfile),deepSeekConversationStorage:structuredClone(deepSeekConversationStorage),mcpServers:structuredClone(mcpServers),phase:'intake',qualityLoop:{enabled:qaEnabled,status:qaEnabled?'awaiting_audit':'disabled',rounds:[],maxRounds:5},approvalPolicy:runtimeApprovalForAccess(current.settings.accessMode??accessModeFromApproval(approvalPolicy)),accessMode:current.settings.accessMode??accessModeFromApproval(approvalPolicy),deepSeekExecution:structuredClone(deepSeekExecution),agentContextVersion:1,correctionCount:0,processedTurns:[]};
  task.passes=[...(task.passes||[]),pass];task.currentPassId=pass.id;
  task.phase='intake';task.routeDecision=undefined;task.executionEscalation=undefined;task.assignment=undefined;task.receipt=undefined;task.reviewNote=undefined;task.resolution=undefined;task.routingNote=undefined;task.workerStage=undefined;task.reasoningSummaries=[];task.reasoningTurns=[];task.liveActivity=[];task.activeModelId=undefined;task.activeEffort=undefined;task.correctionCount=0;task.routerThreadId=undefined;task.directThreadId=undefined;task.simpleThreadId=undefined;task.orchestratorThreadId=undefined;task.workerThreadId=undefined;task.activeTurnId=undefined;task.activeRole=undefined;task.processedTurns=[];task.error=undefined;task.escalation=undefined;task.approvalRequests=[];task.pendingRevision=false;
  if(userMessageId){const msg=task.messages.find(m=>m.id===userMessageId);if(msg)msg.passId=pass.id;}
  return pass;
}
export function currentPass(task:Task){return task.passes?.find(p=>p.id===task.currentPassId);}
export function recruitmentTeamsForPass(pass:TaskPass){return [...(pass.recruitmentHistory||[]),...(pass.recruitmentTeam?[pass.recruitmentTeam]:[])];}
function passThreadIds(pass:TaskPass){return [pass.routerThreadId,pass.directThreadId,pass.simpleThreadId,pass.orchestratorThreadId,pass.workerThreadId,...recruitmentTeamsForPass(pass).flatMap(team=>[...team.workers.map(worker=>worker.threadId),team.integration.threadId]),...(pass.qualityLoop?.rounds.map(round=>round.threadId)||[])].filter((value):value is string=>!!value);}
export function passForThread(task:Task,threadId:string){return task.passes?.find(p=>passThreadIds(p).includes(threadId));}
export function isCurrentPassThread(task:Task,threadId:string){const pass=currentPass(task);return !!pass&&passThreadIds(pass).includes(threadId);}
export function passThreadRole(pass:TaskPass,threadId:string):WorkflowRole|undefined{const legacy=(['router','direct','simple','orchestrator','worker'] as const).find(role=>pass[`${role}ThreadId` as 'routerThreadId'|'directThreadId'|'simpleThreadId'|'orchestratorThreadId'|'workerThreadId']===threadId);return legacy||(recruitmentTeamsForPass(pass).some(team=>team.workers.some(worker=>worker.threadId===threadId)||team.integration.threadId===threadId)?'worker':pass.qualityLoop?.rounds.some(round=>round.threadId===threadId)?'orchestrator':undefined);}
export function syncCurrentPass(task:Task){
  const p=currentPass(task);if(!p)return;
  Object.assign(p,{phase:task.phase,routeDecision:task.routeDecision,executionEscalation:task.executionEscalation,assignment:task.assignment,receipt:task.receipt,reviewNote:task.reviewNote,resolution:task.resolution,routingNote:task.routingNote,error:task.error,escalation:task.escalation,workerStage:task.workerStage,reasoningSummaries:structuredClone(task.reasoningSummaries||[]),reasoningTurns:structuredClone(task.reasoningTurns||[]),liveActivity:structuredClone(task.liveActivity||[]),correctionCount:task.correctionCount,routerThreadId:task.routerThreadId,directThreadId:task.directThreadId,simpleThreadId:task.simpleThreadId,orchestratorThreadId:task.orchestratorThreadId,workerThreadId:task.workerThreadId,activeTurnId:task.activeTurnId,activeRole:task.activeRole,processedTurns:[...task.processedTurns]});
}
export function addMessage(task: Task, role: Message['role'], text: string, attachments?:TaskAttachment[],passId=task.currentPassId,id:string=randomUUID(),submissionKind?:Message['submissionKind'],deliveryStatus?:Message['deliveryStatus']) { const message:Message={id,role,text,createdAt:new Date().toISOString(),...(passId?{passId}:{}),...(attachments?.length?{attachments:structuredClone(attachments)}:{}),...(submissionKind?{submissionKind}:{}),...(deliveryStatus?{deliveryStatus}:{})};task.messages.push(message);task.updatedAt = message.createdAt;if(role==='user')task.lastInteractedAt=message.createdAt;return message; }
