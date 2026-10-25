export type WorkspaceTabKind = 'session' | 'browser' | 'git' | 'skills';

export type WorkspaceTabRecord = {
  id: string;
  kind: Exclude<WorkspaceTabKind, 'session'>;
  originTabId: string | null;
  originTaskId: string | null;
  projectRoot: string;
  initialUrl?: string;
  focusUrl?: string;
};

export type WorkspaceTabRegistry = Readonly<Record<string, WorkspaceTabRecord>>;

export type WorkspaceTabContext = {
  originTabId: string | null;
  projectRoot: string;
  initialUrl?: string;
  focusUrl?: string;
};

export function workspaceTabKind(id: string): WorkspaceTabKind {
  if (id.startsWith('browser:')) return 'browser';
  if (id.startsWith('git:')) return 'git';
  if (id.startsWith('skills:')) return 'skills';
  return 'session';
}

export function workspaceKindForMode(mode: string): Exclude<WorkspaceTabKind, 'session'> | null {
  if (mode === 'browser') return 'browser';
  if (mode === 'git' || mode === 'github') return 'git';
  return null;
}

export function createWorkspaceTabId(kind: Exclude<WorkspaceTabKind, 'session'>, nonce: string | number): string {
  return `${kind}:${nonce}`;
}

export function createWorkspaceTabRecord(
  kind: Exclude<WorkspaceTabKind, 'session'>,
  id: string,
  context: WorkspaceTabContext,
): WorkspaceTabRecord {
  if (workspaceTabKind(id) !== kind) throw new Error(`Workspace tab ID must use the ${kind}: prefix.`);
  const originTaskId = context.originTabId && !context.originTabId.startsWith('new:') ? context.originTabId : null;
  return {
    id,
    kind,
    originTabId: context.originTabId,
    originTaskId,
    projectRoot: context.projectRoot,
    ...(context.initialUrl ? { initialUrl: context.initialUrl } : {}),
    ...(context.focusUrl ? { focusUrl: context.focusUrl } : {}),
  };
}

export function registerWorkspaceTab(registry: WorkspaceTabRegistry, tab: WorkspaceTabRecord): WorkspaceTabRegistry {
  if (workspaceTabKind(tab.id) !== tab.kind) throw new Error(`Workspace tab ID must use the ${tab.kind}: prefix.`);
  return { ...registry, [tab.id]: tab };
}

export function removeWorkspaceTab(registry: WorkspaceTabRegistry, id: string): WorkspaceTabRegistry {
  if (!(id in registry)) return registry;
  const next = { ...registry };
  delete next[id];
  return next;
}

export function workspaceTabTitle(id: string, sessionTitle?: string): string {
  const kind = workspaceTabKind(id);
  if (kind === 'browser') return 'Browser';
  if (kind === 'git') return 'Git';
  if (kind === 'skills') return 'Skills';
  if (id.startsWith('new:')) return 'New session';
  return sessionTitle || 'Session';
}
