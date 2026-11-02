import { SessionConversation } from './SessionConversation';
import { SessionExplorer } from './SessionExplorer';
import {
  createRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  BookOpen,
  Copy,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Maximize2,
  MessageSquarePlus,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  Settings2,
  X,
} from 'lucide-react';
import { api, bootstrap, KERNEL_PROTOCOL_VERSION } from './api';
import Composer from './Composer';
import { prepareMarkdownSubmission } from './LiveMarkdownEditor';
import SettingsDialog from './SettingsDialog';
import { ProjectEditorDialog } from './ProjectEditorDialog';
import { SessionDialog } from './SessionControls';
import { HeadsUpPanel } from './HeadsUpPanel';
import ForgeSessionCreate from './ForgeSessionCreate';
import { accessModeFromApproval, runtimeApprovalForAccess } from './access-mode.js';
import { respondForgeApproval } from './api';
import './Forge.css';
import { EmbeddedWorkspace } from './EmbeddedWorkspace';
import {
  closePaneTab,
  moveTabToTab,
  normalizePanes,
  resizeAdjacentPanes,
  splitPane,
  type SessionPane,
} from './paneGroups';
import { formatBrowserAnnotation } from './browser-annotation';
import {
  createWorkspaceTabId,
  createWorkspaceTabRecord,
  registerWorkspaceTab,
  removeWorkspaceTab,
  workspaceKindForMode,
  workspaceTabKind,
  workspaceTabTitle,
  type WorkspaceTabRecord,
  type WorkspaceTabRegistry,
} from './workspaceTabs';
import { workspaceOptionLabel } from './workspace-label';
import type {
  AppState,
  BrowserAnnotation,
  ExecutionProfile,
  ForgeTicket,
  Project,
  Runtime,
  Settings,
  Task,
  TaskAttachment,
} from '../types';
const SkillsLibraryPage = lazy(() =>
  import('./SkillsLibraryDialog').then((module) => ({
    default: module.SkillsLibraryPage,
  }))
);

const fallbackSettings: Settings = {
  orchestratorModel: 'gpt-6.1-sol',
  orchestratorEffort: 'low',
  fontFamily: 'sans',
  approvalPolicy: 'on-request',
  executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' },
  mcpServers: [],
};
const makePaneId = () => `pane:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
const makeFallbackTab = () => `new:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
async function encodeAttachments(
  files: FileList | null,
  existing: TaskAttachment[]
): Promise<TaskAttachment[]> {
  if (!files?.length) return [];
  const selected = Array.from(files);
  if (existing.length + selected.length > 5) throw new Error('Choose no more than five files.');
  const allowed = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
  ]);
  let total = existing.reduce((sum, file) => sum + file.size, 0);
  for (const file of selected) {
    if (file.size > 5 * 1024 * 1024)
      throw new Error(`${file.name} is over the 5 MiB per-file limit.`);
    if (!allowed.has(file.type)) throw new Error(`Unsupported attachment format: ${file.name}.`);
    total += file.size;
  }
  if (total > 12 * 1024 * 1024) throw new Error('Attachments exceed the 12 MiB total limit.');
  return Promise.all(
    selected.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return {
        name: file.name,
        type: file.type,
        size: file.size,
        data: btoa(binary),
      };
    })
  );
}
export default function App() {
  const desktopBridge = window.opnexDesktop || window.pseudoharnessDesktop;
  const windowControls = desktopBridge?.windowControls;
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [state, setState] = useState<AppState | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newSessionTypes, setNewSessionTypes] = useState<Record<string, 'conversation' | 'forge'>>(
    {}
  );
  const [qualityModes, setQualityModes] = useState<Record<string, boolean>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, TaskAttachment[]>>(
    {}
  );
  const [recruitmentSteerTargets, setRecruitmentSteerTargets] = useState<Record<string, string>>(
    {}
  );
  const [panes, setPanes] = useState<SessionPane[]>([
    { id: 'pane:root', tabs: ['new:0'], activeTab: 'new:0', weight: 1 },
  ]);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTabRegistry>({});
  const [focusedPaneId, setFocusedPaneId] = useState('pane:root');
  const focusedPaneIdRef = useRef(focusedPaneId);
  focusedPaneIdRef.current = focusedPaneId;
  const [tabErrors, setTabErrors] = useState<Record<string, string>>({});
  const [headsUpOpen, setHeadsUpOpen] = useState<Record<string, boolean>>({});
  const [sendingTabs, setSendingTabs] = useState<Record<string, boolean>>({});
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    paneId: string;
    half: 'left' | 'right';
  } | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);
  const [sessionArrival, setSessionArrival] = useState('');
  const [closingTabs, setClosingTabs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => windowControls?.onState(setWindowMaximized), [windowControls]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<{
    kind: 'rename' | 'delete';
    taskId: string;
  } | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionDialogMounted, setSessionDialogMounted] = useState(false);
  const [projectEditor, setProjectEditor] = useState<Project | 'new' | null>(null);
  const [showAllProjects, setShowAllProjects] = useState<Record<string, boolean>>({});
  const [projectMoveError, setProjectMoveError] = useState('');
  const [projectDropTarget, setProjectDropTarget] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsCloseRef = useRef<HTMLButtonElement>(null);
  const shortcutsRestoreFocus = useRef<HTMLElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(296);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      window.dispatchEvent(new Event('opnex:shell-layout'))
    );
    return () => cancelAnimationFrame(frame);
  }, [sidebarCollapsed, sidebarWidth]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    if (shortcutsOpen) shortcutsCloseRef.current?.focus();
    else {
      shortcutsRestoreFocus.current?.focus();
      shortcutsRestoreFocus.current = null;
    }
  }, [shortcutsOpen]);
  const openShortcuts = () => {
    shortcutsRestoreFocus.current = document.activeElement as HTMLElement | null;
    setShortcutsOpen(true);
  };
  const closeShortcuts = () => setShortcutsOpen(false);
  const trapShortcutsTab = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
      )
    ).filter((item) => !item.closest('[hidden],[inert],[aria-hidden="true"]'));
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      shortcutsCloseRef.current?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const paneInputRefs = useRef<Record<string, any>>({});
  const headsUpTriggerRefs = useRef<Record<string, any>>({});
  const sessionScrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollMemory = useRef<Record<string, { messages: number; reasoning: number }>>({});
  const nearBottom = useRef<Record<string, boolean>>({});
  const sendingRef = useRef<Set<string>>(new Set());
  const handledWorkspaceCommand = useRef<Set<string>>(new Set());
  const resizeRef = useRef<any>(null);
  const tabDropTargetRef = useRef<string | null>(null);
  const projectExpandedRef = useRef<string[]>([]);
  const projectExpansionQueue = useRef(Promise.resolve());
  const kernelCursor = useRef<{ instanceId: string; revision: number } | null>(null);
  const recentSessionNavigation = useRef<{
    ids: string[];
    activeId: string | null;
  } | null>(null);
  const tabDragSuppressUntil = useRef<{ tab: string; until: number } | null>(null);
  const closeTimers = useRef<Record<string, number>>({});
  const settingsQueue = useRef(Promise.resolve());
  const contextSelectionQueue = useRef(Promise.resolve());
  const settingsDraft = useRef<Settings | null>(null);
  const rootPane = panes[0] || {
    id: 'pane:root',
    tabs: ['new:0'],
    activeTab: 'new:0',
    weight: 1,
  };
  const models = useMemo(() => runtime?.codex.models || [], [runtime]);
  const selectedProject =
    state?.projects?.find((project) => project.id === state.selectedProjectId) || null;
  const applyKernelSnapshot = (value: any) => {
    if (value.protocolVersion !== undefined && value.protocolVersion !== KERNEL_PROTOCOL_VERSION) {
      setError(
        'The client and local kernel use different protocol versions. Reload Opnex to reconnect.'
      );
      return false;
    }
    const incomingId = typeof value.kernelInstanceId === 'string' ? value.kernelInstanceId : '';
    const incomingRevision = Number.isSafeInteger(value.cursor)
      ? value.cursor
      : Number.isSafeInteger(value.state?.revision)
        ? value.state.revision
        : undefined;
    const previous = kernelCursor.current;
    if (
      previous &&
      incomingId &&
      previous.instanceId === incomingId &&
      incomingRevision !== undefined &&
      incomingRevision < previous.revision
    )
      return false;
    if (incomingId && incomingRevision !== undefined)
      kernelCursor.current = {
        instanceId: incomingId,
        revision: incomingRevision,
      };
    setState(value.state);
    setRuntime(value.runtime);
    return true;
  };
  useEffect(() => {
    projectExpandedRef.current = state?.expandedProjectIds || [];
  }, [state?.expandedProjectIds]);
  // One app-wide font family; settings only switch the stack.
  useEffect(() => {
    document.documentElement.dataset.font = state?.settings.fontFamily === 'mono' ? 'mono' : 'sans';
  }, [state?.settings.fontFamily]);

  const taskForTab = (id: string): Task | null =>
    state?.tasks.find((task) => task.id === id) || null;
  const setTabError = (id: string, message: string) =>
    setTabErrors((current) => ({ ...current, [id]: message }));
  const clearTabError = (id: string) =>
    setTabErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  const tabInputRef = (id: string) => (paneInputRefs.current[id] ??= createRef());
  const headsUpTriggerRef = (id: string) =>
    (headsUpTriggerRefs.current[id] ??= createRef<HTMLButtonElement>());
  const setPaneTabs = (paneId: string, value: string[] | ((current: string[]) => string[])) =>
    setPanes((current) =>
      current.map((pane) =>
        pane.id === paneId
          ? {
              ...pane,
              tabs: typeof value === 'function' ? value(pane.tabs) : value,
            }
          : pane
      )
    );
  const setPaneActive = (paneId: string, tab: string) =>
    setPanes((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, activeTab: tab } : pane))
    );
  const refresh = async (): Promise<AppState | null> => {
    try {
      const value = await api('/api/v1/snapshot');
      applyKernelSnapshot(value);
      return value.state || null;
    } catch (cause) {
      setError(String(cause));
      return null;
    }
  };
  const queueContextSelection = (url: string, body: unknown) => {
    const operation = contextSelectionQueue.current.then(() => api(url, body));
    contextSelectionQueue.current = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };
  const selectSessionContext = (id: string) => {
    const task = state?.tasks.find((row) => row.id === id);
    const projectId = task?.projectId || null;
    setState((current) =>
      current
        ? {
            ...current,
            selectedProjectId: projectId,
            expandedProjectIds: projectId
              ? [...new Set([...(current.expandedProjectIds || []), projectId])]
              : [...new Set([...(current.expandedProjectIds || []), 'unclassified'])],
          }
        : current
    );
    return queueContextSelection('/api/tasks/' + id + '/select', {});
  };
  const openSettings = () => {
    setSettingsMounted(true);
    setSettingsOpen(true);
  };
  const openProjectEditor = (project: Project | 'new') => {
    setProjectEditor(project);
  };
  const projectSaved = async (project: Project, duplicate: boolean) => {
    const shouldSelect = projectEditor === 'new' || duplicate;
    setProjectEditor(null);
    if (shouldSelect) {
      setState((current) => (current ? { ...current, selectedProjectId: project.id } : current));
      await queueContextSelection('/api/projects/select', {
        projectId: project.id,
      });
      const active = panes.find((pane) => pane.id === focusedPaneId)?.activeTab;
      if (active && !active.startsWith('new:')) openNewTab();
    }
    await refresh();
  };
  const selectProject = async (id: string | null) => {
    setState((current) => (current ? { ...current, selectedProjectId: id } : current));
    try {
      await queueContextSelection('/api/projects/select', { projectId: id });
      const active = panes.find((pane) => pane.id === focusedPaneId)?.activeTab;
      if (active && !active.startsWith('new:')) openNewTab();
    } catch (cause) {
      setError(String(cause));
      await refresh();
    }
  };
  const openNewSessionInProject = (projectId: string) => {
    const activeTab = panes.find((pane) => pane.id === focusedPaneId)?.activeTab;
    void selectProject(projectId);
    if (activeTab?.startsWith('new:')) openNewTab();
  };
  const toggleProjectExpanded = (id: string) => {
    const current = projectExpandedRef.current;
    const expanded = !current.includes(id);
    const next = expanded ? [...current, id] : current.filter((value) => value !== id);
    projectExpandedRef.current = next;
    setState((value) => (value ? { ...value, expandedProjectIds: next } : value));
    projectExpansionQueue.current = projectExpansionQueue.current
      .then(() => api(`/api/projects/${id}/expanded`, { expanded }))
      .then(() => undefined)
      .catch((cause) => setError(String(cause)));
  };
  const moveSessionToProject = async (taskId: string, projectId: string | null) => {
    try {
      await api('/api/tasks/' + taskId + '/project', { projectId });
      setProjectMoveError('');
      await refresh();
    } catch (cause) {
      setProjectMoveError(String(cause));
    }
  };
  const setTaskPinned = async (task: Task, pinned: boolean) => {
    try {
      await api(`/api/tasks/${task.id}/pin`, { pinned });
      await refresh();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const setTaskArchived = async (task: Task, archived: boolean) => {
    try {
      await api(`/api/tasks/${task.id}/archive`, { archived });
      await refresh();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const dragSession = (event: React.DragEvent<HTMLDivElement>, task: Task) => {
    event.dataTransfer.setData('application/x-opnex-session-project', task.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  const dropSessionInto = (event: React.DragEvent<HTMLElement>, projectId: string | null) => {
    const id = event.dataTransfer.getData('application/x-opnex-session-project');
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    setProjectDropTarget(null);
    void moveSessionToProject(id, projectId);
  };
  const closeSettings = () => setSettingsOpen(false);
  const openSessionDialog = useCallback((kind: 'rename' | 'delete', taskId: string) => {
    setSessionDialog({ kind, taskId });
    setSessionDialogMounted(true);
    setSessionDialogOpen(true);
  }, []);
  const closeSessionDialog = () => setSessionDialogOpen(false);
  const makeTabArrival = (id: string) => {
    setSessionArrival(id);
    window.setTimeout(() => setSessionArrival((current) => (current === id ? '' : current)), 280);
  };
  const activateSessionTab = (id: string) => {
    const existing = panes.find((pane) => pane.tabs.includes(id));
    const target = existing || panes.find((pane) => pane.id === focusedPaneId) || rootPane;
    if (!existing)
      setPaneTabs(target.id, (current) => (current.includes(id) ? current : [...current, id]));
    setPaneActive(target.id, id);
    setFocusedPaneId(target.id);
    if (!id.startsWith('new:')) {
      void selectSessionContext(id).catch((cause) => setTabError(id, String(cause)));
    }
  };
  const openNewTabInPane = (requestedPaneId: string) => {
    const paneId = panes.some((pane) => pane.id === requestedPaneId)
      ? requestedPaneId
      : rootPane.id;
    const id = makeFallbackTab();
    setPaneTabs(paneId, (current) => [...current, id]);
    setPaneActive(paneId, id);
    setFocusedPaneId(paneId);
    clearTabError(id);
    makeTabArrival(id);
    window.setTimeout(() => paneInputRefs.current[id]?.current?.focus(), 0);
  };
  const openNewTab = () =>
    openNewTabInPane(panes.some((pane) => pane.id === focusedPaneId) ? focusedPaneId : rootPane.id);
  const openWorkspaceTab = (
    kind: Exclude<WorkspaceTabRecord['kind'], 'session'>,
    requestedPaneId: string,
    contextTabId: string | null,
    initialUrl?: string
  ) => {
    const paneId = panes.some((pane) => pane.id === requestedPaneId)
      ? requestedPaneId
      : rootPane.id;
    const currentWorkspace = contextTabId ? workspaceTabs[contextTabId] : undefined;
    const originTabId = currentWorkspace
      ? currentWorkspace.originTabId
      : contextTabId && workspaceTabKind(contextTabId) === 'session'
        ? contextTabId
        : null;
    const originTaskId = originTabId && !originTabId.startsWith('new:') ? originTabId : null;
    const originTask = originTaskId ? taskForTab(originTaskId) : null;
    const projectId =
      currentWorkspace?.projectId || originTask?.projectId || selectedProject?.id || '';
    const projectRoot =
      currentWorkspace?.projectRoot || originTask?.userRoot || selectedProject?.projectRoot || '';
    const id = createWorkspaceTabId(
      kind,
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
    );
    const record = createWorkspaceTabRecord(kind, id, {
      originTabId,
      projectId,
      projectRoot,
      ...(kind === 'browser' && initialUrl ? { initialUrl } : {}),
      ...(kind === 'git' && initialUrl ? { focusUrl: initialUrl } : {}),
    });
    setWorkspaceTabs((current) => registerWorkspaceTab(current, record));
    setPaneTabs(paneId, (current) => [...current, id]);
    setPaneActive(paneId, id);
    setFocusedPaneId(paneId);
    makeTabArrival(id);
    return id;
  };
  const openSkillsTab = (requestedPaneId = focusedPaneId) => {
    for (const pane of panes) {
      const existing = pane.tabs.find((tab) => workspaceTabKind(tab) === 'skills');
      if (existing) {
        setFocusedPaneId(pane.id);
        setPaneActive(pane.id, existing);
        return;
      }
    }
    const pane = panes.find((item) => item.id === requestedPaneId) || rootPane;
    openWorkspaceTab('skills', pane.id, pane.activeTab);
  };
  const updateWorkspaceOrigins = (oldTabId: string, taskId: string) => {
    setWorkspaceTabs((current) => {
      let changed = false;
      const next: Record<string, WorkspaceTabRecord> = { ...current };
      for (const [id, tab] of Object.entries(current)) {
        if (tab.originTabId !== oldTabId) continue;
        next[id] = { ...tab, originTabId: taskId, originTaskId: taskId };
        changed = true;
      }
      return changed ? next : current;
    });
  };
  const addBrowserAnnotation = (
    record: WorkspaceTabRecord,
    annotation: BrowserAnnotation,
    comment: string
  ) => {
    const target = record.originTabId;
    if (!target) {
      setError('This Browser tab has no originating session to receive an annotation.');
      return;
    }
    if (record.originTaskId && !taskForTab(record.originTaskId)) {
      setError(
        'The session that opened this Browser tab was deleted; the annotation was not redirected.'
      );
      return;
    }
    const block = formatBrowserAnnotation(annotation, comment);
    setDrafts((current) => {
      const previous = current[target] || '';
      return {
        ...current,
        [target]: previous.trim() + (previous.trim() ? '\n\n' : '') + block,
      };
    });
    setTabError(target, 'Browser annotation added to this session draft.');
    activateSessionTab(target);
  };
  const returnToOrigin = (record: WorkspaceTabRecord | undefined) => {
    if (!record?.originTabId) return;
    if (record.originTaskId && !taskForTab(record.originTaskId)) {
      setError('The originating session was deleted.');
      return;
    }
    activateSessionTab(record.originTabId);
  };
  const openTaskTab = (id: string) => activateSessionTab(id);
  const clearTabDrop = () => {
    tabDropTargetRef.current = null;
    setTabDropTarget(null);
  };
  const readDraggedTab = (dataTransfer: DataTransfer) =>
    dataTransfer.getData('application/x-opnex-workspace-tab') ||
    dataTransfer.getData('application/x-opnex-session-tab');
  const tabUnderPointer = (event: React.DragEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const fromTarget =
      target?.closest<HTMLElement>('[data-workspace-tab]') ||
      target?.closest<HTMLElement>('[data-session-tab]');
    const point = document.elementFromPoint?.(event.clientX, event.clientY) as HTMLElement | null;
    const fromPoint =
      point?.closest<HTMLElement>('[data-workspace-tab]') ||
      point?.closest<HTMLElement>('[data-session-tab]');
    const direct =
      fromTarget && event.currentTarget.contains(fromTarget)
        ? fromTarget
        : fromPoint && event.currentTarget.contains(fromPoint)
          ? fromPoint
          : null;
    if (direct) return direct.dataset.workspaceTab || direct.dataset.sessionTab || null;
    const candidates = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-workspace-tab], [data-session-tab]')
    );
    const nearest = candidates.reduce<HTMLElement | null>((best, item) => {
      if (!best) return item;
      const distance = Math.abs(
        item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 - event.clientX
      );
      const bestDistance = Math.abs(
        best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2 - event.clientX
      );
      return distance < bestDistance ? item : best;
    }, null);
    return nearest?.dataset.workspaceTab || nearest?.dataset.sessionTab || null;
  };
  const allowTabDrop = (event: React.DragEvent<HTMLElement>) => {
    const types = Array.from(event.dataTransfer.types);
    if (
      types.includes('application/x-opnex-workspace-tab') ||
      types.includes('application/x-opnex-session-tab')
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const target = tabUnderPointer(event);
      tabDropTargetRef.current = target;
      setTabDropTarget(target);
    }
  };
  const moveTab = (source: string, target: string) => {
    clearTabDrop();
    setDraggedTab(null);
    setDropTarget(null);
    const pane = panes.find((item) => item.tabs.includes(target));
    if (pane) setFocusedPaneId(pane.id);
    setPanes((current) => moveTabToTab(current, source, target));
  };
  const dropTabOnStrip = (event: React.DragEvent<HTMLElement>) => {
    const source = readDraggedTab(event.dataTransfer);
    const target = tabUnderPointer(event) || tabDropTargetRef.current;
    if (!source || !target) return;
    event.preventDefault();
    event.stopPropagation();
    moveTab(source, target);
  };
  const finishTabDrag = (source: string) => {
    tabDragSuppressUntil.current = { tab: source, until: Date.now() + 600 };
    const target = tabDropTargetRef.current;
    clearTabDrop();
    setDraggedTab(null);
    setDropTarget(null);
    if (target && target !== source) moveTab(source, target);
  };
  const splitTab = (source: string, targetPaneId: string, side: 'left' | 'right') => {
    clearTabDrop();
    setDraggedTab(null);
    setDropTarget(null);
    setPanes((current) => {
      const sourceIndex = current.findIndex((pane) => pane.tabs.includes(source));
      const target = current.find((pane) => pane.id === targetPaneId);
      if (sourceIndex < 0 || !target) return current;
      const rect = document.querySelector('.workspace-content')?.getBoundingClientRect();
      const total = current.reduce((sum, pane) => sum + pane.weight, 0);
      const targetWidth = rect ? (rect.width * target.weight) / total : 0;
      if (targetWidth < 336) return current;
      const next = [...current];
      const sourcePane = next[sourceIndex];
      const remaining = sourcePane.tabs.filter((tab) => tab !== source);
      if (remaining.length)
        next[sourceIndex] = {
          ...sourcePane,
          tabs: remaining,
          activeTab: remaining.includes(sourcePane.activeTab) ? sourcePane.activeTab : remaining[0],
        };
      else if (next.length === 1 || sourcePane.id === targetPaneId) {
        const fallback = makeFallbackTab();
        next[sourceIndex] = {
          ...sourcePane,
          tabs: [fallback],
          activeTab: fallback,
        };
      } else next.splice(sourceIndex, 1);
      return splitPane(next, source, targetPaneId, side, makePaneId(), true);
    });
    setFocusedPaneId(targetPaneId);
  };
  const dropPane = (event: React.DragEvent<HTMLElement>, paneId: string) => {
    const mode = event.dataTransfer.getData('application/x-opnex-workspace');
    if (mode) {
      const kind = workspaceKindForMode(mode);
      if (kind) {
        event.preventDefault();
        event.stopPropagation();
        const pane = panes.find((item) => item.id === paneId);
        openWorkspaceTab(kind, paneId, pane?.activeTab || null);
        return;
      }
    }
    const tab = readDraggedTab(event.dataTransfer);
    if (!tab) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    splitTab(
      tab,
      paneId,
      event.nativeEvent.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
    );
  };
  const closeTab = (id: string) => {
    if (closeTimers.current[id]) return;
    setClosingTabs((current) => ({ ...current, [id]: true }));
    closeTimers.current[id] = window.setTimeout(() => {
      delete closeTimers.current[id];
      const currentPanes = panesRef.current;
      const group = currentPanes.find((pane) => pane.tabs.includes(id));
      const wasActive = group?.activeTab === id;
      if (wasActive && group && focusedPaneIdRef.current === group.id) {
        const index = group.tabs.indexOf(id);
        const fallback = group.tabs[index > 0 ? index - 1 : 1];
        if (fallback && workspaceTabKind(fallback) === 'session' && !fallback.startsWith('new:')) {
          void selectSessionContext(fallback).catch((cause) =>
            setTabError(fallback, String(cause))
          );
        } else if (!fallback && currentPanes.length > 1) {
          const groupIndex = currentPanes.findIndex((pane) => pane.id === group.id);
          const neighbor = currentPanes[groupIndex === 0 ? 1 : Math.max(0, groupIndex - 1)];
          const neighborTab = neighbor?.activeTab;
          if (
            neighborTab &&
            workspaceTabKind(neighborTab) === 'session' &&
            !neighborTab.startsWith('new:')
          ) {
            void selectSessionContext(neighborTab).catch((cause) =>
              setTabError(neighborTab, String(cause))
            );
          }
        }
      }
      setPanes((current) => closePaneTab(current, id, makeFallbackTab));
      setWorkspaceTabs((current) => removeWorkspaceTab(current, id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPendingAttachments((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setQualityModes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setNewSessionTypes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setTabErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setHeadsUpOpen((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      delete paneInputRefs.current[id];
      delete headsUpTriggerRefs.current[id];
      setClosingTabs((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (wasActive && group && group.tabs.length === 1 && panes.length > 1) {
        const groupIndex = panes.findIndex((pane) => pane.id === group.id);
        const neighbor = panes[groupIndex === 0 ? 1 : Math.max(0, groupIndex - 1)];
        if (neighbor) setFocusedPaneId(neighbor.id);
      }
    }, 180);
  };
  const setFilesFor = async (tab: string, files: FileList | null) => {
    try {
      const added = await encodeAttachments(files, pendingAttachments[tab] || []);
      setPendingAttachments((current) => ({
        ...current,
        [tab]: [...(current[tab] || []), ...added],
      }));
      clearTabError(tab);
    } catch (cause) {
      setTabError(tab, String(cause));
    }
  };
  const removeFileFor = (tab: string, index: number) =>
    setPendingAttachments((current) => ({
      ...current,
      [tab]: (current[tab] || []).filter((_, item) => item !== index),
    }));
  const submitTab = async (tab: string) => {
    const submitted = prepareMarkdownSubmission(drafts[tab] || '');
    const files = pendingAttachments[tab] || [];
    const task = taskForTab(tab);
    const qaEnabled =
      qualityModes[tab] ??
      task?.passes?.find((pass) => pass.id === task.currentPassId)?.qualityLoop?.enabled ??
      false;
    if (sendingRef.current.has(tab) || (!files.length && submitted === null)) return;
    if (!task && (!selectedProject || selectedProject.needsLocation)) {
      setTabError(tab, 'Select a workspace with a working directory before starting a session.');
      return;
    }
    const message = submitted || '';
    sendingRef.current.add(tab);
    setSendingTabs((current) => ({ ...current, [tab]: true }));
    clearTabError(tab);
    setDrafts((current) => ({ ...current, [tab]: '' }));
    try {
      if (task?.phase === 'escalated')
        await api('/api/tasks/' + task.id + '/escalation', {
          message,
          attachments: files,
        });
      else if (task)
        await api('/api/tasks/' + task.id + '/messages', {
          message,
          attachments: files,
          qaEnabled,
          ...(recruitmentSteerTargets[task.id]
            ? { recruitmentWorkerId: recruitmentSteerTargets[task.id] }
            : {}),
        });
      else {
        await contextSelectionQueue.current;
        const created = await api('/api/tasks', {
          message,
          attachments: files,
          qaEnabled,
          projectId: selectedProject!.id,
        });
        if (created?.id) {
          setPanes((current) =>
            current.map((pane) =>
              pane.tabs.includes(tab)
                ? {
                    ...pane,
                    tabs: pane.tabs.map((item) => (item === tab ? created.id : item)),
                    activeTab: pane.activeTab === tab ? created.id : pane.activeTab,
                  }
                : pane
            )
          );
          updateWorkspaceOrigins(tab, created.id);
          setState((current) =>
            current
              ? {
                  ...current,
                  tasks: [created, ...current.tasks.filter((item) => item.id !== created.id)],
                }
              : current
          );
          makeTabArrival(created.id);
        }
      }
      setPendingAttachments((current) => {
        const next = { ...current };
        delete next[tab];
        return next;
      });
      if (task)
        setRecruitmentSteerTargets((current) => {
          if (!current[task.id]) return current;
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      setDrafts((current) => {
        const next = { ...current };
        delete next[tab];
        return next;
      });
      await refresh();
    } catch (cause) {
      setTabError(tab, String(cause));
      setDrafts((current) => ({ ...current, [tab]: message }));
    } finally {
      sendingRef.current.delete(tab);
      setSendingTabs((current) => {
        const next = { ...current };
        delete next[tab];
        return next;
      });
    }
  };
  const stopTask = async (taskId: string) => {
    try {
      await api('/api/tasks/' + taskId + '/cancel', {});
      await refresh();
    } catch (cause) {
      setTabError(taskId, String(cause));
    }
  };
  const qualityAction = async (taskId: string, action: 'accept' | 'pause' | 'resume') => {
    try {
      await api(`/api/tasks/${taskId}/qa/${action}`, {});
      await refresh();
    } catch (cause) {
      setTabError(taskId, String(cause));
    }
  };
  const approveTask = async (
    taskId: string,
    requestId: string | number,
    decision: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => {
    try {
      const task = state?.tasks.find((row) => row.id === taskId);
      if (task?.sessionType === 'forge' && task.forge) {
        const ticket = await respondForgeApproval(taskId, requestId, {
          decision,
          ...(content ? { content } : {}),
        });
        setState((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((row) =>
                  row.id === taskId ? { ...row, forge: ticket } : row
                ),
              }
            : current
        );
      } else {
        await api('/api/tasks/' + taskId + '/approval', {
          requestId,
          decision,
          ...(content ? { content } : {}),
        });
        await refresh();
      }
    } catch (cause) {
      setTabError(taskId, String(cause));
    }
  };
  const updateSettings = (patch: Partial<Settings>) => {
    if (!state) return Promise.resolve(false);
    const next = { ...(settingsDraft.current || state.settings), ...patch };
    settingsDraft.current = next;
    const operation = settingsQueue.current.then(async () => {
      try {
        await api('/api/settings', next);
        await refresh();
        return true;
      } catch (cause) {
        setError(String(cause));
        return false;
      } finally {
        if (settingsDraft.current === next) settingsDraft.current = null;
      }
    });
    settingsQueue.current = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };
  const saveMcpServers = (servers: Settings['mcpServers']) =>
    updateSettings({ mcpServers: servers });
  const updateOrchestratorProfile = (profile: ExecutionProfile) =>
    void updateSettings({
      orchestratorModel: profile.model,
      orchestratorEffort: profile.effort,
      orchestratorServiceTier: profile.serviceTier,
    });
  const renameSession = async (taskId: string, title: string) => {
    try {
      await api('/api/tasks/' + taskId + '/rename', { title });
      await refresh();
      closeSessionDialog();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const deleteSession = async (taskId: string) => {
    try {
      await api('/api/tasks/' + taskId + '/delete', {});
      setPanes((current) =>
        normalizePanes(
          current.map((pane) => {
            const next = pane.tabs.filter((tab) => tab !== taskId);
            return {
              ...pane,
              tabs: next,
              activeTab: next.includes(pane.activeTab) ? pane.activeTab : next[0] || pane.activeTab,
            };
          }),
          makeFallbackTab
        )
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      setPendingAttachments((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      setNewSessionTypes((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      setRecruitmentSteerTargets((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      setTabErrors((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      await refresh();
      closeSessionDialog();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const selectTask = (id: string) => openTaskTab(id);

  useEffect(() => {
    let alive = true;
    bootstrap()
      .then((value) => {
        if (!alive) return;
        applyKernelSnapshot(value);
        if (value.state.activeTaskId) {
          const id = value.state.activeTaskId;
          setPanes([{ id: 'pane:root', tabs: [id], activeTab: id, weight: 1 }]);
        }
        if (!value.state.projects.length) openProjectEditor('new');
        setLoading(false);
      })
      .catch((cause) => {
        if (alive) {
          setError(String(cause));
          setLoading(false);
        }
      });
    const source = new EventSource(`/api/v1/events?protocol=${KERNEL_PROTOCOL_VERSION}`);
    source.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.state && alive) applyKernelSnapshot(value);
      } catch {}
    };
    source.onerror = () => {
      if (alive) void refresh();
    };
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      alive = false;
      source.close();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (settingsOpen || !settingsMounted) return;
    const timer = window.setTimeout(() => setSettingsMounted(false), 110);
    return () => window.clearTimeout(timer);
  }, [settingsOpen, settingsMounted]);
  useEffect(() => {
    if (sessionDialogOpen || !sessionDialogMounted) return;
    const timer = window.setTimeout(() => {
      setSessionDialogMounted(false);
      setSessionDialog(null);
    }, 110);
    return () => window.clearTimeout(timer);
  }, [sessionDialogOpen, sessionDialogMounted]);
  useEffect(() => {
    for (const pane of panes) {
      for (const id of pane.tabs) {
        if (workspaceTabKind(id) !== 'session' || id.startsWith('new:')) continue;
        const task = taskForTab(id);
        const element = sessionScrollRefs.current[id];
        if (!task || !element) continue;
        const messages = task.messages.length + (task.passes?.length || 0);
        const reasoning =
          (task.reasoningSummaries || []).reduce((total, item) => total + item.text.length, 0) +
          (task.liveActivity || []).reduce(
            (total, item) => total + (item.text?.length || 0) + (item.output?.length || 0),
            0
          );
        const previous = scrollMemory.current[id];
        const selected = pane.activeTab === id;
        if (
          nearBottom.current[id] !== false &&
          (!previous ||
            (selected && (messages !== previous.messages || reasoning !== previous.reasoning)))
        ) {
          element.scrollTop = element.scrollHeight;
          nearBottom.current[id] = true;
        }
        scrollMemory.current[id] = { messages, reasoning };
      }
    }
    const openIds = new Set(panes.flatMap((pane) => pane.tabs));
    for (const id of Object.keys(scrollMemory.current)) {
      if (openIds.has(id)) continue;
      delete scrollMemory.current[id];
      delete nearBottom.current[id];
      delete sessionScrollRefs.current[id];
    }
  }, [panes, state?.tasks]);
  useEffect(() => {
    for (const pane of panes) {
      if (workspaceTabKind(pane.activeTab) !== 'session') continue;
      const task = taskForTab(pane.activeTab);
      const command = task?.workspaceCommand;
      if (!command) continue;
      const key = task.id + ':' + command.id;
      if (handledWorkspaceCommand.current.has(key)) continue;
      const kind = workspaceKindForMode(String(command.mode || ''));
      if (!kind) continue;
      handledWorkspaceCommand.current.add(key);
      const requestedUrl =
        typeof (command as { url?: unknown }).url === 'string'
          ? (command as { url: string }).url
          : undefined;
      openWorkspaceTab(kind, pane.id, pane.activeTab, requestedUrl);
    }
  }, [panes, state?.tasks]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
      if (event.key === 'Escape') {
        if (projectEditor) {
          event.preventDefault();
          setProjectEditor(null);
          return;
        }
        if (shortcutsOpen) {
          event.preventDefault();
          closeShortcuts();
          return;
        }
        if (settingsOpen) {
          event.preventDefault();
          closeSettings();
          return;
        }
        if (sessionDialogOpen) {
          event.preventDefault();
          closeSessionDialog();
          return;
        }
        return;
      }
      if (projectEditor || shortcutsOpen || settingsOpen || sessionDialogOpen) return;
      const isMac =
        desktopBridge?.platform === 'darwin' ||
        navigator.platform.toLocaleLowerCase().includes('mac');
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod || (isMac && event.ctrlKey) || (!isMac && event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const formControl = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const editable = !!target?.isContentEditable;
      const composerEditor = !!target?.closest('.cm-editor');
      if ((formControl || editable) && !composerEditor) return;
      if (
        composerEditor &&
        (key === 'b' || (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')))
      )
        return;
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        openNewTab();
        return;
      }
      if (key === ',' && !event.shiftKey) {
        event.preventDefault();
        openSettings();
        return;
      }
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
        return;
      }
      if (key === 'g' && event.shiftKey) {
        event.preventDefault();
        const pane = panes.find((item) => item.id === focusedPaneId) || rootPane;
        openWorkspaceTab('git', pane.id, pane.activeTab);
        return;
      }
      if (key === 'l' && event.shiftKey) {
        event.preventDefault();
        openSkillsTab();
        return;
      }
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.shiftKey) {
        const tasks = state?.tasks || [];
        if (!tasks.length) return;
        const active = panes.find((pane) => pane.id === focusedPaneId)?.activeTab || null;
        let navigation = recentSessionNavigation.current;
        const ids = tasks.map((task) => task.id);
        if (
          !navigation ||
          navigation.activeId !== active ||
          navigation.ids.length !== ids.length ||
          navigation.ids.some((id) => !ids.includes(id))
        ) {
          navigation = {
            ids: [...tasks]
              .sort(
                (a, b) =>
                  (Date.parse(b.lastInteractedAt || b.createdAt) || 0) -
                  (Date.parse(a.lastInteractedAt || a.createdAt) || 0)
              )
              .map((task) => task.id),
            activeId: active,
          };
        }
        const index = navigation.ids.indexOf(active || '');
        const next =
          index < 0
            ? event.key === 'ArrowDown'
              ? 0
              : navigation.ids.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + navigation.ids.length) %
              navigation.ids.length;
        const nextId = navigation.ids[next];
        if (!nextId) return;
        event.preventDefault();
        navigation.activeId = nextId;
        recentSessionNavigation.current = navigation;
        selectTask(nextId);
        return;
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [
    projectEditor,
    shortcutsOpen,
    settingsOpen,
    sessionDialogOpen,
    panes,
    focusedPaneId,
    state?.tasks,
  ]);

  if (loading)
    return (
      <div className='boot'>
        <img className='boot-brand' src='/opnex-icon-grid-1_5-margin.svg' alt='Opnex' />
        <span>Starting Opnex</span>
      </div>
    );
  const paneComposer = (tab: string, task: Task | null, paneId: string) => {
    const value = drafts[tab] || '';
    const files = pendingAttachments[tab] || [];
    const busy =
      !!task &&
      [
        'intake',
        'routing',
        'direct_running',
        'simple_running',
        'planning',
        'worker_running',
        'reviewing',
      ].includes(task.phase);
    const disabled =
      (!value.trim() && !files.length) ||
      !!sendingTabs[tab] ||
      !runtime ||
      (!task && (!selectedProject || selectedProject.needsLocation));
    const selectedOrchestrator: ExecutionProfile = {
      provider: 'codex',
      model: state?.settings.orchestratorModel || fallbackSettings.orchestratorModel,
      effort: (state?.settings.orchestratorEffort ||
        fallbackSettings.orchestratorEffort) as ExecutionProfile['effort'],
      ...(state?.settings.orchestratorServiceTier
        ? { serviceTier: state.settings.orchestratorServiceTier }
        : {}),
    };
    return (
      <Composer
        value={value}
        setValue={(next) => setDrafts((current) => ({ ...current, [tab]: next }))}
        submit={() => void submitTab(tab)}
        disabled={disabled}
        hint={
          task?.phase === 'escalated'
            ? 'A decision will be sent to this session’s orchestrator…'
            : !task && !selectedProject
              ? 'Choose or create a workspace before starting a session.'
              : !task && selectedProject?.needsLocation
                ? 'Choose a working directory for this workspace before starting a session.'
                : 'Ask a question or describe work for the router to classify.'
        }
        inputRef={tabInputRef(tab)}
        executionProfile={selectedOrchestrator}
        projectId={task?.projectId || selectedProject?.id}
        connectionState={runtime?.codex.state === 'connected' ? 'connected' : 'offline'}
        accessMode={
          state?.settings.accessMode ||
          accessModeFromApproval(state?.settings.approvalPolicy || 'on-request')
        }
        models={models}
        configDisabled={busy || !!sendingTabs[tab] || task?.phase === 'escalated'}
        onStop={task ? () => void stopTask(task.id) : undefined}
        onExecutionProfileChange={updateOrchestratorProfile}
        onAccessModeChange={(value) =>
          void updateSettings({
            accessMode: value,
            approvalPolicy: runtimeApprovalForAccess(value),
          })
        }
        qaEnabled={
          qualityModes[tab] ??
          task?.passes?.find((pass) => pass.id === task.currentPassId)?.qualityLoop?.enabled ??
          false
        }
        onQaChange={(enabled) => setQualityModes((current) => ({ ...current, [tab]: enabled }))}
        busy={busy}
        attachments={files}
        onFiles={(selected) => void setFilesFor(tab, selected)}
        onRemoveFile={(index) => removeFileFor(tab, index)}
        onOpenSkills={() => openSkillsTab(paneId)}
      />
    );
  };
  const renderNewSessionType = (tab: string) => {
    const selectedType = newSessionTypes[tab] || 'conversation';
    return (
      <div className='new-session-type' role='group' aria-label='New session type'>
        <button
          type='button'
          aria-pressed={selectedType === 'conversation'}
          onClick={() =>
            setNewSessionTypes((current) => ({
              ...current,
              [tab]: 'conversation',
            }))
          }
        >
          Conversation
        </button>
        <button
          type='button'
          aria-pressed={selectedType === 'forge'}
          onClick={() => setNewSessionTypes((current) => ({ ...current, [tab]: 'forge' }))}
        >
          Forge
        </button>
      </div>
    );
  };
  const renderNewTabActions = (pane: SessionPane, tab: string) => (
    <div className='new-tab-actions'>
      <button onClick={() => openNewTabInPane(pane.id)}>
        <MessageSquarePlus size={14} />
        SESSION
      </button>
      <button onClick={() => openWorkspaceTab('browser', pane.id, tab)}>
        <Globe size={14} />
        BROWSER
      </button>
      <button onClick={() => openWorkspaceTab('git', pane.id, tab)}>
        <GitBranch size={14} />
        GIT
      </button>
      <div className='new-tab-context'>
        <Folder size={12} />
        <span>
          {selectedProject
            ? workspaceOptionLabel(selectedProject, state?.projects || [])
            : 'Choose a workspace'}
        </span>
      </div>
    </div>
  );
  const openCreatedForgeSession = async (tab: string, ticket: ForgeTicket) => {
    const snapshot = await refresh();
    const created = snapshot?.tasks.find((row) => row.id === ticket.id);
    if (!created) {
      setTabError(
        tab,
        'The Forge draft was saved, but the session snapshot does not include it yet. Refresh the session to open its board.'
      );
      return;
    }
    setPanes((current) =>
      current.map((group) =>
        group.tabs.includes(tab)
          ? {
              ...group,
              tabs: group.tabs.map((item) => (item === tab ? created.id : item)),
              activeTab: group.activeTab === tab ? created.id : group.activeTab,
            }
          : group
      )
    );
    updateWorkspaceOrigins(tab, created.id);
    makeTabArrival(created.id);
    setNewSessionTypes((current) => ({ ...current, [created.id]: 'forge' }));
    try {
      await queueContextSelection('/api/tasks/' + created.id + '/select', {});
    } catch (cause) {
      setTabError(created.id, String(cause));
    }
  };
  const renderSessionPaneActions = (tab: string, task: Task | null) => {
    return (
      <div
        className='session-pane-actions'
        data-session-actions-for={tab}
        role='group'
        aria-label={(task?.title || 'New session') + ' controls'}
      >
        <button
          ref={headsUpTriggerRef(tab)}
          className='session-pane-action details-toggle heads-up-toggle'
          aria-label='Heads-up'
          title='Heads-up'
          aria-expanded={!!headsUpOpen[tab]}
          onClick={() => setHeadsUpOpen((current) => ({ ...current, [tab]: !current[tab] }))}
        >
          <PanelRight size={16} />
        </button>
      </div>
    );
  };
  const renderPaneTabs = (pane: SessionPane, index: number, split: boolean) => {
    const listLabel = split
      ? index === 1
        ? 'Side pane workspaces'
        : 'Pane ' + (index + 1) + ' workspaces'
      : 'Open workspaces';
    return (
      <div
        className={'document-tabs ' + (split ? 'split-pane-tabbar' : '')}
        role='tablist'
        aria-label={listLabel}
        style={split ? { gridColumn: index * 2 + 1, gridRow: 1 } : undefined}
        onDragOver={allowTabDrop}
        onDrop={dropTabOnStrip}
      >
        {pane.tabs.map((tab) => {
          const kind = workspaceTabKind(tab);
          const task = kind === 'session' ? taskForTab(tab) : null;
          const title = workspaceTabTitle(tab, task?.title);
          const selected = pane.activeTab === tab;
          const symbol =
            kind === 'browser' ? (
              <Globe size={13} />
            ) : kind === 'git' ? (
              <GitBranch size={13} />
            ) : kind === 'skills' ? (
              <BookOpen size={13} />
            ) : index === 0 && !split ? (
              <MessageSquarePlus size={13} />
            ) : null;
          const activate = () => {
            setPaneActive(pane.id, tab);
            setFocusedPaneId(pane.id);
            if (kind === 'session' && !tab.startsWith('new:'))
              void selectSessionContext(tab).catch((cause) => setTabError(tab, String(cause)));
          };
          const activateFromClick = (event: React.MouseEvent<HTMLElement>) => {
            if (
              (tabDragSuppressUntil.current?.tab === tab &&
                Date.now() < tabDragSuppressUntil.current.until) ||
              (event.target instanceof Element && event.target.closest('.tab-close'))
            ) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            activate();
          };
          return (
            <div
              className={
                'document-tab ' +
                (selected ? 'active ' : '') +
                (tabDropTarget === tab ? 'tab-drop-target ' : '') +
                (sessionArrival === tab ? 'session-arrived tab-arrived ' : '') +
                (closingTabs[tab] ? 'tab-closing' : '')
              }
              key={tab}
              data-workspace-tab={tab}
              data-session-tab={tab}
              draggable={!closingTabs[tab]}
              onClick={activateFromClick}
              onPointerDown={(event) => {
                if (event.button === 0 && tabDragSuppressUntil.current?.tab === tab)
                  tabDragSuppressUntil.current = null;
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(tab);
                }
              }}
              onDragStart={(event) => {
                if (event.target instanceof Element && event.target.closest('.tab-close')) {
                  event.preventDefault();
                  return;
                }
                tabDragSuppressUntil.current = { tab, until: Date.now() + 600 };
                clearTabDrop();
                setDraggedTab(tab);
                event.dataTransfer.setData('application/x-opnex-workspace-tab', tab);
                event.dataTransfer.setData('application/x-opnex-session-tab', tab);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => finishTabDrag(tab)}
              onPointerCancel={() => {
                clearTabDrop();
                setDraggedTab(null);
                setDropTarget(null);
                tabDragSuppressUntil.current = null;
              }}
              onDragOver={(event) => {
                if (
                  Array.from(event.dataTransfer.types).some(
                    (type) =>
                      type === 'application/x-opnex-workspace-tab' ||
                      type === 'application/x-opnex-session-tab'
                  )
                ) {
                  event.preventDefault();
                  tabDropTargetRef.current = tab;
                  setTabDropTarget(tab);
                }
              }}
              onDrop={(event) => {
                const source = readDraggedTab(event.dataTransfer);
                if (!source) return;
                event.preventDefault();
                event.stopPropagation();
                moveTab(source, tab);
              }}
            >
              <button
                role='tab'
                aria-label={title}
                aria-selected={selected}
                onClick={(event) => {
                  event.stopPropagation();
                  activateFromClick(event);
                }}
              >
                {symbol}
                <span>{title}</span>
              </button>
              <button
                className='tab-close'
                aria-label={'Close ' + title + ' tab'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab);
                }}
                disabled={!!closingTabs[tab]}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button
          className='new-tab'
          aria-label={
            split
              ? index === 1
                ? 'New session in side pane'
                : 'New session in pane ' + (index + 1)
              : 'Open new session tab'
          }
          onClick={() => openNewTabInPane(pane.id)}
        >
          <Plus size={15} />
        </button>
      </div>
    );
  };
  const renderWorkspaceTab = (tab: string, pane: SessionPane, index: number) => {
    const kind = workspaceTabKind(tab);
    const selected = pane.activeTab === tab;
    const task = kind === 'session' ? taskForTab(tab) : null;
    const record = workspaceTabs[tab];
    const contextTask = record?.originTaskId ? taskForTab(record.originTaskId) : null;
    const workspaceRoot = record?.originTaskId
      ? contextTask?.userRoot || record.projectRoot
      : record?.projectRoot || selectedProject?.projectRoot || '';
    const workspaceProjectId = record?.originTaskId
      ? contextTask?.projectId || record.projectId
      : record?.projectId || selectedProject?.id || '';
    const isSession = kind === 'session';
    const baseClass =
      (index > 0 ? 'session-pane side-session-view ' : 'task-view ') +
      'pane-body ' +
      (!task && isSession ? 'new-tab-view ' : '') +
      (sessionArrival === tab ? 'session-entering ' : '') +
      (selected ? 'workspace-tab-active ' : '') +
      (dropTarget?.paneId === pane.id ? 'drop-half-' + dropTarget.half : '');
    const row = panes.length > 1 ? 2 : 1;
    const column = index * 2 + 1;
    const onDragOver = (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      if (
        types.includes('application/x-opnex-workspace-tab') ||
        types.includes('application/x-opnex-session-tab')
      ) {
        event.preventDefault();
        clearTabDrop();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropTarget({
          paneId: pane.id,
          half: event.clientX < rect.left + rect.width / 2 ? 'left' : 'right',
        });
      }
    };
    if (kind === 'skills')
      return (
        <div
          key={tab}
          data-workspace-tab={tab}
          data-tab-kind='skills'
          className={baseClass + ' skill-library-tab'}
          style={{ gridColumn: column, gridRow: row }}
          hidden={!selected}
          aria-hidden={!selected}
          inert={!selected}
          onClick={() => setFocusedPaneId(pane.id)}
        >
          <Suspense
            fallback={
              <div className='skill-library-loading' role='status'>
                Loading library…
              </div>
            }
          >
            <SkillsLibraryPage
              active={selected}
              settings={state?.settings || fallbackSettings}
              saveMcpServers={saveMcpServers}
            />
          </Suspense>
        </div>
      );
    if (kind === 'browser' || kind === 'git') {
      return (
        <div
          key={tab}
          data-workspace-tab={tab}
          data-tab-kind={kind}
          className={
            baseClass +
            ' peer-workspace-pane ' +
            (kind === 'browser' ? 'browser-peer-tab' : 'git-peer-tab')
          }
          style={{ gridColumn: column, gridRow: row }}
          hidden={!selected}
          aria-hidden={!selected}
          inert={!selected}
          onClick={() => setFocusedPaneId(pane.id)}
          onDragOver={onDragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropTarget(null);
          }}
          onDrop={(event) => dropPane(event, pane.id)}
        >
          <EmbeddedWorkspace
            mode={kind === 'browser' ? 'browser' : 'github'}
            task={contextTask}
            placement='full'
            docked={false}
            workspaceId={tab}
            active={selected}
            sidebarCollapsed={sidebarCollapsed}
            sidebarWidth={sidebarWidth}
            initialUrl={record?.initialUrl || record?.focusUrl}
            projectRoot={workspaceRoot}
            projectId={workspaceProjectId}
            workspaces={state?.projects || []}
            onOpenBrowserTab={(url) => openWorkspaceTab('browser', pane.id, tab, url)}
            onSummary={() => returnToOrigin(record)}
            onAnnotation={(annotation, comment) =>
              record && addBrowserAnnotation(record, annotation, comment)
            }
          />
        </div>
      );
    }
    const taskView = task ? (
      <SessionConversation
        tab={tab}
        task={task}
        tabError={tabErrors[tab]}
        expandedSections={expanded}
        selectedSteerWorkerId={recruitmentSteerTargets[task.id]}
        setConversationElement={(element) => {
          sessionScrollRefs.current[tab] = element;
        }}
        onScroll={(scrollTab, element) => {
          nearBottom.current[scrollTab] =
            element.scrollHeight - element.scrollTop - element.clientHeight < 180;
        }}
        onDismissError={() => clearTabError(tab)}
        onApprovalDecision={(requestId, decision, content) =>
          void approveTask(task.id, requestId, decision, content)
        }
        onForgeTicketChange={(ticket) =>
          setState((current) =>
            current
              ? {
                  ...current,
                  tasks: current.tasks.map((row) =>
                    row.id === task.id ? { ...row, forge: ticket } : row
                  ),
                }
              : current
          )
        }
        onQualityAction={(action) => void qualityAction(task.id, action)}
        onSelectSteerWorker={(workerId) =>
          setRecruitmentSteerTargets((current) => ({
            ...current,
            [task.id]: workerId,
          }))
        }
        onToggleDisclosure={(passId, disclosure) =>
          setExpanded((current) => {
            const key = `${disclosure}:${passId}`;
            return { ...current, [key]: !current[key] };
          })
        }
      />
    ) : null;
    const newSessionView = !task ? (
      <div
        className={`new-tab-center ${newSessionTypes[tab] === 'forge' ? 'forge-new-tab-center' : ''}`}
      >
        {tabErrors[tab] && (
          <div className='tab-error' role='alert'>
            <AlertCircle size={15} />
            <span>{tabErrors[tab]}</span>
            <button
              className='icon-btn'
              aria-label='Dismiss session error'
              onClick={() => clearTabError(tab)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {renderNewSessionType(tab)}
        {newSessionTypes[tab] === 'forge' ? (
          <ForgeSessionCreate
            project={selectedProject}
            settings={state?.settings || fallbackSettings}
            models={models}
            onOpenSkills={() => openSkillsTab(pane.id)}
            onOpenWorkspace={() => openProjectEditor(selectedProject || 'new')}
            onCreated={(ticket) => void openCreatedForgeSession(tab, ticket)}
          />
        ) : (
          <div className='composer-dock'>{paneComposer(tab, null, pane.id)}</div>
        )}
        {renderNewTabActions(pane, tab)}
      </div>
    ) : null;
    return (
      <div
        key={tab}
        data-workspace-tab={tab}
        data-tab-kind='session'
        className={baseClass}
        style={{ gridColumn: column, gridRow: row }}
        hidden={!selected}
        aria-hidden={!selected}
        inert={!selected}
        onClick={() => setFocusedPaneId(pane.id)}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
        onDrop={(event) => dropPane(event, pane.id)}
      >
        {renderSessionPaneActions(tab, task)}
        {task?.sessionType === 'forge' ? (
          taskView
        ) : task ? (
          <>
            {taskView}
            <div className={'composer-dock ' + (index > 0 ? 'side-composer-dock' : '')}>
              {paneComposer(tab, task, pane.id)}
            </div>
          </>
        ) : (
          newSessionView
        )}
        <HeadsUpPanel
          task={task}
          project={
            task
              ? state?.projects.find((project) => project.id === task.projectId) || null
              : selectedProject
          }
          projects={state?.projects || []}
          settings={state?.settings || fallbackSettings}
          runtime={runtime}
          open={selected && !!headsUpOpen[tab]}
          onClose={() => setHeadsUpOpen((current) => ({ ...current, [tab]: false }))}
          onOpenSettings={openSettings}
          triggerRef={headsUpTriggerRef(tab)}
        />
      </div>
    );
  };

  return (
    <div
      className={
        'app-shell ' +
        (windowControls ? 'has-custom-chrome ' : '') +
        (sidebarCollapsed ? 'sidebar-collapsed ' : '') +
        (sidebarResizing ? 'sidebar-resizing' : '')
      }
      style={
        {
          '--sidebar-width': sidebarCollapsed ? '0px' : sidebarWidth + 'px',
        } as React.CSSProperties
      }
    >
      <nav className='activity-rail' aria-label='App navigation'>
        <button
          className='rail-toggle'
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title='Toggle sidebar (Ctrl/Cmd+B)'
          aria-keyshortcuts='Control+B Meta+B'
          aria-expanded={!sidebarCollapsed}
          aria-controls='primary-sidebar'
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          <PanelLeft size={17} />
        </button>
        <button
          role='tab'
          aria-label='Sessions'
          onClick={() => {
            const pane = panes.find((item) => item.id === focusedPaneId) || rootPane;
            if (workspaceTabKind(pane.activeTab) !== 'session')
              activateSessionTab(
                pane.tabs.find((tab) => workspaceTabKind(tab) === 'session') || 'new:0'
              );
          }}
        >
          <FileText size={17} />
        </button>
        <button
          role='tab'
          draggable
          aria-label='Browser'
          aria-current={
            panes.some((pane) => workspaceTabKind(pane.activeTab) === 'browser')
              ? 'page'
              : undefined
          }
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-opnex-workspace', 'browser');
            event.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => {
            const pane = panes.find((item) => item.id === focusedPaneId) || rootPane;
            openWorkspaceTab('browser', pane.id, pane.activeTab);
          }}
        >
          <Globe size={17} />
        </button>
        <button
          role='tab'
          draggable
          aria-label='Git'
          title='Git (Ctrl/Cmd+Shift+G)'
          aria-keyshortcuts='Control+Shift+G Meta+Shift+G'
          aria-current={
            panes.some((pane) => workspaceTabKind(pane.activeTab) === 'git') ? 'page' : undefined
          }
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-opnex-workspace', 'git');
            event.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => {
            const pane = panes.find((item) => item.id === focusedPaneId) || rootPane;
            openWorkspaceTab('git', pane.id, pane.activeTab);
          }}
        >
          <GitBranch size={17} />
        </button>
        <button
          role='tab'
          aria-label='Library'
          title='Library (Ctrl/Cmd+Shift+L)'
          aria-keyshortcuts='Control+Shift+L Meta+Shift+L'
          aria-current={
            panes.some((pane) => workspaceTabKind(pane.activeTab) === 'skills') ? 'page' : undefined
          }
          onClick={() => openSkillsTab()}
        >
          <BookOpen size={17} />
        </button>
        <div className='rail-spacer' />
        <button
          aria-label='Settings'
          title='Settings (Ctrl/Cmd+,)'
          aria-keyshortcuts='Control+, Meta+,'
          onClick={openSettings}
        >
          <Settings2 size={17} />
        </button>
      </nav>
      <SessionExplorer
        tasks={state?.tasks || []}
        projects={state?.projects || []}
        selectedProject={selectedProject}
        expandedProjectIds={state?.expandedProjectIds ?? ['unclassified']}
        activeTaskIds={panes.map((pane) => pane.activeTab)}
        sidebarCollapsed={sidebarCollapsed}
        query={query}
        setQuery={setQuery}
        showAllProjects={showAllProjects}
        setShowAllProjects={setShowAllProjects}
        projectMoveError={projectMoveError}
        onClearProjectMoveError={() => setProjectMoveError('')}
        projectDropTarget={projectDropTarget}
        setProjectDropTarget={setProjectDropTarget}
        archivedExpanded={archivedExpanded}
        setArchivedExpanded={setArchivedExpanded}
        onSelectTask={selectTask}
        onOpenSessionDialog={openSessionDialog}
        onPinTask={setTaskPinned}
        onArchiveTask={setTaskArchived}
        onMoveSessionToProject={moveSessionToProject}
        onDragSession={dragSession}
        onDropSessionInto={dropSessionInto}
        onToggleProjectExpanded={toggleProjectExpanded}
        onStartNewSessionInProject={openNewSessionInProject}
        onOpenNewTab={openNewTab}
        onOpenProjectEditor={openProjectEditor}
        onPinProject={async (projectId, pinned) => {
          try {
            await api(`/api/projects/${projectId}/pin`, { pinned });
            await refresh();
          } catch (cause) {
            setError(String(cause));
          }
        }}
        onOpenShortcuts={openShortcuts}
      />
      <div
        className='sidebar-resizer'
        role='separator'
        aria-label='Resize session explorer'
        aria-orientation='vertical'
        aria-valuemin={sidebarCollapsed ? 0 : 112}
        aria-valuemax={420}
        aria-valuenow={sidebarCollapsed ? 0 : sidebarWidth}
        aria-valuetext={sidebarCollapsed ? 'Collapsed' : `${sidebarWidth} pixels`}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setSidebarResizing(true);
          resizeRef.current = {
            kind: 'sidebar',
            x: event.clientX,
            width: sidebarCollapsed ? 0 : sidebarWidth,
            pointerId: event.pointerId,
          };
        }}
        onPointerMove={(event) => {
          const drag = resizeRef.current;
          if (!drag || drag.pointerId !== event.pointerId || drag.kind !== 'sidebar') return;
          const width = drag.width + event.clientX - drag.x;
          drag.x = event.clientX;
          drag.width = width;
          if (width < 112) setSidebarCollapsed(true);
          else {
            setSidebarCollapsed(false);
            setSidebarWidth(Math.max(112, Math.min(420, width)));
          }
        }}
        onPointerUp={(event) => {
          if (resizeRef.current?.pointerId === event.pointerId) {
            resizeRef.current = null;
            setSidebarResizing(false);
          }
        }}
        onPointerCancel={() => {
          resizeRef.current = null;
          setSidebarResizing(false);
        }}
        onLostPointerCapture={() => {
          resizeRef.current = null;
          setSidebarResizing(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const width = sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16);
          if (width < 112) setSidebarCollapsed(true);
          else {
            setSidebarCollapsed(false);
            setSidebarWidth(Math.min(420, width));
          }
        }}
      />
      <div className='workspace-area'>
        <main className='main-column'>
          <header className='topbar'>
            {panes.length === 1 && renderPaneTabs(rootPane, 0, false)}
            {windowControls && (
              <div className='window-controls' role='group' aria-label='Window controls'>
                <button
                  aria-label='Minimize window'
                  title='Minimize'
                  onClick={() => void windowControls.minimize()}
                >
                  <Minus size={14} />
                </button>
                <button
                  aria-label={windowMaximized ? 'Restore window' : 'Maximize window'}
                  title={windowMaximized ? 'Restore' : 'Maximize'}
                  onClick={() => void windowControls.toggleMaximize()}
                >
                  {windowMaximized ? <Copy size={12} /> : <Maximize2 size={12} />}
                </button>
                <button
                  className='window-close'
                  aria-label='Close window'
                  title='Close'
                  onClick={() => void windowControls.close()}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </header>
          <div
            className={
              'workspace-content mode-tasks ' +
              (panes.length > 1 ? 'has-session-panes has-side-session ' : '') +
              (draggedTab ? 'dragging-session' : '')
            }
            style={{
              gridTemplateColumns: panes
                .flatMap((pane, index) =>
                  index < panes.length - 1
                    ? ['minmax(0,' + pane.weight + 'fr)', '5px']
                    : ['minmax(0,' + pane.weight + 'fr)']
                )
                .join(' '),
              transition: 'grid-template-columns 180ms cubic-bezier(.2,.75,.25,1)',
            }}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes('application/x-opnex-workspace'))
                event.preventDefault();
            }}
            onDrop={(event) => {
              const mode = event.dataTransfer.getData('application/x-opnex-workspace');
              const kind = workspaceKindForMode(mode);
              if (kind) {
                event.preventDefault();
                const pane = panes.find((item) => item.id === focusedPaneId) || rootPane;
                openWorkspaceTab(kind, pane.id, pane.activeTab);
                return;
              }
              const tab = readDraggedTab(event.dataTransfer);
              if (!tab) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              splitTab(
                tab,
                panes[0].id,
                event.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
              );
            }}
          >
            {panes.map((pane, index) => (
              <div className='pane-grid-group' key={pane.id}>
                {panes.length > 1 && renderPaneTabs(pane, index, true)}
                {index > 0 && (
                  <div
                    className='workspace-resizer'
                    role='separator'
                    aria-label={'Resize pane ' + index}
                    aria-orientation='vertical'
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(
                      (pane.weight / (pane.weight + panes[index - 1].weight)) * 100
                    )}
                    aria-valuetext={`${Math.round((pane.weight / (pane.weight + panes[index - 1].weight)) * 100)}% of the adjacent pane pair`}
                    tabIndex={0}
                    style={{ gridColumn: index * 2, gridRow: '1 / -1' }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      resizeRef.current = {
                        kind: 'pane',
                        x: event.clientX,
                        left: panes[index - 1].id,
                        right: pane.id,
                        pointerId: event.pointerId,
                      };
                    }}
                    onPointerMove={(event) => {
                      const drag = resizeRef.current;
                      if (!drag || drag.pointerId !== event.pointerId || drag.kind !== 'pane')
                        return;
                      const delta = event.clientX - drag.x;
                      drag.x = event.clientX;
                      const rect = document
                        .querySelector('.workspace-content')
                        ?.getBoundingClientRect();
                      if (rect && drag.left && drag.right)
                        setPanes(
                          (current) =>
                            resizeAdjacentPanes(
                              current,
                              drag.left,
                              drag.right,
                              delta,
                              rect.width,
                              168
                            ).panes
                        );
                    }}
                    onPointerUp={(event) => {
                      if (resizeRef.current?.pointerId === event.pointerId)
                        resizeRef.current = null;
                    }}
                    onLostPointerCapture={() => {
                      resizeRef.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const rect = document
                        .querySelector('.workspace-content')
                        ?.getBoundingClientRect();
                      if (rect)
                        setPanes(
                          (current) =>
                            resizeAdjacentPanes(
                              current,
                              panes[index - 1].id,
                              pane.id,
                              (event.key === 'ArrowRight' ? 1 : -1) * 24,
                              rect.width,
                              168
                            ).panes
                        );
                    }}
                  />
                )}
                {pane.tabs.map((tab) => renderWorkspaceTab(tab, pane, index))}
              </div>
            ))}
          </div>
        </main>
      </div>
      {error && (
        <div className='toast-error' role='alert'>
          <AlertCircle size={15} />
          {error}
          <button className='icon-btn' aria-label='Dismiss app error' onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {projectEditor && (
        <ProjectEditorDialog
          project={projectEditor}
          initialRoot={selectedProject?.projectRoot || ''}
          close={() => setProjectEditor(null)}
          saved={(project, duplicate) => void projectSaved(project, duplicate)}
        />
      )}
      {shortcutsOpen && (
        <div
          className='dialog-backdrop'
          data-open='true'
          role='presentation'
          onMouseDown={(event) => event.target === event.currentTarget && closeShortcuts()}
        >
          <section
            className='shortcuts-dialog'
            role='dialog'
            aria-modal='true'
            aria-labelledby='shortcuts-title'
            onKeyDown={trapShortcutsTab}
          >
            <header>
              <div>
                <h2 id='shortcuts-title'>Keyboard shortcuts</h2>
                <p>Use Ctrl on Windows/Linux or Command on macOS.</p>
              </div>
              <button
                ref={shortcutsCloseRef}
                type='button'
                className='icon-btn'
                aria-label='Close shortcuts'
                onClick={closeShortcuts}
              >
                <X size={16} />
              </button>
            </header>
            <dl>
              <dt>New session</dt>
              <dd>Ctrl/⌘ + N</dd>
              <dt>Previous / next session</dt>
              <dd>Ctrl/⌘ + Shift + ↑ / ↓</dd>
              <dt>Settings</dt>
              <dd>Ctrl/⌘ + ,</dd>
              <dt>Git</dt>
              <dd>Ctrl/⌘ + Shift + G</dd>
              <dt>Library</dt>
              <dd>Ctrl/⌘ + Shift + L</dd>
              <dt>Toggle sidebar</dt>
              <dd>Ctrl/⌘ + B</dd>
              <dt>Dismiss dialog</dt>
              <dd>Escape</dd>
            </dl>
          </section>
        </div>
      )}
      {settingsMounted && state && (
        <SettingsDialog
          open={settingsOpen}
          settings={state.settings}
          models={models}
          runtime={runtime}
          close={closeSettings}
          reconnect={async () => {
            await refresh();
          }}
          saved={async (settings) => {
            try {
              await api('/api/settings', settings);
              await refresh();
              return true;
            } catch (cause) {
              setError(String(cause));
              return false;
            }
          }}
        />
      )}
      {sessionDialogMounted && sessionDialog && (
        <SessionDialog
          open={sessionDialogOpen}
          kind={sessionDialog.kind}
          task={state?.tasks.find((task) => task.id === sessionDialog.taskId)}
          close={closeSessionDialog}
          rename={renameSession}
          remove={deleteSession}
        />
      )}
    </div>
  );
}
