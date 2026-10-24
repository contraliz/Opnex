import { describe, expect, it } from 'vitest';
import type { Task, TaskPass, WorkflowRole } from '../src/types';
import { getCurrentTaskPass, summarizeSessionUsage } from '../src/ui/sessionUsage';

function pass(id: string, index: number, roles: Partial<Record<`${WorkflowRole}ThreadId`, string>> = {}, usage: TaskPass['usage'] = {}): TaskPass {
  return {
    id,
    index,
    createdAt: `2026-10-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    userInput: `Pass ${index}`,
    userInputs: [`Pass ${index}`],
    userMessageIds: [],
    phase: 'accepted',
    correctionCount: 0,
    processedTurns: [],
    ...roles,
    usage,
  };
}

function task(passes: TaskPass[], overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Session usage',
    phase: 'accepted',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    userRoot: 'D:/workspace/project',
    messages: [],
    passes,
    correctionCount: 0,
    ...overrides,
  };
}

function usage(threadId: string, totalTokens: number, source: 'thread' | 'thread-estimate' = 'thread', tokenStatus: 'available' | 'pending' | 'unavailable' = 'available') {
  return {
    threadId,
    tokenStatus,
    creditStatus: 'unavailable' as const,
    ...(tokenStatus === 'available' ? {
      tokens: {
        totalTokens,
        inputTokens: totalTokens - 1,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
        outputTokens: 1,
        reasoningOutputTokens: 25,
        modelContextWindow: 128_000,
        source,
      },
    } : {}),
  };
}

describe('cumulative session token usage', () => {
  it('counts a repeated cumulative thread once and keeps its greatest authoritative snapshot', () => {
    const first = pass('pass-1', 1, { orchestratorThreadId: 'shared-orchestrator', workerThreadId: 'worker-one' }, {
      orchestrator: usage('shared-orchestrator', 100),
      worker: usage('worker-one', 40, 'thread-estimate'),
    });
    const followUp = pass('pass-2', 2, { orchestratorThreadId: 'shared-orchestrator', workerThreadId: 'worker-two' }, {
      orchestrator: usage('shared-orchestrator', 155),
      worker: usage('worker-two', 75),
    });

    const summary = summarizeSessionUsage(task([first, followUp], {
      currentPassId: 'pass-2',
      orchestratorThreadId: 'shared-orchestrator',
      workerThreadId: 'worker-two',
    }));

    expect(summary.total).toMatchObject({ status: 'available', expectedThreads: 3, reportedThreads: 3, totalTokens: 270n, authoritativeThreads: 2, estimatedThreads: 1 });
    expect(summary.roles.orchestrator).toMatchObject({ expectedThreads: 1, totalTokens: 155n });
    expect(summary.roles.worker).toMatchObject({ expectedThreads: 2, totalTokens: 115n });
    expect(summary.threads.filter((thread) => thread.threadId === 'shared-orchestrator')).toHaveLength(1);
    expect(summary.threads.find((thread) => thread.threadId === 'shared-orchestrator')?.tokens?.source).toBe('thread');
  });

  it('sums independent threads across pass history and breaks out router, direct, simple, orchestrator, and worker roles', () => {
    const first = pass('pass-1', 1, {
      routerThreadId: 'router-one',
      orchestratorThreadId: 'orchestrator-one',
      workerThreadId: 'worker-one',
    }, {
      router: usage('router-one', 12),
      orchestrator: usage('orchestrator-one', 30),
      worker: usage('worker-one', 58),
    });
    const second = pass('pass-2', 2, {
      routerThreadId: 'router-two',
      directThreadId: 'direct-two',
      simpleThreadId: 'simple-two',
    }, {
      router: usage('router-two', 14),
      direct: usage('direct-two', 20),
      simple: usage('simple-two', 26),
    });

    const summary = summarizeSessionUsage(task([first, second], { currentPassId: 'pass-2' }));

    expect(summary.total.totalTokens).toBe(160n);
    expect(summary.roles.router.totalTokens).toBe(26n);
    expect(summary.roles.direct.totalTokens).toBe(20n);
    expect(summary.roles.simple.totalTokens).toBe(26n);
    expect(summary.roles.orchestrator.totalTokens).toBe(30n);
    expect(summary.roles.worker.totalTokens).toBe(58n);
  });

  it('prefers authoritative thread usage over a larger estimated snapshot for the same thread', () => {
    const first = pass('pass-1', 1, { workerThreadId: 'worker-shared' }, {
      worker: usage('worker-shared', 90),
    });
    const second = pass('pass-2', 2, { workerThreadId: 'worker-shared' }, {
      worker: usage('worker-shared', 900, 'thread-estimate'),
    });

    const summary = summarizeSessionUsage(task([first, second]));

    expect(summary.total.totalTokens).toBe(90n);
    expect(summary.total.authoritativeThreads).toBe(1);
    expect(summary.total.estimatedThreads).toBe(0);
  });

  it('keeps pending, unavailable, and unreported threads explicit without reporting a fabricated zero', () => {
    const p = pass('pass-1', 1, {
      routerThreadId: 'router-pending',
      orchestratorThreadId: 'orchestrator-unavailable',
      workerThreadId: 'worker-unreported',
    }, {
      router: usage('router-pending', 0, 'thread', 'pending'),
      orchestrator: usage('orchestrator-unavailable', 0, 'thread', 'unavailable'),
    });

    const summary = summarizeSessionUsage(task([p]));

    expect(summary.total).toMatchObject({ status: 'pending', expectedThreads: 3, reportedThreads: 0, pendingThreads: 1, unavailableThreads: 1, notReportedThreads: 1, totalTokens: null });
    expect(summary.roles.orchestrator.status).toBe('unavailable');
    expect(summary.roles.worker.status).toBe('not-reported');
  });

  it('uses an estimate only when no authoritative thread total exists', () => {
    const p = pass('pass-1', 1, { routerThreadId: 'router-estimate', workerThreadId: 'worker-pending' }, {
      router: usage('router-estimate', 33, 'thread-estimate'),
      worker: usage('worker-pending', 0, 'thread', 'pending'),
    });

    const summary = summarizeSessionUsage(task([p]));

    expect(summary.total).toMatchObject({ status: 'partial', totalTokens: 33n, estimatedThreads: 1, pendingThreads: 1 });
  });

  it('uses bigint for session totals that exceed the safe integer range', () => {
    const p = pass('pass-1', 1, { orchestratorThreadId: 'large-one', workerThreadId: 'large-two' }, {
      orchestrator: usage('large-one', Number.MAX_SAFE_INTEGER),
      worker: usage('large-two', Number.MAX_SAFE_INTEGER),
    });

    expect(summarizeSessionUsage(task([p])).total.totalTokens).toBe(18_014_398_509_481_982n);
  });

  it('selects the requested current pass and falls back to the latest stored pass when its id is absent', () => {
    const first = pass('pass-1', 1);
    const second = pass('pass-2', 2);

    expect(getCurrentTaskPass(task([first, second], { currentPassId: 'pass-1' }))?.id).toBe('pass-1');
    expect(getCurrentTaskPass(task([first, second], { currentPassId: 'missing-pass' }))?.id).toBe('pass-2');
  });
});
