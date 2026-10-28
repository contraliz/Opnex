import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, ExternalLink, Settings2, X } from 'lucide-react';
import type { ReasoningTurn, Runtime, Settings, Task, TaskPass, WorkflowRole } from '../types';
import { getCurrentTaskPass, summarizeSessionUsage, type SessionUsageBucket } from './sessionUsage';
import './HeadsUpPanel.css';

export type HeadsUpPanelProps = {
  task: Task | null;
  settings: Settings;
  runtime: Runtime | null;
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

const roles: readonly [WorkflowRole, keyof TaskPass, keyof Task][] = [
  ['router', 'routerThreadId', 'routerThreadId'],
  ['direct', 'directThreadId', 'directThreadId'],
  ['simple', 'simpleThreadId', 'simpleThreadId'],
  ['orchestrator', 'orchestratorThreadId', 'orchestratorThreadId'],
  ['worker', 'workerThreadId', 'workerThreadId'],
];

const roleLabel: Record<WorkflowRole, string> = {
  router: 'Router',
  direct: 'Direct answer',
  simple: 'Simple implementation',
  orchestrator: 'Orchestrator',
  worker: 'Worker',
};

const phaseLabel: Record<string, string> = {
  intake: 'Ready',
  routing: 'Routing',
  direct_running: 'Direct answer in progress',
  simple_running: 'Simple implementation in progress',
  planning: 'Orchestrator planning',
  worker_running: 'Worker in progress',
  escalated: 'Escalated',
  reviewing: 'Orchestrator review',
  accepted: 'Accepted',
  needs_attention: 'Needs attention',
  cancelled: 'Stopped',
  paused_after_restart: 'Paused after restart',
};

const routeLabel: Record<string, string> = {
  direct_answer: 'Direct answer',
  simple_implementation: 'Simple implementation',
  hard_task: 'Hard task',
};

const policyLabel: Record<string, string> = {
  'on-request': 'On request',
  untrusted: 'Untrusted commands',
  never: 'Never ask',
  'full-access': 'Full access',
};

const tokenFormatter = new Intl.NumberFormat();

function readThreadId(pass: TaskPass | undefined, task: Task | null, role: WorkflowRole) {
  const [, passField, taskField] = roles.find((entry) => entry[0] === role)!;
  const value = pass ? pass[passField] : task?.[taskField];
  return typeof value === 'string' && value ? value : undefined;
}

function getCurrentSessions(task: Task | null, pass: TaskPass | undefined) {
  const sessions = new Map<string, WorkflowRole[]>();
  for (const [role] of roles) {
    const threadId = readThreadId(pass, task, role);
    if (!threadId) continue;
    const assignedRoles = sessions.get(threadId) || [];
    assignedRoles.push(role);
    sessions.set(threadId, assignedRoles);
  }
  return [...sessions.entries()].map(([threadId, assignedRoles]) => ({ threadId, roles: assignedRoles }));
}

function lastReasoningTurn(pass: TaskPass | undefined, role: 'orchestrator' | 'worker', threadId: string): ReasoningTurn | undefined {
  return [...(pass?.reasoningTurns || [])]
    .filter((turn) => turn.role === role && turn.threadId === threadId)
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
    .at(-1);
}

function reasoningTurnLabel(turn: ReasoningTurn) {
  if (turn.provider) return `DeepSeek Harness (${turn.provider}) · ${turn.requestedModel} · requested native effort ${turn.requestedEffort} · effective effort unknown`;
  const model = turn.effectiveModel && turn.effectiveModel !== turn.requestedModel
    ? `${turn.effectiveModel} (requested ${turn.requestedModel})`
    : turn.requestedModel;
  return [model, turn.requestedEffort].filter(Boolean).join(' · ');
}

function modelForThread(task: Task | null, pass: TaskPass | undefined, role: WorkflowRole, threadId: string) {
  if (role === 'router') {
    const decision = pass?.routeDecision || task?.routeDecision;
    if (decision) return [decision.model, decision.effort, decision.speed].filter(Boolean).join(' · ');
  }

  if (role === 'orchestrator' || role === 'worker') {
    const turn = lastReasoningTurn(pass, role, threadId);
    if (turn) return reasoningTurnLabel(turn);
  }

  if (task?.activeRole === role && readThreadId(pass, task, role) === threadId && task.activeModelId) {
    return [task.activeModelId, task.activeEffort].filter(Boolean).join(' · ');
  }
  return undefined;
}

function currentThreadState(task: Task | null, pass: TaskPass | undefined, roleList: WorkflowRole[], threadId: string) {
  const activeRole = pass?.activeRole || task?.activeRole;
  const activeTurnId = pass?.activeTurnId || task?.activeTurnId;
  const isActive = roleList.includes(activeRole as WorkflowRole) && (!!activeTurnId || !!activeRole);
  if (isActive) return `Active · ${phaseLabel[task?.phase || pass?.phase || ''] || 'In progress'}`;
  if (pass?.phase === 'accepted') return 'Finished this pass';
  if (pass?.phase === 'cancelled') return 'Stopped';
  if (pass?.phase === 'paused_after_restart') return 'Paused after restart';
  if (pass?.phase === 'needs_attention') return 'Needs attention';
  if (task?.activeRole && readThreadId(pass, task, task.activeRole) === threadId) return phaseLabel[task.phase] || 'In progress';
  return pass ? 'Used in this pass' : 'Attached to this session';
}

function routeName(value: string | undefined) {
  return value ? routeLabel[value] || value.replaceAll('_', ' ') : 'Not recorded';
}

function codexThreadHref(threadId: string) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function openCodexThread(threadId: string) {
  const desktop = (window as Window & { pseudoharnessDesktop?: { openCodexThread?: (id: string) => Promise<boolean> } }).pseudoharnessDesktop;
  return desktop?.openCodexThread?.(threadId);
}

function phaseTone(phase: string | undefined) {
  if (phase === 'accepted') return 'success';
  if (phase === 'cancelled') return 'danger';
  if (phase === 'needs_attention' || phase === 'escalated') return 'warning';
  if (phase === 'routing' || phase === 'direct_running' || phase === 'simple_running' || phase === 'planning' || phase === 'worker_running' || phase === 'reviewing') return 'active';
  return 'neutral';
}

function displayBucket(bucket: SessionUsageBucket, includeUnit = false) {
  if (bucket.status === 'not-used') return '—';
  if (bucket.totalTokens !== null) {
    const count = tokenFormatter.format(bucket.totalTokens);
    const suffix = [bucket.status === 'partial' ? 'partial' : '', bucket.estimatedThreads ? 'est.' : ''].filter(Boolean).join(' · ');
    return `${count}${includeUnit ? ' tokens' : ''}${suffix ? ` · ${suffix}` : ''}`;
  }
  if (bucket.status === 'pending') return 'Pending';
  if (bucket.status === 'unavailable') return 'Unavailable';
  return 'Unreported';
}

function showOtherRole(bucket: SessionUsageBucket) {
  return bucket.expectedThreads > 0 && (bucket.totalTokens === null || bucket.totalTokens > 0n);
}

function DetailDisclosure({ title, open, onToggle, id, children }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  id: string;
  children: ReactNode;
}) {
  return <section className={`heads-up-disclosure ${open ? 'is-expanded' : ''}`}>
    <button className="heads-up-disclosure-trigger" type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <span>{title}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    <div className="heads-up-disclosure-clip" id={id} aria-hidden={!open} inert={!open}>
      <div className="heads-up-disclosure-inner">{children}</div>
    </div>
  </section>;
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div className="heads-up-setting-row"><span>{label}</span><strong>{value}</strong></div>;
}

export function HeadsUpPanel({ task, settings, runtime, open, onClose, onOpenSettings, triggerRef }: HeadsUpPanelProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [placement, setPlacement] = useState({ top: 12, left: 12, width: 340, maxHeight: 520 });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const returnFocusAfterClose = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const instanceId = useId();
  const sessionsId = `heads-up-${instanceId}-sessions`;
  const detailsId = `heads-up-${instanceId}-details`;
  const pass = getCurrentTaskPass(task);
  const phase = task?.phase || pass?.phase;
  const decision = pass?.routeDecision || task?.routeDecision;
  const escalation = pass?.executionEscalation || task?.executionEscalation;
  const usage = summarizeSessionUsage(task);
  const currentSessions = getCurrentSessions(task, pass);
  const actualOrchestrator = pass?.reasoningTurns?.filter((turn) => turn.role === 'orchestrator').at(-1);
  const actualWorker = pass?.reasoningTurns?.filter((turn) => turn.role === 'worker').at(-1);

  useEffect(() => {
    const trigger = triggerRef?.current;
    if (!trigger) return;
    const hadMarker = trigger.hasAttribute('data-heads-up-trigger');
    trigger.setAttribute('data-heads-up-trigger', '');
    return () => {
      if (!hadMarker) trigger.removeAttribute('data-heads-up-trigger');
    };
  }, [triggerRef]);

  useEffect(() => {
    if (open) {
      returnFocusAfterClose.current = false;
      setMounted(true);
      const enterTimer = window.setTimeout(() => setVisible(true), 0);
      return () => window.clearTimeout(enterTimer);
    }

    setVisible(false);
    if (!mounted) return;
    const exitTimer = window.setTimeout(() => setMounted(false), 190);
    return () => window.clearTimeout(exitTimer);
  }, [open, mounted]);

  useEffect(() => {
    if (open || !returnFocusAfterClose.current) return;
    returnFocusAfterClose.current = false;
    if (window.requestAnimationFrame) {
      const frame = window.requestAnimationFrame(() => triggerRef?.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(() => triggerRef?.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, triggerRef]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    const doc = panel?.ownerDocument || (typeof document !== 'undefined' ? document : undefined);
    const win = doc?.defaultView;
    const triggerElement = triggerRef?.current;
    if (!doc || !win) return;

    const updatePosition = () => {
      const trigger = triggerRef?.current;
      const anchor = trigger?.getBoundingClientRect();
      const pane = trigger?.closest<HTMLElement>('.pane-body')?.getBoundingClientRect();
      const bounds = pane || { left: 0, right: win.innerWidth, top: 0, bottom: win.innerHeight, width: win.innerWidth, height: win.innerHeight };
      const inset = 8;
      const width = Math.max(0, Math.min(360, bounds.width - inset * 2, win.innerWidth - inset * 2));
      const paneMaxHeight = Math.max(80, bounds.height - inset * 2);
      const maxAllowedHeight = Math.max(80, Math.min(520, paneMaxHeight, win.innerHeight - inset * 2));
      const measuredHeight = panel?.getBoundingClientRect().height || maxAllowedHeight;
      const panelHeight = Math.min(measuredHeight, maxAllowedHeight);
      const minTop = Math.max(inset, bounds.top + inset);
      const maxTop = Math.min(win.innerHeight - inset - panelHeight, bounds.bottom - inset - panelHeight);
      let top = anchor ? anchor.bottom + 6 : minTop;
      if (top + panelHeight > bounds.bottom - inset || top + panelHeight > win.innerHeight - inset) {
        top = anchor ? anchor.top - panelHeight - 6 : maxTop;
      }
      top = Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)));
      const minLeft = Math.max(inset, bounds.left + inset);
      const maxLeft = Math.min(win.innerWidth - inset - width, bounds.right - inset - width);
      const desiredLeft = anchor ? anchor.right - width : bounds.right - inset - width;
      const left = Math.max(minLeft, Math.min(desiredLeft, Math.max(minLeft, maxLeft)));
      const maxHeight = Math.max(80, Math.min(maxAllowedHeight, bounds.bottom - top - inset, win.innerHeight - top - inset));
      setPlacement((current) => current.top === top && current.left === left && current.width === width && current.maxHeight === maxHeight
        ? current
        : { top, left, width, maxHeight });
    };

    updatePosition();
    win.addEventListener('resize', updatePosition, { passive: true });
    doc.addEventListener('scroll', updatePosition, { capture: true, passive: true });
    const ResizeObserverConstructor = win.ResizeObserver;
    const observer = ResizeObserverConstructor ? new ResizeObserverConstructor(updatePosition) : undefined;
    if (panel) observer?.observe(panel);
    if (triggerElement) observer?.observe(triggerElement);
    const paneElement = triggerElement?.closest<HTMLElement>('.pane-body');
    if (paneElement) observer?.observe(paneElement);
    return () => {
      win.removeEventListener('resize', updatePosition);
      doc.removeEventListener('scroll', updatePosition, true);
      observer?.disconnect();
    };
  }, [open, mounted, triggerRef, sessionsExpanded, detailsExpanded, task?.id]);

  useEffect(() => {
    if (!open) return;
    const doc = panelRef.current?.ownerDocument || (typeof document !== 'undefined' ? document : undefined);
    if (!doc) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const panel = panelRef.current;
      const trigger = triggerRef?.current;
      if (panel?.contains(target) || trigger?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      // Each tab owns its own panel. Interacting with another tab's panel or trigger
      // should not close this one through its document listener.
      if (element?.closest('[data-heads-up-panel], [data-heads-up-trigger]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = doc.activeElement;
      const panel = panelRef.current;
      const trigger = triggerRef?.current;
      if (!(active instanceof Node) || (!panel?.contains(active) && !trigger?.contains(active))) return;
      event.preventDefault();
      event.stopPropagation();
      returnFocusAfterClose.current = true;
      onClose();
    };
    doc.addEventListener('pointerdown', onPointerDown);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, triggerRef]);

  const copyThreadId = async (threadId: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(threadId);
      setCopiedId(threadId);
    } catch {
      setCopiedId(`failed:${threadId}`);
    }
  };

  if (!mounted || typeof document === 'undefined') return null;

  const panelStyle: CSSProperties = {
    top: placement.top,
    left: placement.left,
    width: placement.width,
    maxHeight: placement.maxHeight,
  };

  return createPortal(<aside
    ref={panelRef}
    className={`heads-up-panel ${visible && open ? 'is-visible' : ''}`}
    style={panelStyle}
    aria-label="Heads-up panel"
    aria-hidden={!open}
    inert={!open}
    data-heads-up-panel
  >
    <header className="heads-up-header">
      <div className="heads-up-title-wrap">
        <h2>Heads-up</h2>
        {task && <span className="heads-up-task-title" title={task.title}>{task.title}</span>}
      </div>
      <button className="heads-up-close" type="button" aria-label="Close heads-up panel" onClick={() => {
        returnFocusAfterClose.current = true;
        onClose();
      }}><X size={16}/></button>
    </header>

    <div className="heads-up-content">
      <section className="heads-up-section heads-up-status" aria-labelledby={`heads-up-${instanceId}-status`}>
        <div className="heads-up-summary-row">
          <h3 id={`heads-up-${instanceId}-status`}>Status</h3>
          <span className={`heads-up-status-pill tone-${phaseTone(phase)}`}>{task ? phaseLabel[phase || ''] || phase || 'Unknown' : 'No session selected'}</span>
        </div>
        {task?.error && <p className="heads-up-inline-error" role="status">{task.error}</p>}
      </section>

      <section className="heads-up-section heads-up-route" aria-labelledby={`heads-up-${instanceId}-routing`}>
        <div className="heads-up-summary-row">
          <h3 id={`heads-up-${instanceId}-routing`}>Route</h3>
          {decision ? <div className="heads-up-route-value" title={decision.justification}>
            <strong>{routeName(decision.effectiveRoute || decision.route)}</strong>
            {decision.effectiveRoute && decision.effectiveRoute !== decision.route && <span>selected {routeName(decision.route)}</span>}
            {decision.fallback && <span className="heads-up-route-tag">Fallback</span>}
            {escalation && <span className="heads-up-route-tag" title={escalation.reason}>Escalated</span>}
          </div> : <span className="heads-up-route-missing">{!task ? '—' : phase === 'routing' ? 'Routing…' : 'Not recorded'}</span>}
        </div>
      </section>

      <section className="heads-up-token-section" aria-labelledby={`heads-up-${instanceId}-tokens`}>
        <div className="heads-up-token-total"><span id={`heads-up-${instanceId}-tokens`}>Session tokens</span><strong>{displayBucket(usage.total, true)}</strong></div>
        <div className="heads-up-token-breakdown" aria-label="Token usage by role">
          {(['orchestrator', 'worker'] as const).map((role) => <span key={role} title={`${roleLabel[role]}: ${displayBucket(usage.roles[role], true)}`}><b>{role === 'orchestrator' ? 'Orch' : 'Worker'}</b>{' '}<span>{displayBucket(usage.roles[role])}</span></span>)}
          {(['router', 'direct', 'simple'] as const).filter((role) => showOtherRole(usage.roles[role])).map((role) => <span key={role} title={`${roleLabel[role]}: ${displayBucket(usage.roles[role], true)}`}><b>{roleLabel[role]}</b>{' '}<span>{displayBucket(usage.roles[role])}</span></span>)}
        </div>
        {(usage.total.status === 'partial' || usage.total.status === 'pending' || usage.total.status === 'unavailable' || usage.total.status === 'not-reported') && task && <p className="heads-up-token-note">{usage.total.status === 'partial' ? 'Partial tracking' : usage.total.status === 'pending' ? 'Usage pending' : usage.total.status === 'unavailable' ? 'Usage unavailable' : 'Usage not reported'}</p>}
      </section>

      <DetailDisclosure title={`Current sessions · ${currentSessions.length}`} open={sessionsExpanded} onToggle={() => setSessionsExpanded((value) => !value)} id={sessionsId}>
        {currentSessions.length ? <div className="heads-up-thread-list">
          {currentSessions.map(({ threadId, roles: assignedRoles }) => {
            const primaryRole = assignedRoles[assignedRoles.length - 1];
            const modelText = modelForThread(task, pass, primaryRole, threadId);
            const label = assignedRoles.map((role) => roleLabel[role]).join(' + ');
            const copyResult = copiedId === threadId ? 'Thread ID copied' : copiedId === `failed:${threadId}` ? 'Clipboard unavailable' : `Copy thread ID ${threadId}`;
            return <article className="heads-up-thread" key={threadId}>
              <div className="heads-up-thread-heading"><strong>{label}</strong><span>{currentThreadState(task, pass, assignedRoles, threadId)}</span></div>
              {modelText && <span className="heads-up-thread-model">{modelText}</span>}
              <div className="heads-up-thread-id-row">
                <code>{threadId}</code>
                <a className="heads-up-thread-open" href={codexThreadHref(threadId)} aria-label={`Open ${label} session in Codex`} title="Open in Codex" onClick={(event) => {
                  const openPromise = openCodexThread(threadId);
                  if (!openPromise) return;
                  event.preventDefault();
                  void openPromise.catch(() => undefined);
                }}><ExternalLink size={13}/></a>
                <button type="button" aria-label={copyResult} title={copyResult} onClick={() => void copyThreadId(threadId)}><Copy size={13}/></button>
              </div>
            </article>;
          })}
        </div> : <p className="heads-up-muted-copy">{task ? 'No threads yet' : 'No session selected'}</p>}
      </DetailDisclosure>

      <DetailDisclosure title="Details" open={detailsExpanded} onToggle={() => setDetailsExpanded((value) => !value)} id={detailsId}>
        <div className="heads-up-details-block">
          <h4>This session</h4>
          {task ? <>
            <SettingRow label="Root" value={task.userRoot || 'Not recorded'}/>
            <SettingRow label="AgentMem" value={task.agentmemProjectId || 'Disabled'}/>
            <SettingRow label="Approval" value={pass?.approvalPolicy ? policyLabel[pass.approvalPolicy] || pass.approvalPolicy : 'Not recorded'}/>
            <SettingRow label="Orchestrator" value={actualOrchestrator ? `${actualOrchestrator.effectiveModel && actualOrchestrator.effectiveModel !== actualOrchestrator.requestedModel ? `${actualOrchestrator.effectiveModel} (requested ${actualOrchestrator.requestedModel})` : actualOrchestrator.requestedModel} · ${actualOrchestrator.requestedEffort}` : 'Not recorded'}/>
            <SettingRow label="Worker" value={actualWorker ? reasoningTurnLabel(actualWorker) : pass?.workerThreadId || task.workerThreadId ? 'Not recorded' : 'Not used'}/>
            {decision?.justification && <SettingRow label="Route reason" value={decision.justification}/>}
            {escalation && <SettingRow label="Escalation" value={`${routeName(escalation.from)} → ${routeName(escalation.to)} · ${escalation.reason}`}/>}
            {(pass?.agentmemRecordStatus || task.agentmemRecordStatus) && <SettingRow label="AgentMem record" value={pass?.agentmemRecordStatus || task.agentmemRecordStatus || 'Not recorded'}/>}
          </> : <p className="heads-up-muted-copy">No session-specific settings are available.</p>}
        </div>

        <div className="heads-up-details-block">
          <h4>For new tasks</h4>
          <SettingRow label="Root" value={settings.projectRoot || 'Not selected'}/>
          <SettingRow label="AgentMem" value={settings.agentmemProjectId || 'Disabled'}/>
          <SettingRow label="Approval" value={policyLabel[settings.approvalPolicy] || settings.approvalPolicy}/>
          <SettingRow label="Orchestrator" value={`${settings.orchestratorModel} · ${settings.orchestratorEffort}`}/>
          <SettingRow label="Worker" value="gpt-6-luna · high (app policy)"/>
          <button className="heads-up-settings-link" type="button" onClick={onOpenSettings}><Settings2 size={14}/>Open settings</button>
        </div>

        <div className="heads-up-details-block">
          <h4>Runtime</h4>
          <SettingRow label="Codex" value={runtime?.codex.state || 'Unavailable'}/>
          <SettingRow label="AgentMem" value={!runtime ? 'Unavailable' : runtime.agentmem.connected ? (runtime.agentmem.projectVerified ? 'Connected · verified' : 'Connected · unverified') : 'Disconnected'}/>
        </div>
      </DetailDisclosure>
    </div>
  </aside>, document.body);
}
