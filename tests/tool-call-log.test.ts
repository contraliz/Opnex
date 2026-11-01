import { describe, expect, it } from 'vitest';
import { createToolCallLog, interruptRunningToolCalls, recordToolCall, type ToolCallEvent, type ToolCallLog } from '../server/tool-call-log.js';

const event = (lifecycle: ToolCallEvent['lifecycle'], patch: Partial<ToolCallEvent> = {}): ToolCallEvent => ({
  identity: { provider: 'openai', agentId: 'worker-a', threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a' },
  name: 'search',
  type: 'mcp',
  source: 'model',
  lifecycle,
  timestamp: '2026-10-30T00:00:00.000Z',
  ...patch,
});

describe('tool call log', () => {
  it('counts duplicate starts and completions once per invocation', () => {
    const empty = createToolCallLog();
    const started = recordToolCall(empty, event('started'));
    const duplicateStart = recordToolCall(started, event('started'));
    const completed = recordToolCall(duplicateStart, event('completed', { timestamp: '2026-10-30T00:00:01.000Z' }));
    const duplicateCompletion = recordToolCall(completed, event('completed', { timestamp: '2026-10-30T00:00:01.000Z' }));

    expect(duplicateCompletion.total).toBe(1);
    expect(duplicateCompletion.statusCounts).toEqual({ started: 0, completed: 1, failed: 0, interrupted: 0 });
    expect(duplicateCompletion.calls).toHaveLength(1);
    expect(duplicateCompletion.calls[0].status).toBe('completed');
    expect(started.total).toBe(1);
    expect(started.statusCounts.started).toBe(1);
    expect(empty).toMatchObject({ total: 0, statusCounts: { started: 0 }, calls: [] });
  });

  it('keeps a terminal event when a late start arrives', () => {
    const terminal = recordToolCall(createToolCallLog(), event('completed', { timestamp: '2026-10-30T00:00:01.000Z' }));
    const lateStart = recordToolCall(terminal, event('started'));

    expect(lateStart.total).toBe(1);
    expect(lateStart.statusCounts).toEqual({ started: 0, completed: 1, failed: 0, interrupted: 0 });
    expect(lateStart.calls[0]).toMatchObject({ status: 'completed', startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:01.000Z' });
  });

  it('scopes repeated provider call IDs to provider, agent, thread, and turn', () => {
    const baseIdentity = event('started').identity;
    const identities = [
      baseIdentity,
      { ...baseIdentity, provider: 'anthropic' },
      { ...baseIdentity, agentId: 'worker-b' },
      { ...baseIdentity, threadId: 'thread-b' },
      { ...baseIdentity, turnId: 'turn-b' },
    ];
    const log = identities.reduce((current, identity) => recordToolCall(current, event('started', { identity })), createToolCallLog());

    expect(log.total).toBe(5);
    expect(log.statusCounts.started).toBe(5);
  });

  it('merges application and model observations for the same invocation', () => {
    const model = event('started');
    const app = recordToolCall(createToolCallLog(), event('started', { ...model, source: 'application' }));
    const combined = recordToolCall(app, model);

    expect(combined.total).toBe(1);
    expect(combined.statusCounts.started).toBe(1);
    expect(combined.calls[0].sources).toEqual(['application', 'model']);
  });

  it('counts failures and interrupts only calls still running at shutdown', () => {
    const failed = recordToolCall(createToolCallLog(), event('failed'));
    const cancelled = recordToolCall(failed, event('interrupted', { identity: { ...event('started').identity, callId: 'cancelled-a' } }));
    const running = recordToolCall(cancelled, event('started', { identity: { ...event('started').identity, callId: 'running-a' } }));
    const anotherRunning = recordToolCall(running, event('started', { identity: { ...event('started').identity, callId: 'running-b' } }));
    const stopped = interruptRunningToolCalls(anotherRunning, '2026-10-30T00:01:00.000Z');

    expect(stopped.total).toBe(4);
    expect(stopped.statusCounts).toEqual({ started: 0, completed: 0, failed: 1, interrupted: 3 });
    expect(stopped.calls.map(row => row.status)).toEqual(['failed', 'interrupted', 'interrupted', 'interrupted']);
    expect(interruptRunningToolCalls(stopped, '2026-10-30T00:02:00.000Z')).toBe(stopped);
  });

  it('survives JSON persistence and idempotent event replay', () => {
    const events = [
      event('started'),
      event('started', { source: 'application' }),
      event('completed', { timestamp: '2026-10-30T00:00:01.000Z' }),
    ];
    const recorded = events.reduce(recordToolCall, createToolCallLog());
    const restored = JSON.parse(JSON.stringify(recorded)) as ToolCallLog;
    const replayed = events.reduce(recordToolCall, restored);

    expect(restored).toEqual(recorded);
    expect(replayed).toEqual(recorded);
  });

  it('keeps exact counts after detail rows are trimmed', () => {
    let log = createToolCallLog();
    for (let index = 0; index < 1005; index += 1) {
      log = recordToolCall(log, event('started', { identity: { ...event('started').identity, callId: `call-${index}` } }));
    }
    const olderCallCompleted = recordToolCall(log, event('completed', { identity: { ...event('started').identity, callId: 'call-0' } }));
    const stopped = interruptRunningToolCalls(olderCallCompleted, '2026-10-30T00:01:00.000Z');

    expect(log).toMatchObject({ total: 1005, omittedCount: 5, statusCounts: { started: 1005 } });
    expect(log.calls).toHaveLength(1000);
    expect(olderCallCompleted).toMatchObject({ total: 1005, omittedCount: 5, statusCounts: { started: 1004, completed: 1 } });
    expect(olderCallCompleted.calls).toHaveLength(1000);
    expect(olderCallCompleted.calls[0].identity.callId).toBe('call-5');
    expect(stopped).toMatchObject({ total: 1005, omittedCount: 5, statusCounts: { started: 0, completed: 1, interrupted: 1004 } });
  });

  it('bounds display text and does not retain raw payload fields', () => {
    const input = {
      ...event('completed', { name: 'n'.repeat(500), type: 't'.repeat(500), agentRole: 'r'.repeat(100), summary: 's'.repeat(1000) }),
      arguments: 'RAW_ARGUMENTS',
      result: 'RAW_RESULT',
      identity: { ...event('started').identity, extra: 'RAW_IDENTITY_PAYLOAD' },
    } as ToolCallEvent;
    const log = recordToolCall(createToolCallLog(), input);
    const [row] = log.calls;

    expect(row.name).toHaveLength(160);
    expect(row.type).toHaveLength(160);
    expect(row.agentRole).toHaveLength(80);
    expect(row.summary).toHaveLength(500);
    expect(JSON.stringify(log)).not.toContain('RAW_');
  });

  it('rejects overlong identity parts instead of making colliding keys', () => {
    const tooLong = { ...event('started').identity, callId: 'c'.repeat(257) };

    expect(() => recordToolCall(createToolCallLog(), event('started', { identity: tooLong }))).toThrow(RangeError);
  });
});
