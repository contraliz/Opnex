// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ToolCallLogView } from '../src/ui/ToolCallLogView.js';
import type { ToolCallLog } from '../src/types.js';

it('rounds tool-call durations before splitting minutes and seconds', () => {
  const log: ToolCallLog = {
    schemaVersion: 1,
    total: 1,
    statusCounts: { started: 0, completed: 1, failed: 0, interrupted: 0 },
    seen: { 'openai:thread-a:turn-a:call-a': 'completed' },
    calls: [
      {
        key: 'call-a',
        identity: {
          provider: 'openai',
          agentId: 'worker-a',
          threadId: 'thread-a',
          turnId: 'turn-a',
          callId: 'call-a',
        },
        name: 'search',
        type: 'mcp',
        status: 'completed',
        sources: ['model'],
        firstSeenAt: '2026-11-02T00:00:00.000Z',
        lastSeenAt: '2026-11-02T00:01:59.500Z',
        startedAt: '2026-11-02T00:00:00.000Z',
        finishedAt: '2026-11-02T00:01:59.500Z',
      },
    ],
    omittedCount: 0,
  };

  render(<ToolCallLogView log={log} />);

  expect(screen.getByText('2m 0s')).toBeTruthy();
});
