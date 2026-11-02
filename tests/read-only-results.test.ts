import { describe, expect, it } from 'vitest';
import { formatReadOnlyWorkerResults } from '../server/read-only-results.js';

describe('read-only worker result formatting', () => {
  it('shows a single worker answer as readable text instead of serialized receipt metadata', () => {
    const answer =
      'I am DeepSeek V4.1 Flash running in DeepSeek Harness.\n\nThe provider route is host-selected.';
    const result = formatReadOnlyWorkerResults([
      { name: 'identity reporter', status: 'complete', receipt: { result: answer } },
    ]);
    expect(result).toBe(answer);
    expect(result).not.toContain('workerId');
    expect(result).not.toContain('headCommit');
  });

  it('keeps failed status visible while showing the worker response', () => {
    expect(
      formatReadOnlyWorkerResults([
        { name: 'reporter', status: 'failed', receipt: { result: 'The DSH session stopped.' } },
      ])
    ).toBe('Worker “reporter” — failed.\n\nThe DSH session stopped.');
  });

  it('uses compact named sections for multiple workers', () => {
    const result = formatReadOnlyWorkerResults([
      {
        name: 'provider check',
        status: 'complete',
        receipt: { result: 'The selected provider is OpenCode Go.' },
      },
      { name: 'model check', status: 'blocked', receipt: { result: 'No runtime response.' } },
    ]);
    expect(result).toContain(
      '### provider check — completed\n\nThe selected provider is OpenCode Go.'
    );
    expect(result).toContain('### model check — blocked\n\nNo runtime response.');
    expect(result).not.toContain('"workerId"');
  });
});
