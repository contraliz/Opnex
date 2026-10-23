export type SessionPane = { id: string; tabs: string[]; activeTab: string; weight: number };
export type PaneSide = 'left' | 'right';

export function normalizePanes(panes: SessionPane[], makeFallback: () => string): SessionPane[] {
  const groups = panes.filter(pane => pane.tabs.length > 0).map(pane => ({
    ...pane,
    activeTab: pane.tabs.includes(pane.activeTab) ? pane.activeTab : pane.tabs[0],
    weight: Number.isFinite(pane.weight) && pane.weight > 0 ? pane.weight : 1,
  }));
  if (groups.length) {
    const totalWeight = groups.reduce((sum, pane) => sum + pane.weight, 0);
    return groups.map(pane => ({ ...pane, weight: pane.weight / totalWeight }));
  }
  const fallback = makeFallback();
  return [{ id: panes[0]?.id || 'pane:root', tabs: [fallback], activeTab: fallback, weight: 1 }];
}

export function splitPane(panes: SessionPane[], tab: string, targetId: string, side: PaneSide, id: string, canSplit: boolean): SessionPane[] {
  if (!canSplit || panes.some(pane => pane.tabs.includes(tab))) return panes;
  const targetIndex = panes.findIndex(pane => pane.id === targetId);
  if (targetIndex < 0) return panes;
  const target = panes[targetIndex];
  const half = target.weight / 2;
  const next = [...panes];
  next[targetIndex] = { ...target, weight: half };
  next.splice(targetIndex + (side === 'right' ? 1 : 0), 0, { id, tabs: [tab], activeTab: tab, weight: half });
  return next;
}

export function moveTabToTab(panes: SessionPane[], tab: string, targetTab: string): SessionPane[] {
  if (tab === targetTab) return panes;
  const from = panes.findIndex(pane => pane.tabs.includes(tab));
  const to = panes.findIndex(pane => pane.tabs.includes(targetTab));
  if (from < 0 || to < 0) return panes;
  const source = panes[from];
  const target = panes[to];
  if (from === to) {
    const tabs = [...source.tabs];
    tabs.splice(tabs.indexOf(tab), 1);
    tabs.splice(tabs.indexOf(targetTab), 0, tab);
    return panes.map(pane => pane.id === source.id ? { ...pane, tabs } : pane);
  }
  const next = [...panes];
  const sourceTabs = source.tabs.filter(item => item !== tab);
  const targetTabs = [...target.tabs];
  targetTabs.splice(targetTabs.indexOf(targetTab), 0, tab);
  next[to] = { ...target, tabs: targetTabs, activeTab: tab };
  if (sourceTabs.length) next[from] = { ...source, tabs: sourceTabs, activeTab: sourceTabs.includes(source.activeTab) ? source.activeTab : sourceTabs[0] };
  else next.splice(from, 1);
  return normalizePanes(next, () => `new:${Date.now()}`);
}

export function closePaneTab(panes: SessionPane[], tab: string, makeFallback: () => string): SessionPane[] {
  const index = panes.findIndex(pane => pane.tabs.includes(tab));
  if (index < 0) return panes;
  const pane = panes[index];
  const tabs = pane.tabs.filter(item => item !== tab);
  if (tabs.length) return panes.map((item, i) => i === index ? { ...item, tabs, activeTab: item.activeTab === tab ? tabs[Math.max(0, pane.tabs.indexOf(tab) - 1)] : item.activeTab } : item);
  if (panes.length > 1) return normalizePanes(panes.filter((_, i) => i !== index), makeFallback);
  const fallback = makeFallback();
  return [{ ...pane, tabs: [fallback], activeTab: fallback, weight: 1 }];
}

export function resizeAdjacentPanes(panes: SessionPane[], leftId: string, rightId: string, delta: number, fullWidth: number, minWidth = 168): { panes: SessionPane[]; collapsed: string | null } {
  const leftIndex = panes.findIndex(pane => pane.id === leftId);
  const rightIndex = panes.findIndex(pane => pane.id === rightId);
  if (leftIndex < 0 || rightIndex !== leftIndex + 1 || fullWidth <= 0) return { panes, collapsed: null };
  const left = panes[leftIndex], right = panes[rightIndex];
  const totalWeight = panes.reduce((sum, pane) => sum + pane.weight, 0);
  const pairWeight = left.weight + right.weight;
  const pairWidth = fullWidth * pairWeight / totalWeight;
  const leftPixels = pairWidth * left.weight / pairWeight + delta;
  if (leftPixels < minWidth) {
    const next = panes.filter(pane => pane.id !== leftId).map(pane => pane.id === rightId ? {
      ...pane,
      tabs: [...left.tabs, ...pane.tabs],
      // Preserve the pane being dragged/collapsed as the selected content;
      // all drafts stay keyed by tab ID in the merged group.
      activeTab: left.activeTab,
      weight: pairWeight,
    } : pane);
    return { panes: normalizePanes(next, () => `new:${Date.now()}`), collapsed: leftId };
  }
  if (pairWidth - leftPixels < minWidth) {
    const next = panes.filter(pane => pane.id !== rightId).map(pane => pane.id === leftId ? {
      ...pane,
      tabs: [...pane.tabs, ...right.tabs],
      weight: pairWeight,
    } : pane);
    return { panes: normalizePanes(next, () => `new:${Date.now()}`), collapsed: rightId };
  }
  const leftWeight = pairWeight * leftPixels / pairWidth;
  return { panes: panes.map(pane => pane.id === leftId ? { ...pane, weight: leftWeight } : pane.id === rightId ? { ...pane, weight: pairWeight - leftWeight } : pane), collapsed: null };
}
