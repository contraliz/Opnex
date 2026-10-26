// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecruitmentTeamPanel, type RecruitmentTeam } from '../src/ui/RecruitmentTeamPanel.js';

const receipt = { status: 'complete', result: 'Done', changes: [], acceptance: { met: ['Works'], unmet: [] }, verification: [], risks: [], knowledge: { consulted: [], updated: [] }, decision_required: null };
const team: RecruitmentTeam = {
  teamId: 'team-1',
  status: 'integrating',
  workers: [
    { workerId: 'w1', name: 'Worker One', status: 'complete', effort: 'high', branch: 'recruitment/task/worker-one', worktreePath: 'D:/state/worker-one', assignment: { outcome: 'Implement A', deliverable: 'A', read_scope: ['src'], write_scope: ['src'] }, receipt },
    { workerId: 'w2', name: 'Worker Two', status: 'context_plan', canSteer: true, effort: 'max', branch: 'recruitment/task/worker-two', worktreePath: 'D:/state/worker-two', assignment: { outcome: 'Implement B', deliverable: 'B', read_scope: ['tests'], write_scope: ['tests'] } },
  ],
  integration: { status: 'context_compose', canSteer: true, branch: 'recruitment/task/integration', worktreePath: 'D:/state/integration' },
};

describe('recruitment roster panel', () => {
  it('shows the actual recruited count and one distinct worker bar per worker, separate from integration', () => {
    render(<RecruitmentTeamPanel team={team} />);
    expect(screen.getByText('2 workers recruited')).toBeTruthy();
    const roster = screen.getByRole('list', { name: 'Recruited workers (2)' });
    expect((roster as HTMLUListElement).children).toHaveLength(2);
    expect(within(roster).getByRole('heading', { name: 'Worker One' })).toBeTruthy();
    expect(within(roster).getByRole('heading', { name: 'Worker Two' })).toBeTruthy();
    expect(within(roster).getAllByText('max')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Integration' })).toBeTruthy();
    expect(screen.queryByText('3 workers recruited')).toBeNull();
  });
  it('offers steering for active context and integration turns', () => {
    const selected: string[] = [];
    render(<RecruitmentTeamPanel team={team} onSelectSteerWorker={(workerId) => selected.push(workerId)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Steer this worker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Steer integration agent' }));
    expect(selected).toEqual(['w2', 'integration']);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
