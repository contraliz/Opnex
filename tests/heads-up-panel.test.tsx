// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Runtime, Settings, Task, TaskPass } from '../src/types';
import { HeadsUpPanel } from '../src/ui/HeadsUpPanel';

const settings: Settings = {
  projectRoot: 'D:/new-project',
  agentmemProjectId: 'new-project-kb',
  orchestratorModel: 'gpt-6.1-sol',
  orchestratorEffort: 'low',
  approvalPolicy: 'never',
};

const runtime: Runtime = {
  codex: { state: 'connected', error: '', models: [], workerAvailable: true },
  agentmem: { connected: true, projectVerified: true, detail: 'Project is verified for new tasks.' },
};

function pass(id: string, index: number, overrides: Partial<TaskPass> = {}): TaskPass {
  return {
    id,
    index,
    createdAt: `2026-10-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    userInput: `Task pass ${index}`,
    userInputs: [`Task pass ${index}`],
    userMessageIds: [],
    phase: 'accepted',
    correctionCount: 0,
    processedTurns: [],
    ...overrides,
  };
}

function threadUsage(threadId: string, totalTokens: number, source: 'thread' | 'thread-estimate' = 'thread') {
  return {
    threadId,
    tokenStatus: 'available' as const,
    creditStatus: 'unavailable' as const,
    tokens: {
      totalTokens,
      inputTokens: totalTokens - 5,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      outputTokens: 5,
      reasoningOutputTokens: 3,
      modelContextWindow: 128_000,
      source,
    },
  };
}

function taskFixture(id = 'task-1'): Task {
  const prior = pass('pass-1', 1, {
    routerThreadId: 'router-old',
    workerThreadId: 'worker-old',
    usage: {
      router: threadUsage('router-old', 20),
      worker: threadUsage('worker-old', 10, 'thread-estimate'),
    },
  });
  const current = pass('pass-2', 2, {
    phase: 'accepted',
    approvalPolicy: 'untrusted',
    routeDecision: {
      route: 'simple_implementation',
      effectiveRoute: 'hard_task',
      rule_id: 'simple_bounded_correction',
      justification: 'The bounded change exposed an architectural issue.',
      model: 'gpt-6-luna',
      effort: 'low',
      speed: 'Fast',
      decidedAt: '2026-10-02T00:00:00.000Z',
      fallback: true,
    },
    executionEscalation: {
      from: 'simple_implementation',
      to: 'hard_task',
      reason: 'The correction needs a multi-component change.',
      completedActions: [],
      evidence: ['The state contract is shared by multiple panes.'],
    },
    routerThreadId: 'router-current',
    orchestratorThreadId: 'orchestrator-current',
    workerThreadId: 'worker-current',
    reasoningTurns: [
      { role: 'orchestrator', threadId: 'orchestrator-current', turnId: 'orch-turn', requestedModel: 'gpt-6.1-sol', requestedEffort: 'low', status: 'completed' },
      { role: 'worker', threadId: 'worker-current', turnId: 'worker-turn', requestedModel: 'gpt-6-luna', requestedEffort: 'high', status: 'completed' },
    ],
    reasoningSummaries: [{ role: 'worker', threadId: 'worker-current', turnId: 'worker-turn', itemId: 'hidden', summaryIndex: 0, text: 'Private provider reasoning must not be copied into the panel.' }],
    usage: {
      router: threadUsage('router-current', 25),
      orchestrator: threadUsage('orchestrator-current', 80),
      worker: threadUsage('worker-current', 60),
    },
  });

  return {
    id,
    title: `Session ${id}`,
    phase: 'accepted',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    userRoot: 'D:/session-project',
    agentmemProjectId: 'session-kb',
    messages: [],
    passes: [prior, current],
    currentPassId: current.id,
    resolution: 'delegated',
    agentmemRecordStatus: 'done',
    correctionCount: 0,
  };
}

function PanelHarness({
  task,
  name = task?.id || 'empty',
  initiallyOpen = true,
  withinPane = false,
  onOpenSettings = vi.fn(),
}: {
  task: Task | null;
  name?: string;
  initiallyOpen?: boolean;
  withinPane?: boolean;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <div className={withinPane ? 'pane-body' : undefined}>
    <button ref={triggerRef} type="button" aria-label={`HUD ${name}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>HUD</button>
    <HeadsUpPanel task={task} settings={settings} runtime={runtime} open={open} onClose={() => setOpen(false)} onOpenSettings={onOpenSettings} triggerRef={triggerRef}/>
  </div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(window, 'pseudoharnessDesktop');
});

describe('Heads-up panel', () => {
  it('shows a useful empty state without inventing a thread or a zero token total', () => {
    render(<PanelHarness task={null}/>);

    const panel = screen.getByRole('complementary', { name: 'Heads-up panel' });
    expect(panel.querySelector('.heads-up-status-pill')?.textContent).toBe('No session selected');
    const emptyTokenRow = within(panel).getByText('Session tokens').parentElement;
    expect(emptyTokenRow?.querySelector('strong')?.textContent).toBe('—');
    fireEvent.click(within(panel).getByRole('button', { name: 'Current sessions · 0' }));
    expect(within(panel).getAllByText('No session selected')).toHaveLength(2);
    expect(within(panel).queryByText('0 tokens')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Copy thread ID/ })).toBeNull();
    expect(within(panel).queryByText('Pseudoharness')).toBeNull();
  });

  it('keeps the summary compact and reveals current sessions and settings on demand', async () => {
    const onOpenSettings = vi.fn();
    render(<PanelHarness task={taskFixture()} onOpenSettings={onOpenSettings}/>);
    const panel = screen.getByRole('complementary', { name: 'Heads-up panel' });

    expect(within(panel).getByText('Accepted')).toBeTruthy();
    expect(within(panel).getByText('Hard task')).toBeTruthy();
    expect(within(panel).getByText('selected Simple implementation')).toBeTruthy();
    expect(within(panel).getByText('Fallback')).toBeTruthy();
    expect(within(panel).getByText('Escalated')).toBeTruthy();
    expect(within(panel).queryByText('simple_bounded_correction')).toBeNull();
    const routeReason = within(panel).getByText('The bounded change exposed an architectural issue.');
    expect(routeReason.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(within(panel).queryByText(/Pass 2/)).toBeNull();

    expect(within(panel).getByText('195 tokens · est.')).toBeTruthy();
    const tokenBreakdown = within(panel).getByLabelText('Token usage by role');
    expect(tokenBreakdown.textContent).toContain('Orch 80');
    expect(tokenBreakdown.textContent).toContain('Worker 70 · est.');
    expect(tokenBreakdown.textContent).toContain('Router 45');
    expect(within(panel).queryByText('Direct answer')).toBeNull();
    expect(within(panel).queryByText('Simple implementation', { exact: true })).toBeNull();
    expect(within(panel).queryByText(/Cumulative totals are counted/)).toBeNull();

    const sessionsDisclosure = within(panel).getByRole('button', { name: 'Current sessions · 3' });
    expect(sessionsDisclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(sessionsDisclosure);
    expect(sessionsDisclosure.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel).getByText('router-current')).toBeTruthy();
    expect(within(panel).getByText('orchestrator-current')).toBeTruthy();
    expect(within(panel).getByText('worker-current')).toBeTruthy();
    expect(within(panel).queryByText('router-old')).toBeNull();
    const openCodexThread = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'pseudoharnessDesktop', { configurable: true, value: { openCodexThread } });
    const codexLinks = [
      ['Router', 'router-current'],
      ['Orchestrator', 'orchestrator-current'],
      ['Worker', 'worker-current'],
    ] as const;
    codexLinks.forEach(([role, threadId], index) => {
      const link = within(panel).getByRole('link', { name: `Open ${role} session in Codex` });
      expect(link.getAttribute('href')).toBe(`codex://threads/${threadId}`);
      fireEvent.click(link);
      expect(openCodexThread).toHaveBeenNthCalledWith(index + 1, threadId);
    });
    expect(within(panel).getAllByText('gpt-6.1-sol · low')).toHaveLength(3);
    expect(within(panel).getAllByText('gpt-6-luna · high')).toHaveLength(2);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const copyButton = within(panel).getByRole('button', { name: 'Copy thread ID worker-current' });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('worker-current'));

    const details = within(panel).getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel).getByText('D:/session-project')).toBeTruthy();
    expect(within(panel).getByText('session-kb')).toBeTruthy();
    expect(within(panel).getByText('The bounded change exposed an architectural issue.')).toBeTruthy();
    expect(within(panel).getByText(/The correction needs a multi-component change/)).toBeTruthy();
    expect(within(panel).getAllByText('gpt-6.1-sol · low')).toHaveLength(3);
    expect(within(panel).getByText('gpt-6-luna · high (app policy)')).toBeTruthy();
    expect(within(panel).queryByText(/Private provider reasoning/)).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('labels missing usage without fabricating zeros or showing unused roles', () => {
    const task = taskFixture('unreported');
    const current = task.passes![1];
    current.usage = undefined;
    current.routerThreadId = undefined;
    current.orchestratorThreadId = undefined;
    current.workerThreadId = 'worker-unreported';
    task.workerThreadId = 'worker-unreported';
    render(<PanelHarness task={{ ...task, passes: [current], currentPassId: current.id }}/>);

    const panel = screen.getByRole('complementary', { name: 'Heads-up panel' });
    expect(within(panel).getByText('Usage not reported')).toBeTruthy();
    expect(within(panel).getByLabelText('Token usage by role').textContent).toContain('Worker Unreported');
    expect(within(panel).queryByText('Direct answer')).toBeNull();
    expect(within(panel).queryByText('Router —')).toBeNull();
    expect(within(panel).queryByText('0 tokens')).toBeNull();
  });

  it('keeps the popup within its owning pane bounds', async () => {
    render(<PanelHarness task={taskFixture()} withinPane/>);
    const pane = document.querySelector('.pane-body')!;
    const trigger = screen.getByRole('button', { name: 'HUD task-1' });
    const panel = screen.getByRole('complementary', { name: 'Heads-up panel' });
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
    }) as DOMRect;
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect(100, 40, 350, 500));
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(350, 100, 24, 28));
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 334, 300));
    fireEvent.resize(window);

    await waitFor(() => {
      expect(panel.style.width).toBe('334px');
      expect(panel.style.left).toBe('108px');
    });
    expect(Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(484);
  });

  it('closes only the focused tab panel on Escape and returns focus to its own trigger', async () => {
    render(<>
      <PanelHarness task={taskFixture('tab-a')}/>
      <PanelHarness task={taskFixture('tab-b')}/>
    </>);
    const triggers = screen.getAllByRole('button', { name: /^HUD/ });
    const panels = screen.getAllByRole('complementary', { name: 'Heads-up panel' });
    expect(panels).toHaveLength(2);

    triggers[1].focus();
    fireEvent.keyDown(triggers[1], { key: 'Escape' });

    expect(panels[0].getAttribute('aria-hidden')).toBe('false');
    expect(panels[1].getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(triggers[1]));
  });

  it('does not close another tab panel when a pointer interaction occurs inside it', () => {
    render(<>
      <PanelHarness task={taskFixture('tab-a')}/>
      <PanelHarness task={taskFixture('tab-b')}/>
    </>);
    const panels = screen.getAllByRole('complementary', { name: 'Heads-up panel' });

    fireEvent.pointerDown(within(panels[1]).getByText('Heads-up'));

    expect(panels[0].getAttribute('aria-hidden')).toBe('false');
    expect(panels[1].getAttribute('aria-hidden')).toBe('false');
  });

  it('closes after an outside pointer interaction', () => {
    render(<PanelHarness task={taskFixture()}/>);
    const panel = screen.getByRole('complementary', { name: 'Heads-up panel' });

    fireEvent.pointerDown(document.body);

    expect(panel.getAttribute('aria-hidden')).toBe('true');
  });
});
