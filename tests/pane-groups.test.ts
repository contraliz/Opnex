import { describe, expect, it } from 'vitest';
import { closePaneTab, moveTabToTab, normalizePanes, resizeAdjacentPanes, splitPane, type SessionPane } from '../src/ui/paneGroups';

const three: SessionPane[] = [
  { id: 'a', tabs: ['a1', 'a2'], activeTab: 'a2', weight: 1 },
  { id: 'b', tabs: ['b1'], activeTab: 'b1', weight: 1 },
  { id: 'c', tabs: ['c1'], activeTab: 'c1', weight: 1 },
];

describe('horizontal pane groups', () => {
  it('splits any pane on either side and preserves the existing groups and ratios', () => {
    const left = splitPane(three, 'new:left', 'b', 'left', 'x', true);
    expect(left.map(pane => pane.id)).toEqual(['a', 'x', 'b', 'c']);
    expect(left[1].weight).toBe(0.5);
    expect(left[2].weight).toBe(0.5);
    const right = splitPane(left, 'new:right', 'c', 'right', 'y', true);
    expect(right.map(pane => pane.id)).toEqual(['a', 'x', 'b', 'c', 'y']);
    expect(splitPane(right, 'ignored', 'a', 'left', 'z', false)).toBe(right);
  });

  it('moves tabs across arbitrary groups, prunes an emptied middle group, and reorders within a group', () => {
    const moved = moveTabToTab(three, 'b1', 'c1');
    expect(moved.map(pane => pane.id)).toEqual(['a', 'c']);
    expect(moved[1]).toMatchObject({ tabs: ['b1', 'c1'], activeTab: 'b1' });
    expect(moved.map(pane => pane.weight)).toEqual([0.5, 0.5]);
    expect(moveTabToTab(moved, 'a2', 'a1')[0].tabs).toEqual(['a2', 'a1']);
  });

  it('resizes every adjacent pair and migrates tabs when one group crosses the collapse threshold', () => {
    const resized = resizeAdjacentPanes(three, 'b', 'c', 48, 1600);
    expect(resized.collapsed).toBeNull();
    expect(resized.panes[1].weight).toBeCloseTo(1.09);
    expect(resized.panes[2].weight).toBeCloseTo(0.91);
    const collapsed = resizeAdjacentPanes(three, 'b', 'c', -700, 1600);
    expect(collapsed.collapsed).toBe('b');
    expect(collapsed.panes.map(pane => pane.id)).toEqual(['a', 'c']);
    expect(collapsed.panes[1].tabs).toEqual(['b1', 'c1']);
    expect(collapsed.panes[1].activeTab).toBe('b1');
    expect(collapsed.panes.map(pane => pane.weight)).toEqual([1 / 3, 2 / 3]);
  });

  it('keeps unrelated groups stable while resizing later dividers and expands the survivor on collapse', () => {
    const four: SessionPane[] = [
      { id: 'a', tabs: ['a1'], activeTab: 'a1', weight: 1 },
      { id: 'b', tabs: ['b1'], activeTab: 'b1', weight: 1 },
      { id: 'c', tabs: ['c1'], activeTab: 'c1', weight: 1 },
      { id: 'd', tabs: ['d1', 'd2'], activeTab: 'd2', weight: 1 },
    ];
    const resized = resizeAdjacentPanes(four, 'c', 'd', -64, 1600);
    expect(resized.panes.slice(0, 2).map(pane => pane.weight)).toEqual([1, 1]);
    expect(resized.panes[2].weight).toBeCloseTo(0.84);
    expect(resized.panes[3].weight).toBeCloseTo(1.16);
    expect(resized.panes.slice(0, 2)).toEqual(four.slice(0, 2));

    const collapsed = resizeAdjacentPanes(four, 'c', 'd', -600, 1600);
    expect(collapsed.collapsed).toBe('c');
    expect(collapsed.panes.map(pane => pane.id)).toEqual(['a', 'b', 'd']);
    expect(collapsed.panes[2]).toMatchObject({ tabs: ['c1', 'd1', 'd2'], activeTab: 'c1' });
    expect(collapsed.panes.map(pane => pane.weight)).toEqual([0.25, 0.25, 0.5]);

    const rightCollapsed = resizeAdjacentPanes(four, 'c', 'd', 600, 1600);
    expect(rightCollapsed.collapsed).toBe('d');
    expect(rightCollapsed.panes[2]).toMatchObject({ tabs: ['c1', 'd1', 'd2'], activeTab: 'c1' });
    expect(rightCollapsed.panes.map(pane => pane.weight)).toEqual([0.25, 0.25, 0.5]);
  });

  it('prunes any empty group, preserves a final usable root tab, and repairs missing active ids', () => {
    const closed = closePaneTab(three, 'b1', () => 'fallback');
    expect(closed.map(pane => pane.id)).toEqual(['a', 'c']);
    expect(closed.map(pane => pane.weight)).toEqual([0.5, 0.5]);
    expect(closePaneTab([{ id: 'root', tabs: ['only'], activeTab: 'only', weight: 1 }], 'only', () => 'new:restored')).toEqual([
      { id: 'root', tabs: ['new:restored'], activeTab: 'new:restored', weight: 1 },
    ]);
    expect(normalizePanes([{ id: 'root', tabs: ['safe'], activeTab: 'gone', weight: 1 }], () => 'unused')[0].activeTab).toBe('safe');
  });
});
