import {
  AgentMemAuditView,
  AssignmentView,
  Disclosure,
  PassUsagePanel,
  QualityLoopPanel,
  RunReceipt,
} from './PassDetails';
import { Fragment, useEffect, useState } from 'react';
import { Activity, AlertCircle, Check, Command } from 'lucide-react';
import { Markdown } from './Markdown';
import { RecruitmentTeamPanel } from './RecruitmentTeamPanel';
import { ToolCallLogView, toolCallLogTitle } from './ToolCallLogView';
import { formatReadOnlyWorkerResults } from '../../server/read-only-results.js';
import {
  compactModelName,
  deepSeekProviderName,
  executionDescriptor,
  executionModelName,
  executionRoleName,
} from './model-display';
import type {
  DeepSeekExecutionProfile,
  ExecutionProfile,
  LiveActivity,
  Message,
  ReasoningTurn,
  Task,
  TaskPass,
} from '../types';

const phaseText: Record<string, string> = {
  intake: 'Ready',
  routing: 'Routing request',
  direct_running: 'Answering directly',
  simple_running: 'Simple implementation running',
  planning: 'Planning hard task',
  worker_running: 'Worker running · orchestrator idle',
  escalated: 'Decision needed',
  reviewing: 'Reviewing receipt',
  accepted: 'Accepted',
  needs_attention: 'Needs attention',
  cancelled: 'Cancelled',
  paused_after_restart: 'Paused after restart',
};
const phaseHue: Record<string, string> = {
  intake: 'ash',
  routing: 'slate',
  direct_running: 'teal',
  simple_running: 'slate',
  planning: 'slate',
  worker_running: 'sand',
  escalated: 'sand',
  reviewing: 'teal',
  accepted: 'sage',
  needs_attention: 'clay',
  cancelled: 'ash',
  paused_after_restart: 'ash',
};
const routeHue: Record<string, string> = {
  direct_answer: 'teal',
  simple_implementation: 'slate',
  hard_task: 'sand',
  escalated: 'sand',
};
const statusHue = (text?: string) =>
  !text
    ? undefined
    : text === 'Recruiting workers' || text === 'Waiting for workers'
      ? 'sand'
      : text === 'Reviewing worker receipts' || text === 'Auditing corrections'
        ? 'teal'
        : text === 'Drafting assignments'
          ? 'slate'
          : undefined;
const formatMessageTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value)
  );

function passOutputForDisplay(pass: TaskPass) {
  const output = pass.publicAnswer || pass.receipt?.result || '';
  const team = pass.recruitmentTeam,
    marker = 'Read-only worker results (no Git worktree or integration step):';
  const workers = team?.workers,
    bundle = team?.workerReceiptBundle;
  if (
    team?.mode !== 'read_only' ||
    !Array.isArray(workers) ||
    !Array.isArray(bundle) ||
    !workers.length ||
    workers.length !== bundle.length
  )
    return output;
  const matches = workers.every((worker, index) => {
    const record = bundle[index];
    return (
      !!record &&
      record.workerId === worker.workerId &&
      record.name === worker.name &&
      record.status === worker.status &&
      record.receipt?.result === worker.receipt?.result
    );
  });
  if (!matches) return output;
  const markerAt = output.lastIndexOf(marker);
  if (markerAt < 0) return output;
  let captured: unknown;
  try {
    captured = JSON.parse(output.slice(markerAt + marker.length).trim());
  } catch {
    return output;
  }
  if (!Array.isArray(captured) || captured.length !== bundle.length) return output;
  const capturedMatches = captured.every((record, index) => {
    const expected = bundle[index];
    return (
      !!record &&
      !!expected &&
      record.workerId === expected.workerId &&
      record.name === expected.name &&
      record.status === expected.status &&
      record.headCommit === null &&
      record.receipt?.status === expected.receipt.status &&
      record.receipt?.result === expected.receipt.result &&
      record.producer?.threadId === expected.producer?.threadId &&
      record.producer?.turnId === expected.producer?.turnId &&
      record.producer?.teamId === expected.producer?.teamId &&
      record.producer?.passId === expected.producer?.passId
    );
  });
  if (!capturedMatches) return output;
  return formatReadOnlyWorkerResults(
    bundle.map((record) => ({
      name: record.name,
      status: record.status,
      receipt: record.receipt,
      error: workers.find((worker) => worker.workerId === record.workerId)?.error,
    }))
  );
}
const reasoningTurnKey = (turn: { role: string; threadId: string; turnId: string }) =>
  `${turn.role}\0${turn.threadId}\0${turn.turnId}`;
export function ConversationMessage({
  message: m,
  executionProfile,
  deepSeekExecution,
  actualTurn,
}: {
  message: Message;
  executionProfile?: ExecutionProfile;
  deepSeekExecution?: DeepSeekExecutionProfile;
  actualTurn?: ReasoningTurn;
}) {
  if (m.role === 'user')
    return (
      <div className='message user-message' key={m.id}>
        <div className='message-main'>
          <div className='message-meta'>
            <strong>You</strong>
            <span>{formatMessageTime(m.createdAt)}</span>
            {m.submissionKind === 'steering' && (
              <span className={`model-chip steering-chip ${m.deliveryStatus || 'pending'}`}>
                {m.deliveryStatus === 'steered'
                  ? 'Steered active turn'
                  : m.deliveryStatus === 'unconfirmed'
                    ? 'Steering delivery unconfirmed'
                    : 'Sending steering'}
              </span>
            )}
          </div>
          <div className='message-body markdown-body'>
            <Markdown>{m.text}</Markdown>
          </div>
        </div>
      </div>
    );
  if (m.role === 'system')
    return (
      <div
        className={`system-event ${m.text.startsWith('Worker activity:') ? 'progress-event' : ''}`}
        key={m.id}
      >
        <span className='event-glyph'>
          {m.text.startsWith('Worker activity:') ? (
            <Activity size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
        </span>
        <span>{m.text.replace(/^Worker activity: /, '')}</span>
      </div>
    );
  const actualProvider: 'deepseek' | 'codex' | undefined =
    actualTurn?.provider === 'deepseek' || actualTurn?.requestedModel === 'deepseek-v4.1-flash'
      ? 'deepseek'
      : actualTurn?.provider === 'codex' || actualTurn?.requestedModel.startsWith('gpt-')
        ? 'codex'
        : undefined;
  const turnProfile: ExecutionProfile | undefined =
    actualTurn && actualProvider
      ? {
          provider: actualProvider,
          model: actualTurn.requestedModel,
          effort: actualTurn.requestedEffort as ExecutionProfile['effort'],
        }
      : undefined;
  const profile = actualTurn ? turnProfile : executionProfile;
  const modelChip =
    m.role === 'direct'
      ? turnProfile
        ? executionDescriptor(turnProfile, deepSeekExecution)
        : 'Orchestrator · model unavailable'
      : ['worker', 'simple'].includes(m.role)
        ? turnProfile
          ? executionDescriptor(turnProfile, deepSeekExecution)
          : profile
            ? executionDescriptor(profile, deepSeekExecution)
            : executionDescriptor()
        : undefined;
  const model = actualTurn?.requestedModel || (m.role === 'direct' ? undefined : profile?.model);
  const heading =
    m.role === 'worker'
      ? profile?.provider === 'deepseek'
        ? `DeepSeek Harness worker · ${deepSeekProviderName(deepSeekExecution)}`
        : executionRoleName('worker', model)
      : m.role === 'router'
        ? 'Routing agent'
        : m.role === 'direct'
          ? turnProfile?.provider === 'deepseek'
            ? `DeepSeek Harness direct answer · ${deepSeekProviderName(deepSeekExecution)}`
            : executionRoleName('direct', model)
          : m.role === 'simple'
            ? profile?.provider === 'deepseek'
              ? `DeepSeek Harness simple implementation · ${deepSeekProviderName(deepSeekExecution)}`
              : executionRoleName('simple', model)
            : 'Orchestrator';
  return (
    <div className='message agent-message' key={m.id}>
      <div className='message-main'>
        <div className='message-meta'>
          <strong>{heading}</strong>
          <span>{formatMessageTime(m.createdAt)}</span>
          {modelChip && <span className='model-chip'>{modelChip}</span>}
        </div>
        <div className='message-body markdown-body'>
          <Markdown>{m.text}</Markdown>
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: LiveActivity }) {
  if (item.kind === 'commentary')
    return (
      <div className='live-activity-row commentary' data-activity-id={item.itemId}>
        <span className='live-activity-icon'>
          <Activity size={14} />
        </span>
        <div className='live-activity-main'>
          <div className='live-commentary-text'>{item.text || 'Preparing response…'}</div>
        </div>
      </div>
    );
  const label =
    item.status === 'running'
      ? `Running ${item.title}`
      : item.status === 'failed'
        ? `Failed ${item.title}`
        : item.status === 'interrupted'
          ? `Interrupted ${item.title}`
          : `Ran ${item.title}`;
  const details = [item.detail, item.output].filter(Boolean).join('\n\n');
  return (
    <div className={`live-activity-row tool ${item.status}`} data-activity-id={item.itemId}>
      <span className='live-activity-icon'>
        {item.status === 'running' ? (
          <span className='activity-spinner' />
        ) : item.status === 'failed' ? (
          <AlertCircle size={14} />
        ) : (
          <Check size={14} />
        )}
      </span>
      <div className='live-activity-main'>
        <div className='live-activity-title'>{label}</div>
        {details && (
          <details className='live-activity-details'>
            <summary>Details</summary>
            <pre>{details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
function ReasoningResponse({
  turn,
  turnSummaries,
  activity,
  live,
  fallbackTime,
  status,
  statusHue,
}: {
  turn: NonNullable<TaskPass['reasoningTurns']>[number];
  turnSummaries: NonNullable<TaskPass['reasoningSummaries']>;
  activity: LiveActivity[];
  live: boolean;
  fallbackTime: string;
  status?: string;
  statusHue?: string;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const events = [
    ...turnSummaries.map((summary) => ({
      kind: 'summary' as const,
      at: Date.parse(summary.updatedAt || turn.startedAt || fallbackTime) || 0,
      index: summary.summaryIndex,
      summary,
    })),
    ...activity.map((item, index) => ({
      kind: 'activity' as const,
      at: Date.parse(item.startedAt) || 0,
      index,
      item,
    })),
  ].sort((a, b) => a.at - b.at || a.index - b.index);
  const elapsedSeconds = Math.max(
    0,
    Math.floor((clock - Date.parse(turn.startedAt || fallbackTime)) / 1000)
  );
  const elapsed =
    elapsedSeconds >= 3600
      ? `${Math.floor(elapsedSeconds / 3600)}h`
      : elapsedSeconds >= 60
        ? `${Math.floor(elapsedSeconds / 60)}m`
        : `${elapsedSeconds}s`;
  const durationLabel =
    turn.status === 'interrupted'
      ? 'Interrupted after'
      : turn.status === 'failed'
        ? 'Failed after'
        : live
          ? 'Working for'
          : 'Worked for';
  const deepSeek = turn.provider === 'deepseek';
  const turnLabel = deepSeek
    ? `DeepSeek Harness ${turn.role} · ${turn.provider}`
    : turn.role === 'orchestrator'
      ? 'Orchestrator'
      : executionRoleName(turn.role, turn.requestedModel);
  const modelLabel = deepSeek
    ? `${turn.requestedModel} · ${turn.requestedEffort}`
    : `${executionModelName(turn.requestedModel)} · ${turn.requestedEffort}`;
  return (
    <section
      className={`turn-activity ${live ? 'is-live' : ''}`}
      aria-label={`${turn.role} model response`}
      data-status={turn.status}
      data-role={turn.role}
    >
      <header className='turn-activity-heading'>
        <span>{turnLabel}</span>
        <span className='turn-activity-duration'>
          {durationLabel} {elapsed}
        </span>
        {status && (
          <span className='turn-activity-status' role='status' data-hue={statusHue}>
            <i aria-hidden='true' />
            {status}
          </span>
        )}
        {turn.role !== 'orchestrator' && <span className='model-chip'>{modelLabel}</span>}
      </header>
      <div className='turn-activity-events'>
        {events.map((event) =>
          event.kind === 'summary' ? (
            <div
              className='live-activity-row commentary summary'
              key={`summary:${event.summary.itemId}:${event.summary.summaryIndex}`}
            >
              <span className='live-activity-icon'>
                <Command size={14} />
              </span>
              <div className='live-activity-main'>
                <div className='markdown-body'>
                  <Markdown>{event.summary.text}</Markdown>
                </div>
              </div>
            </div>
          ) : (
            <ActivityRow key={`activity:${event.item.itemId}`} item={event.item} />
          )
        )}
        {!events.length && (
          <div className='reasoning-response-empty'>
            {live
              ? 'Waiting for activity…'
              : turn.status === 'failed'
                ? 'Turn failed.'
                : turn.status === 'interrupted'
                  ? 'Turn interrupted.'
                  : 'No activity details were reported for this turn.'}
          </div>
        )}
      </div>
    </section>
  );
}

export function PassPanel({
  pass: p,
  messages,
  active,
  task,
  receiptExpanded,
  recruitmentTeamExpanded,
  toolCallsExpanded,
  agentmemAuditExpanded,
  selectedSteerWorkerId,
  onSelectSteerWorker,
  onQualityAction,
  toggleReceipt,
  toggleRecruitmentTeam,
  toggleToolCalls,
  toggleAgentMemAudit,
}: {
  pass: TaskPass;
  messages: Message[];
  active: boolean;
  task: Task;
  receiptExpanded: boolean;
  recruitmentTeamExpanded: boolean;
  toolCallsExpanded: boolean;
  agentmemAuditExpanded: boolean;
  selectedSteerWorkerId?: string;
  onSelectSteerWorker: (workerId: string) => void;
  onQualityAction: (action: 'accept' | 'pause' | 'resume') => void;
  toggleReceipt: () => void;
  toggleRecruitmentTeam: () => void;
  toggleToolCalls: () => void;
  toggleAgentMemAudit: () => void;
}) {
  const live =
    active &&
    task.phase === p.phase &&
    [
      'routing',
      'direct_running',
      'simple_running',
      'planning',
      'worker_running',
      'reviewing',
    ].includes(p.phase);
  const selectedExecution = p.executionProfile;
  const output = passOutputForDisplay(p);
  const visibleMessages = messages.filter(
    (m) =>
      !(
        m.role === 'orchestrator' &&
        m.text === 'Prepared a complete assignment.' &&
        (p.reasoningTurns || []).some((turn) => turn.role === 'orchestrator')
      ) &&
      !(output && m.role !== 'user' && m.text === output) &&
      !(p.error && m.role === 'system' && m.text === p.error)
  );
  const turns = p.reasoningTurns || [];
  const summariesByTurn = new Map<string, NonNullable<TaskPass['reasoningSummaries']>>();
  for (const summary of p.reasoningSummaries || []) {
    if (!summary.text.trim()) continue;
    const key = reasoningTurnKey(summary);
    const rows = summariesByTurn.get(key) || [];
    rows.push(summary);
    summariesByTurn.set(key, rows);
  }
  const activitiesByTurn = new Map<string, LiveActivity[]>();
  for (const item of p.liveActivity || []) {
    if (!item.threadId || !item.turnId) continue;
    const key = reasoningTurnKey(item);
    const rows = activitiesByTurn.get(key) || [];
    rows.push(item);
    activitiesByTurn.set(key, rows);
  }
  const messagesByRole = new Map<string, Message[]>();
  const messageIndicesByRole = new Map<string, Map<string, number>>();
  let latestUserMessage: Message | undefined;
  for (const message of visibleMessages) {
    if (message.role === 'user') latestUserMessage = message;
    const rows = messagesByRole.get(message.role) || [];
    const messageIndices = messageIndicesByRole.get(message.role) || new Map<string, number>();
    messageIndices.set(message.id, rows.length);
    rows.push(message);
    messagesByRole.set(message.role, rows);
    messageIndicesByRole.set(message.role, messageIndices);
  }
  const turnsByRoleAndThread = new Map<string, Map<string, ReasoningTurn[]>>();
  for (const turn of turns) {
    const threads = turnsByRoleAndThread.get(turn.role) || new Map<string, ReasoningTurn[]>();
    const roleTurns = threads.get(turn.threadId) || [];
    roleTurns.push(turn);
    threads.set(turn.threadId, roleTurns);
    turnsByRoleAndThread.set(turn.role, threads);
  }
  const turnIndexByKey = new Map<string, number>();
  const roleTurnCounts = new Map<string, number>();
  for (const turn of turns) {
    const key = reasoningTurnKey(turn);
    if (turnIndexByKey.has(key)) continue;
    const index = roleTurnCounts.get(turn.role) || 0;
    turnIndexByKey.set(key, index);
    roleTurnCounts.set(turn.role, index + 1);
  }
  const directTurn = turns
    .filter((turn) => turn.role === 'direct' && turn.threadId === p.directThreadId)
    .at(-1);
  const directOutputLabel = directTurn
    ? `${directTurn.provider === 'deepseek' ? `DeepSeek Harness (${deepSeekProviderName(p.deepSeekExecution)}) · ` : ''}${executionModelName(directTurn.requestedModel)}${directTurn.provider === 'deepseek' ? ` · requested native effort ${directTurn.requestedEffort} · effective effort unknown` : directTurn.requestedEffort ? ` · ${directTurn.requestedEffort}` : ''}`
    : p.directThreadId
      ? 'Orchestrator · model unavailable'
      : 'Orchestrator';
  const simpleOutputLabel = `${executionDescriptor(selectedExecution, p.deepSeekExecution)} · self-verified`;
  const isReadOnlyTeam = p.recruitmentTeam?.mode === 'read_only';
  const finalOutputLabel = isReadOnlyTeam
    ? p.recruitmentTeam!.workers.length === 1
      ? 'Worker response'
      : 'Worker responses'
    : p.resolution === 'direct'
      ? directOutputLabel
      : p.resolution === 'simple'
        ? simpleOutputLabel
        : selectedExecution?.provider === 'deepseek'
          ? `DeepSeek Harness (${deepSeekProviderName(p.deepSeekExecution)}) · reviewed by orchestrator`
          : selectedExecution
            ? `${compactModelName(selectedExecution.model)} · reviewed by orchestrator`
            : 'Model details unavailable · reviewed by orchestrator';
  const timeline = [
    ...visibleMessages.map((message, index) => ({
      kind: 'message' as const,
      at: Date.parse(message.createdAt) || 0,
      index,
      message,
    })),
    ...turns.map((turn, index) => {
      const key = reasoningTurnKey(turn);
      const matchingMessage = messagesByRole.get(turn.role)?.[turnIndexByKey.get(key) || 0];
      const fallbackAt = matchingMessage
        ? (Date.parse(matchingMessage.createdAt) || 0) - 1
        : (Date.parse(latestUserMessage?.createdAt || p.createdAt) || 0) + 1;
      return {
        kind: 'reasoning' as const,
        at: Date.parse(turn.startedAt || '') || fallbackAt,
        index,
        turn,
      };
    }),
  ].sort(
    (a, b) =>
      a.at - b.at || (a.kind !== b.kind ? (a.kind === 'reasoning' ? -1 : 1) : a.index - b.index)
  );
  const workerRows = timeline.filter((row) =>
    row.kind === 'reasoning'
      ? row.turn.role === 'worker'
      : row.message.role === 'worker' ||
        (row.message.role === 'system' && row.message.text.startsWith('Worker activity:'))
  );
  const firstUserMessageId = visibleMessages.find((message) => message.role === 'user')?.id;
  const routeText = p.routeDecision?.justification || p.routingNote || '';
  const orchestratorStatus = live
    ? p.phase === 'planning'
      ? p.recruitmentTeam?.status === 'recruiting' || p.recruitmentTeam?.status === 'starting'
        ? 'Recruiting workers'
        : 'Drafting assignments'
      : p.phase === 'worker_running'
        ? p.recruitmentTeam?.status === 'recruiting' || p.recruitmentTeam?.status === 'starting'
          ? 'Recruiting workers'
          : 'Waiting for workers'
        : p.phase === 'reviewing'
          ? 'Reviewing worker receipts'
          : p.qualityLoop?.status === 'auditing'
            ? 'Auditing corrections'
            : undefined
    : undefined;
  const orchestratorStatusHue = statusHue(orchestratorStatus);
  const workerPanelSummary = p.recruitmentTeam
    ? `${p.recruitmentTeam.workers.length} ${p.recruitmentTeam.workers.length === 1 ? 'worker' : 'workers'} · ${p.recruitmentTeam.status.replaceAll('_', ' ')}`
    : workerRows.length
      ? `${workerRows.length} ${workerRows.length === 1 ? 'worker' : 'workers'}`
      : '';
  const visibleTimeline = timeline.filter((row) =>
    row.kind === 'reasoning'
      ? row.turn.role !== 'worker'
      : row.message.role !== 'worker' &&
        !(row.message.role === 'system' && row.message.text.startsWith('Worker activity:'))
  );
  const messageTurn = (message: Message) => {
    if (message.role !== 'direct' && message.role !== 'simple') return undefined;
    const threadId = message.role === 'direct' ? p.directThreadId : p.simpleThreadId;
    if (!threadId) return undefined;
    const roleIndex = messageIndicesByRole.get(message.role)?.get(message.id);
    return roleIndex === undefined
      ? undefined
      : turnsByRoleAndThread.get(message.role)?.get(threadId)?.[roleIndex];
  };
  return (
    <section
      className={`pass-panel ${p.legacyUnassociated ? 'legacy-pass' : ''}`}
      aria-label={
        p.legacyUnassociated ? 'Legacy pass with unassociated history' : `Pass ${p.index}`
      }
    >
      <header className='pass-heading'>
        <span>{p.legacyUnassociated ? 'Legacy history' : `Pass ${p.index}`}</span>
        <span className={`pass-status ${p.phase}`} data-hue={phaseHue[p.phase]}>
          {phaseText[p.phase] || p.phase}
        </span>
        <time>{formatMessageTime(p.createdAt)}</time>
      </header>
      {p.legacyUnassociated && (
        <div className='legacy-association-note'>
          This older session predates per-pass records. Its messages and saved artifacts cannot be
          reliably matched, so they are shown as unassociated history.
        </div>
      )}
      {(p.selectedSkills?.length || 0) + (p.loadedSkills?.length || 0) > 0 && (
        <div className='pass-skill-provenance'>
          <strong>Saved skills used</strong>
          {[
            ...(p.selectedSkills || []).map((skill) => ({ ...skill, usage: 'Invoked by you' })),
            ...(p.loadedSkills || []).map((skill) => ({
              ...skill,
              usage: `Loaded${skill.role ? ` by ${skill.role}` : ''}`,
            })),
          ].map((skill, index) => (
            <details key={`${skill.id}:${skill.revision}:${skill.usage}:${index}`}>
              <summary>
                {skill.name} · {skill.usage} · {skill.revision.slice(0, 12)}
              </summary>
              <small>{skill.source}</small>
              <pre>{skill.instructions}</pre>
            </details>
          ))}
        </div>
      )}
      {(p.savedSkills?.length || 0) > 0 && (
        <div className='pass-skill-provenance'>
          <strong>Skills saved by agents</strong>
          {p.savedSkills!.map((skill, index) => (
            <div key={`${skill.id}:${skill.revision}:${index}`}>
              <span>
                {skill.name} · {skill.action} · {skill.revision.slice(0, 12)}
              </span>
              <small>
                {skill.source} · {skill.role}
              </small>
            </div>
          ))}
        </div>
      )}
      {visibleTimeline.map((row) =>
        row.kind === 'message' ? (
          <Fragment key={row.message.id}>
            <ConversationMessage
              message={row.message}
              executionProfile={selectedExecution}
              deepSeekExecution={p.deepSeekExecution}
              actualTurn={messageTurn(row.message)}
            />
            {row.message.role === 'user' && row.message.id === firstUserMessageId && routeText && (
              <>
                <div className='route-line'>
                  <b>{p.routeDecision?.route ? 'Router' : 'Routing'}</b>
                  {p.routeDecision?.route && (
                    <>
                      <span className='route-sep'>·</span>
                      <span
                        className='route-decision'
                        data-hue={routeHue[p.routeDecision.route] || 'slate'}
                      >
                        {p.routeDecision.route}
                      </span>
                    </>
                  )}
                </div>
                <p className='route-reason'>{routeText}</p>
              </>
            )}
          </Fragment>
        ) : (
          <ReasoningResponse
            key={`${row.turn.threadId}:${row.turn.turnId}`}
            turn={row.turn}
            turnSummaries={summariesByTurn.get(reasoningTurnKey(row.turn)) || []}
            activity={activitiesByTurn.get(reasoningTurnKey(row.turn)) || []}
            live={live && p.activeRole === row.turn.role && p.activeTurnId === row.turn.turnId}
            fallbackTime={p.createdAt}
            status={row.turn.role === 'orchestrator' ? orchestratorStatus : undefined}
            statusHue={row.turn.role === 'orchestrator' ? orchestratorStatusHue : undefined}
          />
        )
      )}
      {p.simpleThreadId && (
        <div className='worker-status' role='status'>
          {p.phase === 'simple_running' ? (
            <div className='activity-spinner' />
          ) : (
            <Check size={17} className='worker-activity-icon' />
          )}
          <strong>
            {p.phase === 'simple_running'
              ? 'Simple implementation is working'
              : 'Simple implementation complete'}
          </strong>
          <span className='worker-model'>
            {executionDescriptor(selectedExecution, p.deepSeekExecution)}
          </span>
          <span className={`worker-state ${p.phase}`}>
            {p.phase === 'simple_running'
              ? 'Verifying · no Sol review'
              : 'Self-verified · no Sol review'}
          </span>
        </div>
      )}
      {p.qualityLoop && (
        <QualityLoopPanel state={p.qualityLoop} onAction={active ? onQualityAction : undefined} />
      )}
      {(p.recruitmentTeam || workerRows.length > 0 || !!p.assignment) && (
        <Disclosure
          className='workers-panel'
          title={`Workers${workerPanelSummary ? ` · ${workerPanelSummary}` : ''}`}
          open={recruitmentTeamExpanded}
          onToggle={toggleRecruitmentTeam}
        >
          {p.recruitmentTeam && (
            <RecruitmentTeamPanel
              team={{
                teamId: p.recruitmentTeam.teamId,
                status: p.recruitmentTeam.status,
                mode: p.recruitmentTeam.mode,
                canonicalProjectRoot: p.recruitmentTeam.canonicalProjectRoot,
                workers: p.recruitmentTeam.workers.map((worker) => ({
                  workerId: worker.workerId,
                  name: worker.name,
                  step: worker.step,
                  dependsOn: worker.dependsOn,
                  status: worker.status,
                  canSteer: !!worker.activeTurnId && !worker.deepSeekExecution,
                  effort: worker.effort,
                  ...(worker.branch ? { branch: worker.branch } : {}),
                  ...(worker.worktreeRoot ? { worktreePath: worker.worktreeRoot } : {}),
                  ...(!worker.worktreeRoot
                    ? { executionRoot: p.recruitmentTeam!.canonicalProjectRoot }
                    : {}),
                  assignment: worker.assignment,
                  receipt: worker.receipt,
                  error: worker.error,
                  deepSeekExecution: worker.deepSeekExecution,
                  deepSeekRuntime: worker.deepSeekRuntime,
                  deepSeekPhaseRuns: worker.deepSeekPhaseRuns,
                })),
                ...(p.recruitmentTeam.mode === 'read_only'
                  ? {}
                  : {
                      integration: {
                        status: p.recruitmentTeam.integration.status,
                        canSteer:
                          !!p.recruitmentTeam.integration.activeTurnId &&
                          !p.recruitmentTeam.integration.deepSeekExecution,
                        branch: p.recruitmentTeam.integration.branch,
                        worktreePath: p.recruitmentTeam.integration.worktreeRoot,
                        receipt: p.recruitmentTeam.integration.receipt,
                        error: p.recruitmentTeam.integration.error,
                        deepSeekExecution: p.recruitmentTeam.integration.deepSeekExecution,
                        deepSeekRuntime: p.recruitmentTeam.integration.deepSeekRuntime,
                        deepSeekPhaseRuns: p.recruitmentTeam.integration.deepSeekPhaseRuns,
                      },
                    }),
              }}
              selectedWorkerId={selectedSteerWorkerId}
              onSelectSteerWorker={active ? onSelectSteerWorker : undefined}
            />
          )}
          {workerRows.length > 0 && (
            <div className='worker-dialogue'>
              {workerRows.map((row) =>
                row.kind === 'message' ? (
                  <ConversationMessage
                    key={row.message.id}
                    message={row.message}
                    executionProfile={selectedExecution}
                    deepSeekExecution={p.deepSeekExecution}
                  />
                ) : (
                  <ReasoningResponse
                    key={`${row.turn.threadId}:${row.turn.turnId}`}
                    turn={row.turn}
                    turnSummaries={summariesByTurn.get(reasoningTurnKey(row.turn)) || []}
                    activity={activitiesByTurn.get(reasoningTurnKey(row.turn)) || []}
                    live={live && p.activeRole === 'worker' && p.activeTurnId === row.turn.turnId}
                    fallbackTime={p.createdAt}
                  />
                )
              )}
            </div>
          )}
          {p.assignment && !p.recruitmentTeam && (
            <div className='worker-assignment'>
              <div className='worker-assignment-label'>Assignment</div>
              <AssignmentView assignment={p.assignment} />
            </div>
          )}
        </Disclosure>
      )}
      <Disclosure title={toolCallsTitle(p)} open={toolCallsExpanded} onToggle={toggleToolCalls}>
        <ToolCallLogView
          log={p.toolCalls}
          issueCount={p.toolCallTrackingIssueCount}
          missingMessage='This historical pass predates universal tool-call tracking. Complete invocation coverage is unavailable.'
        />
      </Disclosure>
      <Disclosure
        title={p.receipt ? `Receipt · ${p.receipt.status}` : 'Receipt'}
        open={receiptExpanded}
        onToggle={toggleReceipt}
      >
        <RunReceipt pass={p} taskId={task.id} />
      </Disclosure>
      {p.agentmemAudit && (
        <Disclosure
          title={agentMemAuditTitle(p)}
          open={agentmemAuditExpanded}
          onToggle={toggleAgentMemAudit}
        >
          <AgentMemAuditView pass={p} />
        </Disclosure>
      )}
      {p.escalation && (
        <div className='escalation-card'>
          <div className='escalation-head'>
            <AlertCircle size={16} />
            <strong>Worker needs a decision</strong>
          </div>
          <p>{p.escalation.decision_needed}</p>
          {p.escalation.evidence?.map((x: string, i: number) => (
            <div className='escalation-detail' key={i}>
              {x}
            </div>
          ))}
          <div className='escalation-options'>
            {p.escalation.options?.map((x: string, i: number) => (
              <span key={i}>{x}</span>
            ))}
          </div>
          {p.escalation.recommendation && (
            <p className='rec-line'>
              <b>Recommendation:</b> {p.escalation.recommendation}
            </p>
          )}
        </div>
      )}
      {p.reviewNote && !(p.phase === 'accepted' && isReadOnlyTeam) && (
        <div className={`review-outcome ${p.phase}`}>
          <span>{p.phase === 'accepted' ? <Check size={15} /> : <AlertCircle size={15} />}</span>
          <div>
            <strong>
              {p.phase === 'accepted'
                ? p.resolution === 'direct'
                  ? 'Direct answer'
                  : p.resolution === 'simple'
                    ? 'Simple implementation complete'
                    : 'Receipt accepted'
                : phaseText[p.phase]}
            </strong>
            <div className='markdown-body'>
              <Markdown>{p.reviewNote}</Markdown>
            </div>
            {p.resolution === 'direct' && p.routingNote && (
              <small className='routing-note'>Routing basis: {p.routingNote}</small>
            )}
          </div>
        </div>
      )}
      {p.error && (
        <div className='error-card'>
          <AlertCircle size={16} />
          <div>
            <strong>{p.phase === 'needs_attention' ? 'Action needed' : 'Workflow error'}</strong>
            <p>{p.error}</p>
            {p.phase === 'paused_after_restart' && (
              <small>Send an explicit update to reattach the saved threads and continue.</small>
            )}
          </div>
        </div>
      )}
      {output && (
        <section className='final-artifact' aria-label='Final output'>
          <header>
            <strong>Final output</strong>
            <span>{finalOutputLabel}</span>
            <button
              type='button'
              className='final-artifact-copy'
              onClick={() => {
                if (typeof navigator !== 'undefined' && navigator.clipboard)
                  void navigator.clipboard.writeText(output);
              }}
            >
              copy
            </button>
          </header>
          <div className='final-artifact-body markdown-body'>
            <Markdown>{output}</Markdown>
          </div>
        </section>
      )}
      <PassUsagePanel pass={p} />
    </section>
  );
}

function toolCallsTitle(pass: TaskPass) {
  return toolCallLogTitle(pass.toolCalls);
}
function agentMemAuditTitle(pass: TaskPass) {
  const audit = pass.agentmemAudit;
  if (!audit?.recorded) return 'Historical AgentMem audit · record unavailable';
  const app = audit.calls.filter((call) => call.source === 'application').length;
  const model = audit.calls.filter((call) => call.source === 'model').length;
  return `Historical AgentMem audit · ${model} model calls · ${app} app calls`;
}
