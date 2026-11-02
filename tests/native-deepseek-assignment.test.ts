import { describe, expect, it } from 'vitest';
import type { Assignment } from '../server/contracts.js';
import { nativeDeepSeekWorkerAssignment } from '../server/orchestrator.js';

const assignment = (outcome: string, deliverable: string): Assignment => ({
  outcome,
  deliverable,
  read_scope: [],
  write_scope: [],
  exclusions: [],
  constraints: [],
  context_refs: [],
  acceptance: [],
  verification: [],
  ordinary_authority: [],
  escalation_conditions: [],
  receipt_requirements: [],
  skill_refs: [],
});

describe('native DSH worker assignment data', () => {
  it('supplies the assigned label only when the assignment requests that label', () => {
    const workerName = nativeDeepSeekWorkerAssignment(
      assignment('Report your worker name.', 'Return that worker name.'),
      'name_reporter'
    );
    expect(workerName).toMatchObject({ task_data: { assigned_worker_name: 'name_reporter' } });

    const requested = nativeDeepSeekWorkerAssignment(
      assignment('Report your assigned worker name.', 'Return that assigned name.'),
      'name_reporter'
    );
    expect(requested).toMatchObject({ task_data: { assigned_worker_name: 'name_reporter' } });

    const identityQuestion = nativeDeepSeekWorkerAssignment(
      assignment(
        'Report the model and provider exposed by your execution context.',
        'Say which model and provider you are running as.'
      ),
      'identity_reporter'
    );
    expect(identityQuestion).not.toHaveProperty('task_data');
    expect(identityQuestion).not.toHaveProperty('persona');

    const ambiguousName = nativeDeepSeekWorkerAssignment(
      assignment('Tell the worker to return its name.', 'Return your name.'),
      'name_reporter'
    );
    expect(ambiguousName).not.toHaveProperty('task_data');
  });
});
