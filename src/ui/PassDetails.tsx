import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { PassGitDiff } from './PassGitDiff';
import { executionModelName } from './model-display';
import {
  qualityCorrectionPlannerInFlight,
  qualityLoopCanAcceptFindings,
  qualityLoopResumeAction,
} from '../../server/quality-loop-resume.js';
import type { Assignment, PassTokenUsage, PassUsage, TaskPass } from '../types';

const formatAuditTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
export function AgentMemAuditView({ pass }: { pass: TaskPass }) {
  const audit = pass.agentmemAudit;
  if (!audit?.recorded)
    return (
      <div className='agentmem-audit-unknown' role='status'>
        This pass predates AgentMem call auditing. Model-issued MCP calls and app-provided context
        were not recorded, so usage is unknown.
      </div>
    );
  const modelStatus =
    audit.modelMcpStatus === 'observed'
      ? 'Model-issued AgentMem MCP calls were observed.'
      : audit.modelMcpStatus === 'disabled'
        ? 'AgentMem MCP was disabled for this pass.'
        : audit.modelMcpStatus === 'available'
          ? 'AgentMem MCP was available to execution roles; no call has been recorded yet.'
          : audit.modelMcpStatus === 'unavailable'
            ? 'AgentMem MCP was unavailable to the execution runtime.'
            : audit.modelMcpStatus === 'no_calls_observed'
              ? 'No AgentMem MCP call was observed for this pass.'
              : 'Model MCP availability and usage are unknown.';
  const identity =
    audit.identityStatus === 'verified'
      ? `Verified: ${audit.verifiedProjectId || audit.selectedProjectId} ↔ ${audit.verifiedRoot || audit.workspaceRoot}`
      : audit.identityStatus === 'disabled'
        ? 'No AgentMem knowledge base was selected for this pass.'
        : audit.identityStatus === 'mismatch'
          ? `Workspace identity mismatch. Selected knowledge base: ${audit.selectedProjectId || 'none'}; workspace root: ${audit.workspaceRoot}.`
          : `Selected knowledge base: ${audit.selectedProjectId || 'none'} ↔ ${audit.workspaceRoot} · ${audit.identityStatus}.`;
  return (
    <div className='agentmem-audit' data-model-mcp-status={audit.modelMcpStatus}>
      <p
        className={
          audit.identityStatus === 'mismatch' || audit.identityStatus === 'unavailable'
            ? 'is-error'
            : ''
        }
      >
        <strong>Selected knowledge base:</strong> {identity}
      </p>
      <p>
        <strong>Selected repository index:</strong>{' '}
        {audit.verifiedRepositoryId || 'Not verified for this pass'}
      </p>
      <p>
        <strong>Model-issued MCP:</strong> {modelStatus}
      </p>
      {audit.coverage === 'from_first_recorded_call' && (
        <p>
          This older pass was only audited from its first newly observed call; earlier AgentMem
          usage is unknown.
        </p>
      )}
      {audit.contexts.length > 0 && (
        <section>
          <strong>App context retrieval</strong>
          <ul>
            {audit.contexts.map((context) => (
              <li key={context.id}>
                <span>
                  {context.role} · {context.purpose} ·{' '}
                  {context.status === 'supplied' ? 'supplied to model' : context.status}
                </span>
                <small>
                  {formatAuditTime(context.startedAt)}
                  {context.threadId && context.turnId ? ` · turn ${context.turnId}` : ''}
                </small>
                {context.resultSummary && <small>{context.resultSummary}</small>}
                {context.error && <small className='is-error'>{context.error}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {audit.calls.length > 0 && (
        <section>
          <strong>Observed MCP calls</strong>
          <ul>
            {audit.calls.map((call) => (
              <li key={call.id}>
                <span>
                  {call.source === 'model' ? 'Model' : 'App'} · {call.method} · {call.status}
                </span>
                <small>
                  {call.service ? `${call.service.replace('_', ' ')} · ` : ''}
                  {call.operation ? `${call.operation} · ` : ''}
                  {call.role}
                  {call.purpose ? ` · ${call.purpose}` : ''}
                  {call.projectId ? ` · KB ${call.projectId}` : ''}
                  {call.repositoryId ? ` · repo ${call.repositoryId}` : ''}
                  {call.turnId ? ` · turn ${call.turnId}` : ''} · {formatAuditTime(call.startedAt)}
                </small>
                {call.resultSummary && <small>{call.resultSummary}</small>}
                {call.error && <small className='is-error'>{call.error}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!audit.contexts.length && !audit.calls.length && (
        <p>No AgentMem context retrieval or tool call was recorded for this pass.</p>
      )}
    </div>
  );
}

const tokenCount = (value: number) => new Intl.NumberFormat(undefined).format(value);
const cell = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : tokenCount(value);
export function PassUsagePanel({ pass }: { pass: TaskPass }) {
  const usage = pass.usage || {};
  const roleNames: Record<string, string> = {
    router: 'router',
    direct: 'direct answer',
    simple: 'simple implementation',
    orchestrator: 'orchestrator',
    worker: 'worker',
  };
  const modelLabel = (role: keyof PassUsage) => {
    const models = [
      ...new Set(
        (usage[role]?.groups || [])
          .map((group) => group.model)
          .filter((model): model is string => !!model)
      ),
    ];
    return models.length > 1
      ? `${models.length} models`
      : models.length === 1
        ? executionModelName(models[0])
        : undefined;
  };
  const expected = (
    ['router', 'direct', 'simple', 'orchestrator', 'worker'] as (keyof typeof usage)[]
  ).filter((role) =>
    role === 'router'
      ? !!pass.routerThreadId
      : role === 'direct'
        ? !!pass.directThreadId
        : role === 'simple'
          ? !!pass.simpleThreadId
          : role === 'orchestrator'
            ? !!pass.orchestratorThreadId
            : !!pass.workerThreadId || pass.resolution === 'delegated'
  );
  if (!expected.length) return null;
  const rows = expected.flatMap((role) => {
    const entry = usage[role];
    return entry?.tokens && entry.tokenStatus === 'available'
      ? [
          {
            role,
            label: `${modelLabel(role) || 'model unavailable'} · ${roleNames[role]}`,
            tokens: entry.tokens,
          },
        ]
      : [];
  });
  const pending = expected.some((role) => usage[role]?.tokenStatus === 'pending');
  const sumOf = (pick: (tokens: PassTokenUsage) => number | null) => {
    const values = rows
      .map((row) => pick(row.tokens))
      .filter((value): value is number => value !== null);
    return values.length ? tokenCount(values.reduce((sum, value) => sum + value, 0)) : '–';
  };
  const grandTotal = rows.reduce((sum, row) => sum + row.tokens.totalTokens, 0);
  return (
    <details className='usage' aria-label={`Usage summary for pass ${pass.index}`}>
      <summary>
        <span className='usage-label'>token usage</span>
        <span className='usage-value'>
          {rows.length
            ? `${tokenCount(grandTotal)} tokens`
            : pending
              ? 'collecting…'
              : 'not reported'}
        </span>
      </summary>
      {rows.length ? (
        <table className='usage-table'>
          <thead>
            <tr>
              <th>model</th>
              <th>input</th>
              <th>cached</th>
              <th>output</th>
              <th>reasoning</th>
              <th>total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.role}>
                <td>{row.label}</td>
                <td>{cell(row.tokens.inputTokens)}</td>
                <td>{cell(row.tokens.cachedInputTokens)}</td>
                <td>{cell(row.tokens.outputTokens)}</td>
                <td>{cell(row.tokens.reasoningOutputTokens)}</td>
                <td>{tokenCount(row.tokens.totalTokens)}</td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className='usage-total'>
                <td>total</td>
                <td>{sumOf((tokens) => tokens.inputTokens)}</td>
                <td>{sumOf((tokens) => tokens.cachedInputTokens)}</td>
                <td>{sumOf((tokens) => tokens.outputTokens)}</td>
                <td>{sumOf((tokens) => tokens.reasoningOutputTokens)}</td>
                <td>{tokenCount(grandTotal)}</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className='usage-empty'>No token usage was reported for this pass.</p>
      )}
    </details>
  );
}
export function Disclosure({
  title,
  open,
  onToggle,
  children,
  className,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button type='button' className='disclosure-head' onClick={onToggle} aria-expanded={open}>
        <strong>{title}</strong>
        <span className='disclosure-toggle' aria-hidden='true'>
          {open ? '▾' : '▸'}
        </span>
      </button>
      <div className='disclosure-panel' aria-hidden={!open} inert={!open}>
        <div className='disclosure-panel-inner'>
          <div className='disclosure-content'>{children}</div>
        </div>
      </div>
    </div>
  );
}
export function AssignmentView({ assignment: a }: { assignment: Assignment }) {
  const data: [string, string[]][] = [
    ['Outcome', [a.outcome, a.deliverable]],
    ['Authorized read scope', a.read_scope],
    ['Authorized write scope', a.write_scope],
    ['Constraints', a.constraints],
    ['Acceptance', a.acceptance],
    ['Verification', a.verification],
    ['Escalate when', a.escalation_conditions],
    ['Exclusions', a.exclusions],
  ];
  return (
    <div className='assignment-grid'>
      {data.map(([label, items]) => (
        <div key={label} className='assignment-block'>
          <span>{label}</span>
          <ul>
            {items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
export function RunReceipt({ pass: p, taskId }: { pass: TaskPass; taskId: string }) {
  const receipt = p.receipt;
  return (
    <div className='run-receipt-content'>
      {!receipt ? (
        <p className='receipt-unavailable'>This pass has no Opnex worker receipt to summarize.</p>
      ) : (
        <>
          <PassGitDiff key={`${taskId}:${p.id}`} taskId={taskId} passId={p.id} />
          {p.receiptProvenance ? (
            <p className='receipt-provenance'>
              Produced by {p.receiptProvenance.producerRole} · turn {p.receiptProvenance.turnId} ·{' '}
              {p.receiptProvenance.artifactRefs.length} artifact references
            </p>
          ) : (
            <p className='receipt-provenance'>
              Producer and turn provenance is unavailable for this historical receipt.
            </p>
          )}
          {(p.agentReceipts?.length || 0) > 1 && (
            <section className='agent-receipt-history'>
              <b>Receipts from artifact-producing turns</b>
              {p.agentReceipts!.map((record) => (
                <details key={`${record.producerRole}:${record.threadId}:${record.turnId}`}>
                  <summary>
                    {record.producerRole} · turn {record.turnId} · {record.receipt.status}
                  </summary>
                  <p>{record.receipt.result}</p>
                  <div>
                    <b>Artifact references</b>
                    {list(record.artifactRefs)}
                  </div>
                  <div>
                    <b>Knowledge and index updates</b>
                    {list(record.receipt.knowledge.updated)}
                  </div>
                </details>
              ))}
            </section>
          )}
          {!!p.turnSourceChanges?.length && (
            <section className='source-turn-audit'>
              <b>Workspace changes verified by artifact turn</b>
              <ul>
                {p.turnSourceChanges.map((source) => (
                  <li key={`${source.role}:${source.threadId}:${source.turnId}`}>
                    <span>
                      {source.role} · turn {source.turnId} · {source.status}
                    </span>
                    <small>
                      {source.changedPaths.length
                        ? source.changedPaths.join(', ')
                        : source.repositoryRevisionChanged
                          ? 'Repository revision changed'
                          : 'No workspace source changes detected'}
                      {source.reason && ` · ${source.reason}`}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className='receipt-change-grid'>
            <div>
              <b>Worker-reported repository changes</b>
              {list(receipt.changes)}
            </div>
            <div>
              <b>Knowledge base changes</b>
              {list(receipt.knowledge?.updated)}
            </div>
          </div>
          <div className='receipt-acceptance-grid'>
            <div>
              <b>Acceptance met</b>
              {list(receipt.acceptance?.met)}
            </div>
            <div>
              <b>Unmet</b>
              {list(receipt.acceptance?.unmet)}
            </div>
          </div>
          <div className='receipt-verification'>
            <b>Verification</b>
            {receipt.verification?.length ? (
              <ul>
                {receipt.verification.map((item, index) => (
                  <li key={index}>
                    <span className={`check-state ${item.result}`}>
                      {item.result === 'passed' ? '✓' : item.result === 'failed' ? '!' : '·'}
                    </span>
                    <span>
                      {item.check}
                      {item.evidence && <small>{item.evidence}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className='none'>Not reported</div>
            )}
          </div>
          {receipt.risks?.length > 0 && (
            <div className='receipt-risks'>
              <b>Risks and limits</b>
              {list(receipt.risks)}
            </div>
          )}
          {receipt.decision_required && (
            <div className='decision-line'>Decision required: {receipt.decision_required}</div>
          )}
        </>
      )}
    </div>
  );
}

export function QualityLoopPanel({
  state,
  onAction,
}: {
  state: NonNullable<TaskPass['qualityLoop']>;
  onAction?: (action: 'accept' | 'pause' | 'resume') => void;
}) {
  if (!state.enabled) return null;
  const labels: Record<string, string> = {
    awaiting_audit: 'Waiting for QA audit',
    auditing: 'GPT-6.1 Terra is auditing',
    awaiting_corrections: 'QA findings need correction',
    correcting: 'Workers are correcting QA findings',
    complete: 'QA audit found no actionable issues',
    user_accepted: 'Known QA findings accepted by user',
    needs_attention: 'QA loop needs attention',
    paused: 'QA loop paused',
    paused_after_restart: 'QA paused when the kernel restarted',
    cancelled: 'QA loop cancelled',
    disabled: 'QA loop off',
  };
  const latest = state.rounds[state.rounds.length - 1];
  const findings = latest?.findings || [];
  const canAccept = !!onAction && qualityLoopCanAcceptFindings(state, latest?.roundId);
  const canPause = !!onAction && ['auditing', 'awaiting_corrections'].includes(state.status);
  const resumeAction = qualityLoopResumeAction(state);
  const canResume =
    !!onAction &&
    ['paused', 'paused_after_restart'].includes(state.status) &&
    resumeAction !== undefined;
  const canRetry = !!onAction && state.status === 'needs_attention' && resumeAction === 'audit';
  return (
    <section
      className={`quality-loop-panel ${state.status}`}
      aria-label='Independent QA loop'
      data-qa-status={state.status}
    >
      <header>
        <Sparkles size={15} />
        <strong>Independent QA loop</strong>
        <span className={`quality-loop-status ${state.status}`}>
          {labels[state.status] || state.status}
        </span>
      </header>
      <p>
        Each audit uses gpt-6.1-terra with high reasoning. Findings return to the orchestrator for
        worker corrections; the independent final receipt review remains separate.
      </p>
      {state.terminalReason && <div className='quality-loop-note'>{state.terminalReason}</div>}
      {qualityCorrectionPlannerInFlight(state.correctionPlanner) && (
        <div className='quality-loop-note'>
          The correction planner setup or turn is unresolved. Wait for its outcome before resuming
          or accepting findings.
        </div>
      )}
      {state.userAcceptanceNote && (
        <div className='quality-loop-note'>User acceptance: {state.userAcceptanceNote}</div>
      )}
      {!!state.rounds.length && (
        <ol className='quality-round-list'>
          {state.rounds.map((round) => (
            <li key={round.roundId}>
              <div>
                <b>Round {round.index}</b>
                <span>
                  {round.resultStatus === 'no_actionable_issues'
                    ? 'No actionable issues'
                    : round.resultStatus === 'issues_found'
                      ? `${round.findings?.length || 0} actionable finding(s)`
                      : round.status}
                </span>
              </div>
              <small>
                {round.model} · requested {round.requestedEffort}
                {round.reportedEffort
                  ? ` · reported ${round.reportedEffort}`
                  : ' · effective effort not reported'}{' '}
                · integration {round.integrationHead.slice(0, 12)}
              </small>
              {round.error && <small className='quality-loop-error'>{round.error}</small>}
            </li>
          ))}
        </ol>
      )}
      {findings.length > 0 && (
        <div className='quality-finding-list'>
          {findings.map((finding) => (
            <article key={finding.findingId}>
              <div>
                <strong>{finding.title}</strong>
                <span className={`quality-severity ${finding.severity}`}>{finding.severity}</span>
              </div>
              <p>{finding.issue}</p>
              <p>
                <b>Requested fix:</b> {finding.requiredFix}
              </p>
              {finding.file && (
                <code>
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ''}
                </code>
              )}
              <ul>
                {finding.evidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
      {onAction && (
        <div className='quality-loop-actions'>
          {canPause && (
            <button type='button' onClick={() => onAction('pause')}>
              Pause QA
            </button>
          )}
          {canResume && (
            <button type='button' onClick={() => onAction('resume')}>
              Resume QA
            </button>
          )}
          {canRetry && (
            <button type='button' onClick={() => onAction('resume')}>
              Retry QA audit
            </button>
          )}
          {canAccept && (
            <button type='button' className='accept-findings' onClick={() => onAction('accept')}>
              Accept findings and continue to final review
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function list(items: string[] = []) {
  return items.length ? (
    <ul>
      {items.map((v, i) => (
        <li key={i}>{v}</li>
      ))}
    </ul>
  ) : (
    <div className='none'>None</div>
  );
}
