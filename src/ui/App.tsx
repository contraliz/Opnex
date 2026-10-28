import { createRef, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, BookOpen, Check, ChevronDown, ChevronRight, Command, Copy, Database, FileText, Folder, FolderPlus, GitBranch, Globe, Keyboard, Maximize2, MessageSquarePlus, Minus, PanelLeft, PanelRight, Pin, Plus, Search, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import { api, bootstrap, KERNEL_PROTOCOL_VERSION } from './api';
import { Markdown } from './Markdown';
import Composer from './Composer';
import { prepareMarkdownSubmission } from './LiveMarkdownEditor';
import SettingsDialog from './SettingsDialog';
import { SessionDialog, SessionRow } from './SessionControls';
import { HeadsUpPanel } from './HeadsUpPanel';
import { PassGitDiff } from './PassGitDiff';
import { RecruitmentTeamPanel } from './RecruitmentTeamPanel';
import { EmbeddedWorkspace } from './EmbeddedWorkspace';
import { closePaneTab, moveTabToTab, normalizePanes, resizeAdjacentPanes, splitPane, type SessionPane } from './paneGroups';
import { formatBrowserAnnotation } from './browser-annotation';
import { createWorkspaceTabId, createWorkspaceTabRecord, registerWorkspaceTab, removeWorkspaceTab, workspaceKindForMode, workspaceTabKind, workspaceTabTitle, type WorkspaceTabRecord, type WorkspaceTabRegistry } from './workspaceTabs';
import type { AppState, Assignment, BrowserAnnotation, DeepSeekExecutionProfile, LiveActivity, Project, Runtime, Settings, Task, TaskPass, Message, TaskAttachment } from '../types';
const SkillsLibraryPage=lazy(()=>import('./SkillsLibraryDialog').then(module=>({default:module.SkillsLibraryPage})));

const phaseText:Record<string,string>={intake:'Ready',routing:'Routing request',direct_running:'Answering directly',simple_running:'Simple implementation running',planning:'Planning hard task',worker_running:'Worker running · orchestrator idle',escalated:'Decision needed',reviewing:'Reviewing receipt',accepted:'Accepted',needs_attention:'Needs attention',cancelled:'Cancelled',paused_after_restart:'Paused after restart'};
const fallbackSettings:Settings={projectRoot:'',agentmemProjectId:'',orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low',approvalPolicy:'on-request'};
const stamp=(s:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(s));
const auditStamp=(s:string)=>new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(s));
const rootLabel=(root?:string)=>root?.split(/[\\/]/).filter(Boolean).at(-1)||'Choose project root';
const makePaneId=()=>`pane:${Date.now()}:${Math.random().toString(36).slice(2,7)}`;
const makeFallbackTab=()=>`new:${Date.now()}:${Math.random().toString(36).slice(2,6)}`;
async function encodeAttachments(files:FileList|null,existing:TaskAttachment[]):Promise<TaskAttachment[]>{
  if(!files?.length)return [];
  const selected=Array.from(files);
  if(existing.length+selected.length>5)throw new Error('Choose no more than five files.');
  const allowed=new Set(['image/png','image/jpeg','image/webp','text/plain','text/markdown','text/csv','application/json']);
  let total=existing.reduce((sum,file)=>sum+file.size,0);
  for(const file of selected){if(file.size>5*1024*1024)throw new Error(`${file.name} is over the 5 MiB per-file limit.`);if(!allowed.has(file.type))throw new Error(`Unsupported attachment format: ${file.name}.`);total+=file.size;}
  if(total>12*1024*1024)throw new Error('Attachments exceed the 12 MiB total limit.');
  return Promise.all(selected.map(async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return{name:file.name,type:file.type,size:file.size,data:btoa(binary)};}));
}
export default function App() {
  const windowControls = window.pseudoharnessDesktop?.windowControls;
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [state, setState] = useState<AppState | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, TaskAttachment[]>>({});
  const [recruitmentSteerTargets, setRecruitmentSteerTargets] = useState<Record<string,string>>({});
  const [panes, setPanes] = useState<SessionPane[]>([{ id: 'pane:root', tabs: ['new:0'], activeTab: 'new:0', weight: 1 }]);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTabRegistry>({});
  const [focusedPaneId, setFocusedPaneId] = useState('pane:root');
  const [tabErrors, setTabErrors] = useState<Record<string, string>>({});
  const [headsUpOpen, setHeadsUpOpen] = useState<Record<string, boolean>>({});
  const [sendingTabs, setSendingTabs] = useState<Record<string, boolean>>({});
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ paneId: string; half: 'left' | 'right' } | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);
  const [sessionArrival, setSessionArrival] = useState('');
  const [closingTabs, setClosingTabs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => windowControls?.onState(setWindowMaximized), [windowControls]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<{ kind: 'rename' | 'delete'; taskId: string } | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionDialogMounted, setSessionDialogMounted] = useState(false);
  const [projectEditor, setProjectEditor] = useState<Project | 'new' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectRootDraft, setProjectRootDraft] = useState('');
  const [projectAgentMemId, setProjectAgentMemId] = useState('');
  const [projectAgentMemEnabled, setProjectAgentMemEnabled] = useState(false);
  const [projectAgentMemAuto, setProjectAgentMemAuto] = useState(false);
  const [projectPinned, setProjectPinned] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [showAllProjects, setShowAllProjects] = useState<Record<string, boolean>>({});
  const [projectMoveError, setProjectMoveError] = useState('');
  const [projectDropTarget, setProjectDropTarget] = useState<string|null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(296);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>window.dispatchEvent(new Event('pseudoharness:shell-layout')));
    return()=>cancelAnimationFrame(frame);
  },[sidebarCollapsed,sidebarWidth]);
  const [retryingPassId, setRetryingPassId] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
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
  const projectSelectorRef = useRef<HTMLSelectElement>(null);
  const kernelCursor = useRef<{instanceId:string;revision:number}|null>(null);
  const recentSessionNavigation = useRef<{ids:string[];activeId:string|null}|null>(null);
  const tabDragSuppressUntil = useRef<{tab:string;until:number}|null>(null);
  const closeTimers = useRef<Record<string, number>>({});
  const settingsQueue = useRef(Promise.resolve());
  const contextSelectionQueue = useRef(Promise.resolve());
  const settingsDraft = useRef<Settings | null>(null);
  const rootPane = panes[0] || { id: 'pane:root', tabs: ['new:0'], activeTab: 'new:0', weight: 1 };
  const models = useMemo(() => runtime?.codex.models || [], [runtime]);
  const selectedProject = state?.projects?.find(project => project.id === state.selectedProjectId) || null;
  const applyKernelSnapshot=(value:any)=>{
    if(value.protocolVersion!==undefined&&value.protocolVersion!==KERNEL_PROTOCOL_VERSION){setError('The client and local kernel use different protocol versions. Reload Pseudoharness to reconnect.');return false;}
    const incomingId=typeof value.kernelInstanceId==='string'?value.kernelInstanceId:'';
    const incomingRevision=Number.isSafeInteger(value.cursor)?value.cursor:Number.isSafeInteger(value.state?.revision)?value.state.revision:undefined;
    const previous=kernelCursor.current;
    if(previous&&incomingId&&previous.instanceId===incomingId&&incomingRevision!==undefined&&incomingRevision<previous.revision)return false;
    if(incomingId&&incomingRevision!==undefined)kernelCursor.current={instanceId:incomingId,revision:incomingRevision};
    setState(value.state);setRuntime(value.runtime);return true;
  };
  useEffect(()=>{projectExpandedRef.current=state?.expandedProjectIds||[];},[state?.expandedProjectIds]);

  const taskForTab = (id: string): Task | null => state?.tasks.find(task => task.id === id) || null;
  const setTabError = (id: string, message: string) => setTabErrors(current => ({ ...current, [id]: message }));
  const clearTabError = (id: string) => setTabErrors(current => {
    if (!(id in current)) return current;
    const next = { ...current };
    delete next[id];
    return next;
  });
  const tabInputRef = (id: string) => paneInputRefs.current[id] ??= createRef();
  const headsUpTriggerRef = (id: string) => headsUpTriggerRefs.current[id] ??= createRef<HTMLButtonElement>();
  const setPaneTabs = (paneId: string, value: string[] | ((current: string[]) => string[])) => setPanes(current => current.map(pane => pane.id === paneId ? { ...pane, tabs: typeof value === 'function' ? value(pane.tabs) : value } : pane));
  const setPaneActive = (paneId: string, tab: string) => setPanes(current => current.map(pane => pane.id === paneId ? { ...pane, activeTab: tab } : pane));
  const refresh = async () => {
    try {
      const value = await api('/api/v1/snapshot');
      applyKernelSnapshot(value);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const queueContextSelection=(url:string,body:unknown)=>{const operation=contextSelectionQueue.current.then(()=>api(url,body));contextSelectionQueue.current=operation.then(()=>undefined,()=>undefined);return operation;};
  const selectSessionContext=(id:string)=>{const task=state?.tasks.find(row=>row.id===id);const projectId=task?.projectId||null;setState(current=>current?{...current,selectedProjectId:projectId,expandedProjectIds:projectId?[...new Set([...(current.expandedProjectIds||[]),projectId])]:[...new Set([...(current.expandedProjectIds||[]),'unclassified'])]}:current);return queueContextSelection('/api/tasks/'+id+'/select',{});};
  const openSettings = () => {
    setSettingsMounted(true);
    setSettingsOpen(true);
  };
  const openProjectEditor = (project:Project|'new') => {
    setProjectEditor(project);setProjectName(project==='new'?'':project.name);setProjectRootDraft(project==='new'?(selectedProject?.projectRoot||state?.settings.projectRoot||''):project.projectRoot);setProjectAgentMemId(project==='new'?'':project.agentmemProjectId);setProjectAgentMemEnabled(project==='new'?false:project.agentmemEnabled);setProjectAgentMemAuto(project==='new'?false:project.agentmemAutoSetup);setProjectPinned(project==='new'?false:project.pinned);setProjectError('');
  };
  const saveProject = async(event:React.FormEvent) => {
    event.preventDefault();if(!projectEditor||projectSaving)return;setProjectSaving(true);setProjectError('');
    const id=projectEditor==='new'?crypto.randomUUID():projectEditor.id;
    try{await api('/api/projects',{id,name:projectName,projectRoot:projectRootDraft,agentmemProjectId:projectAgentMemId,agentmemEnabled:projectAgentMemEnabled,agentmemAutoSetup:projectAgentMemAuto,pinned:projectPinned});if(projectEditor==='new'){await queueContextSelection('/api/projects/select',{projectId:id});const active=panes.find(pane=>pane.id===focusedPaneId)?.activeTab;if(active&&!active.startsWith('new:'))openNewTab();}await refresh();setProjectEditor(null);}catch(cause){setProjectError(String(cause));}finally{setProjectSaving(false);}
  };
  const selectProject = async(id:string|null) => {setState(current=>current?{...current,selectedProjectId:id}:current);try{await queueContextSelection('/api/projects/select',{projectId:id});const active=panes.find(pane=>pane.id===focusedPaneId)?.activeTab;if(active&&!active.startsWith('new:'))openNewTab();}catch(cause){setError(String(cause));await refresh();}};
  const toggleProjectExpanded = (id:string) => {const current=projectExpandedRef.current;const expanded=!current.includes(id);const next=expanded?[...current,id]:current.filter(value=>value!==id);projectExpandedRef.current=next;setState(value=>value?{...value,expandedProjectIds:next}:value);projectExpansionQueue.current=projectExpansionQueue.current.then(()=>api(`/api/projects/${id}/expanded`,{expanded})).then(()=>undefined).catch(cause=>setError(String(cause)));};
  const moveSessionToProject = async(taskId:string,projectId:string|null)=>{try{await api('/api/tasks/'+taskId+'/project',{projectId});setProjectMoveError('');await refresh();}catch(cause){setProjectMoveError(String(cause));}};
  const dragSession = (event:React.DragEvent<HTMLDivElement>,task:Task)=>{event.dataTransfer.setData('application/x-pseudoharness-session-project',task.id);event.dataTransfer.effectAllowed='move';};
  const dropSessionInto = (event:React.DragEvent<HTMLElement>,projectId:string|null)=>{const id=event.dataTransfer.getData('application/x-pseudoharness-session-project');if(!id)return;event.preventDefault();event.stopPropagation();setProjectDropTarget(null);void moveSessionToProject(id,projectId);};
  const closeSettings = () => setSettingsOpen(false);
  const openSessionDialog = useCallback((kind: 'rename' | 'delete', taskId: string) => {
    setSessionDialog({ kind, taskId });
    setSessionDialogMounted(true);
    setSessionDialogOpen(true);
  }, []);
  const closeSessionDialog = () => setSessionDialogOpen(false);
  const makeTabArrival = (id: string) => {
    setSessionArrival(id);
    window.setTimeout(() => setSessionArrival(current => current === id ? '' : current), 280);
  };
  const activateSessionTab = (id: string) => {
    const existing = panes.find(pane => pane.tabs.includes(id));
    const target = existing || panes.find(pane => pane.id === focusedPaneId) || rootPane;
    if (!existing) setPaneTabs(target.id, current => current.includes(id) ? current : [...current, id]);
    setPaneActive(target.id, id);
    setFocusedPaneId(target.id);
    if (!id.startsWith('new:')) {
      void selectSessionContext(id).catch(cause => setTabError(id, String(cause)));
    }
  };
  const openNewTabInPane = (requestedPaneId: string) => {
    const paneId = panes.some(pane => pane.id === requestedPaneId) ? requestedPaneId : rootPane.id;
    const id = makeFallbackTab();
    setPaneTabs(paneId, current => [...current, id]);
    setPaneActive(paneId, id);
    setFocusedPaneId(paneId);
    clearTabError(id);
    makeTabArrival(id);
    window.setTimeout(() => paneInputRefs.current[id]?.current?.focus(), 0);
  };
  const openNewTab = () => openNewTabInPane(panes.some(pane => pane.id === focusedPaneId) ? focusedPaneId : rootPane.id);
  const openWorkspaceTab = (
    kind: Exclude<WorkspaceTabRecord['kind'], 'session'>,
    requestedPaneId: string,
    contextTabId: string | null,
    initialUrl?: string,
  ) => {
    const paneId = panes.some(pane => pane.id === requestedPaneId) ? requestedPaneId : rootPane.id;
    const currentWorkspace = contextTabId ? workspaceTabs[contextTabId] : undefined;
    const originTabId = currentWorkspace
      ? currentWorkspace.originTabId
      : contextTabId && workspaceTabKind(contextTabId) === 'session' ? contextTabId : null;
    const originTaskId = originTabId && !originTabId.startsWith('new:') ? originTabId : null;
    const originTask = originTaskId ? taskForTab(originTaskId) : null;
    const projectRoot = currentWorkspace?.projectRoot || originTask?.userRoot || selectedProject?.projectRoot || state?.settings.projectRoot || '';
    const id = createWorkspaceTabId(kind, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9));
    const record = createWorkspaceTabRecord(kind, id, {
      originTabId,
      projectRoot,
      ...(kind === 'browser' && initialUrl ? { initialUrl } : {}),
      ...(kind === 'git' && initialUrl ? { focusUrl: initialUrl } : {}),
    });
    setWorkspaceTabs(current => registerWorkspaceTab(current, record));
    setPaneTabs(paneId, current => [...current, id]);
    setPaneActive(paneId, id);
    setFocusedPaneId(paneId);
    makeTabArrival(id);
    return id;
  };
  const openSkillsTab=(requestedPaneId=focusedPaneId)=>{
    for(const pane of panes){const existing=pane.tabs.find(tab=>workspaceTabKind(tab)==='skills');if(existing){setFocusedPaneId(pane.id);setPaneActive(pane.id,existing);return;}}
    const pane=panes.find(item=>item.id===requestedPaneId)||rootPane;
    openWorkspaceTab('skills',pane.id,pane.activeTab);
  };
  const updateWorkspaceOrigins = (oldTabId: string, taskId: string) => {
    setWorkspaceTabs(current => {
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
  const addBrowserAnnotation = (record: WorkspaceTabRecord, annotation: BrowserAnnotation, comment: string) => {
    const target = record.originTabId;
    if (!target) {
      setError('This Browser tab has no originating session to receive an annotation.');
      return;
    }
    if (record.originTaskId && !taskForTab(record.originTaskId)) {
      setError('The session that opened this Browser tab was deleted; the annotation was not redirected.');
      return;
    }
    const block = formatBrowserAnnotation(annotation, comment);
    setDrafts(current => {
      const previous = current[target] || '';
      return { ...current, [target]: previous.trim() + (previous.trim() ? '\n\n' : '') + block };
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
  const readDraggedTab = (dataTransfer: DataTransfer) => dataTransfer.getData('application/x-pseudoharness-workspace-tab') || dataTransfer.getData('application/x-pseudoharness-session-tab');
  const tabUnderPointer = (event: React.DragEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const fromTarget = target?.closest<HTMLElement>('[data-workspace-tab]') || target?.closest<HTMLElement>('[data-session-tab]');
    const point = document.elementFromPoint?.(event.clientX, event.clientY) as HTMLElement | null;
    const fromPoint = point?.closest<HTMLElement>('[data-workspace-tab]') || point?.closest<HTMLElement>('[data-session-tab]');
    const direct = fromTarget && event.currentTarget.contains(fromTarget) ? fromTarget : fromPoint && event.currentTarget.contains(fromPoint) ? fromPoint : null;
    if (direct) return direct.dataset.workspaceTab || direct.dataset.sessionTab || null;
    const candidates = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-workspace-tab], [data-session-tab]'));
    const nearest = candidates.reduce<HTMLElement | null>((best, item) => {
      if (!best) return item;
      const distance = Math.abs(item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 - event.clientX);
      const bestDistance = Math.abs(best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2 - event.clientX);
      return distance < bestDistance ? item : best;
    }, null);
    return nearest?.dataset.workspaceTab || nearest?.dataset.sessionTab || null;
  };
  const allowTabDrop = (event: React.DragEvent<HTMLElement>) => {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes('application/x-pseudoharness-workspace-tab') || types.includes('application/x-pseudoharness-session-tab')) {
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
    const pane = panes.find(item => item.tabs.includes(target));
    if (pane) setFocusedPaneId(pane.id);
    setPanes(current => moveTabToTab(current, source, target));
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
    tabDragSuppressUntil.current={tab:source,until:Date.now()+600};
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
    setPanes(current => {
      const sourceIndex = current.findIndex(pane => pane.tabs.includes(source));
      const target = current.find(pane => pane.id === targetPaneId);
      if (sourceIndex < 0 || !target) return current;
      const rect = document.querySelector('.workspace-content')?.getBoundingClientRect();
      const total = current.reduce((sum, pane) => sum + pane.weight, 0);
      const targetWidth = rect ? rect.width * target.weight / total : 0;
      if (targetWidth < 336) return current;
      const next = [...current];
      const sourcePane = next[sourceIndex];
      const remaining = sourcePane.tabs.filter(tab => tab !== source);
      if (remaining.length) next[sourceIndex] = { ...sourcePane, tabs: remaining, activeTab: remaining.includes(sourcePane.activeTab) ? sourcePane.activeTab : remaining[0] };
      else if (next.length === 1 || sourcePane.id === targetPaneId) {
        const fallback = makeFallbackTab();
        next[sourceIndex] = { ...sourcePane, tabs: [fallback], activeTab: fallback };
      } else next.splice(sourceIndex, 1);
      return splitPane(next, source, targetPaneId, side, makePaneId(), true);
    });
    setFocusedPaneId(targetPaneId);
  };
  const dropPane = (event: React.DragEvent<HTMLElement>, paneId: string) => {
    const mode = event.dataTransfer.getData('application/x-pseudoharness-workspace');
    if (mode) {
      const kind = workspaceKindForMode(mode);
      if (kind) {
        event.preventDefault();
        event.stopPropagation();
        const pane = panes.find(item => item.id === paneId);
        openWorkspaceTab(kind, paneId, pane?.activeTab || null);
        return;
      }
    }
    const tab = readDraggedTab(event.dataTransfer);
    if (!tab) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    splitTab(tab, paneId, event.nativeEvent.clientX < rect.left + rect.width / 2 ? 'left' : 'right');
  };
  const closeTab = (id: string) => {
    if (closeTimers.current[id]) return;
    setClosingTabs(current => ({ ...current, [id]: true }));
    closeTimers.current[id] = window.setTimeout(() => {
      delete closeTimers.current[id];
      const group = panes.find(pane => pane.tabs.includes(id));
      const wasActive = group?.activeTab === id;
      if (wasActive && group) {
        const index = group.tabs.indexOf(id);
        const fallback = group.tabs[index > 0 ? index - 1 : 1];
        if (fallback && workspaceTabKind(fallback) === 'session' && !fallback.startsWith('new:')) {
          void selectSessionContext(fallback).catch(cause => setTabError(fallback, String(cause)));
        } else if (!fallback && panes.length > 1) {
          const groupIndex = panes.findIndex(pane => pane.id === group.id);
          const neighbor = panes[groupIndex === 0 ? 1 : Math.max(0, groupIndex - 1)];
          const neighborTab = neighbor?.activeTab;
          if (neighborTab && workspaceTabKind(neighborTab) === 'session' && !neighborTab.startsWith('new:')) {
            void selectSessionContext(neighborTab).catch(cause => setTabError(neighborTab, String(cause)));
          }
        }
      }
      setPanes(current => closePaneTab(current, id, makeFallbackTab));
      setWorkspaceTabs(current => removeWorkspaceTab(current, id));
      setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setPendingAttachments(current => { const next = { ...current }; delete next[id]; return next; });
      setTabErrors(current => { const next = { ...current }; delete next[id]; return next; });
      setHeadsUpOpen(current => { const next = { ...current }; delete next[id]; return next; });
      delete paneInputRefs.current[id];
      delete headsUpTriggerRefs.current[id];
      setClosingTabs(current => { const next = { ...current }; delete next[id]; return next; });
      if (wasActive && group && group.tabs.length === 1 && panes.length > 1) {
        const groupIndex = panes.findIndex(pane => pane.id === group.id);
        const neighbor = panes[groupIndex === 0 ? 1 : Math.max(0, groupIndex - 1)];
        if (neighbor) setFocusedPaneId(neighbor.id);
      }
    }, 180);
  };
  const setFilesFor = async (tab: string, files: FileList | null) => {
    try {
      const added = await encodeAttachments(files, pendingAttachments[tab] || []);
      setPendingAttachments(current => ({ ...current, [tab]: [...(current[tab] || []), ...added] }));
      clearTabError(tab);
    } catch (cause) {
      setTabError(tab, String(cause));
    }
  };
  const removeFileFor = (tab: string, index: number) => setPendingAttachments(current => ({ ...current, [tab]: (current[tab] || []).filter((_, item) => item !== index) }));
  const submitTab = async (tab: string) => {
    const submitted = prepareMarkdownSubmission(drafts[tab] || '');
    const files = pendingAttachments[tab] || [];
    const task = taskForTab(tab);
    if (sendingRef.current.has(tab) || (!files.length && submitted === null)) return;
    const message = submitted || '';
    sendingRef.current.add(tab);
    setSendingTabs(current => ({ ...current, [tab]: true }));
    clearTabError(tab);
    setDrafts(current => ({ ...current, [tab]: '' }));
    try {
      if (task?.phase === 'escalated') await api('/api/tasks/' + task.id + '/escalation', { message, attachments: files });
      else if (task) await api('/api/tasks/' + task.id + '/messages', { message, attachments: files, ...(recruitmentSteerTargets[task.id]?{recruitmentWorkerId:recruitmentSteerTargets[task.id]}:{}) });
      else {
        await contextSelectionQueue.current;
        const created = await api('/api/tasks', { message, attachments: files });
        if (created?.id) {
          setPanes(current => current.map(pane => pane.tabs.includes(tab)
            ? { ...pane, tabs: pane.tabs.map(item => item === tab ? created.id : item), activeTab: pane.activeTab === tab ? created.id : pane.activeTab }
            : pane));
          updateWorkspaceOrigins(tab, created.id);
          setState(current => current ? { ...current, tasks: [created, ...current.tasks.filter(item => item.id !== created.id)] } : current);
          makeTabArrival(created.id);
        }
      }
      setPendingAttachments(current => { const next = { ...current }; delete next[tab]; return next; });
      if(task)setRecruitmentSteerTargets(current=>{if(!current[task.id])return current;const next={...current};delete next[task.id];return next;});
      setDrafts(current => { const next = { ...current }; delete next[tab]; return next; });
      await refresh();
    } catch (cause) {
      setTabError(tab, String(cause));
      setDrafts(current => ({ ...current, [tab]: message }));
    } finally {
      sendingRef.current.delete(tab);
      setSendingTabs(current => { const next = { ...current }; delete next[tab]; return next; });
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
  const retryAgentMemFor = async (taskId: string, passId: string) => {
    setRetryingPassId(passId);
    clearTabError(taskId);
    try {
      await api('/api/tasks/' + taskId + '/passes/' + passId + '/agentmem/retry', {});
      await refresh();
    } catch (cause) {
      setTabError(taskId, String(cause));
    } finally {
      setRetryingPassId('');
    }
  };
  const approveTask = async (taskId: string, requestId: string | number, decision: 'accept' | 'decline' | 'cancel', content?:Record<string,unknown>) => {
    try {
      await api('/api/tasks/' + taskId + '/approval', { requestId, decision, ...(content?{content}:{}) });
      await refresh();
    } catch (cause) {
      setTabError(taskId, String(cause));
    }
  };
  const updateSettings = (patch: Partial<Settings>) => {
    if (!state) return Promise.resolve();
    const next = { ...(settingsDraft.current || state.settings), ...patch };
    settingsDraft.current = next;
    settingsQueue.current = settingsQueue.current.then(async () => {
      try {
        await api('/api/settings', next);
        await refresh();
      } catch (cause) {
        setError(String(cause));
      } finally {
        if (settingsDraft.current === next) settingsDraft.current = null;
      }
    });
    return settingsQueue.current;
  };
  const setModel = async (id: string) => {
    const found = models.find(model => model.id === id);
    if (!found) return;
    const currentEffort = state?.settings.orchestratorEffort || '';
    const effort = found.efforts.includes(currentEffort) ? currentEffort : found.efforts.includes('high') ? 'high' : found.efforts[0] || '';
    await updateSettings({ orchestratorModel: id, orchestratorEffort: effort });
  };
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
      setPanes(current => normalizePanes(current.map(pane => {
        const next = pane.tabs.filter(tab => tab !== taskId);
        return { ...pane, tabs: next, activeTab: next.includes(pane.activeTab) ? pane.activeTab : next[0] || pane.activeTab };
      }), makeFallbackTab));
      setDrafts(current => { const next = { ...current }; delete next[taskId]; return next; });
      setPendingAttachments(current => { const next = { ...current }; delete next[taskId]; return next; });
      setTabErrors(current => { const next = { ...current }; delete next[taskId]; return next; });
      await refresh();
      closeSessionDialog();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const selectTask = (id: string) => openTaskTab(id);

  useEffect(() => {
    let alive = true;
    bootstrap().then(value => {
      if (!alive) return;
      applyKernelSnapshot(value);
      if (value.state.activeTaskId) {
        const id = value.state.activeTaskId;
        setPanes([{ id: 'pane:root', tabs: [id], activeTab: id, weight: 1 }]);
      }
      if (!value.state.settings.projectRoot && !value.state.selectedProjectId) {
        setSettingsMounted(true);
        setSettingsOpen(true);
      }
      setLoading(false);
    }).catch(cause => {
      if (alive) {
        setError(String(cause));
        setLoading(false);
      }
    });
    const source = new EventSource(`/api/v1/events?protocol=${KERNEL_PROTOCOL_VERSION}`);
    source.onmessage = event => {
      try {
        const value = JSON.parse(event.data);
        if (value.state && alive) applyKernelSnapshot(value);
      } catch {
      }
    };
    source.onerror = () => { if (alive) void refresh(); };
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
        const reasoning = (task.reasoningSummaries || []).reduce((total, item) => total + item.text.length, 0)
          + (task.liveActivity || []).reduce((total, item) => total + (item.text?.length||0) + (item.output?.length||0), 0);
        const previous = scrollMemory.current[id];
        const selected = pane.activeTab === id;
        if (!previous || selected && (messages !== previous.messages || reasoning !== previous.reasoning) && nearBottom.current[id] !== false) {
          element.scrollTop = element.scrollHeight;
          nearBottom.current[id] = true;
        }
        scrollMemory.current[id] = { messages, reasoning };
      }
    }
    const openIds = new Set(panes.flatMap(pane => pane.tabs));
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
      const requestedUrl = typeof (command as { url?: unknown }).url === 'string' ? (command as { url: string }).url : undefined;
      openWorkspaceTab(kind, pane.id, pane.activeTab, requestedUrl);
    }
  }, [panes, state?.tasks]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if(event.isComposing||event.keyCode===229||event.getModifierState('AltGraph'))return;
      if(event.key==='Escape'){if(projectEditor){event.preventDefault();setProjectEditor(null);return;}if(shortcutsOpen){event.preventDefault();setShortcutsOpen(false);return;}if(settingsOpen){event.preventDefault();closeSettings();return;}if(sessionDialogOpen){event.preventDefault();closeSessionDialog();return;}return;}
      if(projectEditor||shortcutsOpen||settingsOpen||sessionDialogOpen)return;
      const isMac=window.pseudoharnessDesktop?.platform==='darwin'||navigator.platform.toLocaleLowerCase().includes('mac');const mod=isMac?event.metaKey:event.ctrlKey;if(!mod||isMac&&event.ctrlKey||!isMac&&event.metaKey)return;
      const key=event.key.toLowerCase();const allowedAlt=event.altKey&&key==='p';if(event.altKey&&!allowedAlt)return;const target=event.target instanceof HTMLElement?event.target:null;const formControl=!!target&&/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);const editable=!!target?.isContentEditable;const composerEditor=!!target?.closest('.cm-editor');
      if((formControl||editable)&&!composerEditor)return;
      if(composerEditor&&(key==='b'||event.shiftKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')))return;
      if(key==='n'&&!event.shiftKey){event.preventDefault();openNewTab();return;}
      if(key===','&&!event.shiftKey){event.preventDefault();openSettings();return;}
      if(key==='b'&&!event.shiftKey){event.preventDefault();setSidebarCollapsed(value=>!value);return;}
      if(key==='g'&&event.shiftKey){event.preventDefault();const pane=panes.find(item=>item.id===focusedPaneId)||rootPane;openWorkspaceTab('git',pane.id,pane.activeTab);return;}
      if(key==='l'&&event.shiftKey){event.preventDefault();openSkillsTab();return;}
      if(key==='p'&&event.altKey){event.preventDefault();projectSelectorRef.current?.focus();return;}
      if((event.key==='ArrowUp'||event.key==='ArrowDown')&&event.shiftKey){const tasks=state?.tasks||[];if(!tasks.length)return;const active=panes.find(pane=>pane.id===focusedPaneId)?.activeTab||null;let navigation=recentSessionNavigation.current;const ids=tasks.map(task=>task.id);if(!navigation||navigation.activeId!==active||navigation.ids.length!==ids.length||navigation.ids.some(id=>!ids.includes(id))){navigation={ids:[...tasks].sort((a,b)=>(Date.parse(b.lastInteractedAt||b.createdAt)||0)-(Date.parse(a.lastInteractedAt||a.createdAt)||0)).map(task=>task.id),activeId:active};}const index=navigation.ids.indexOf(active||'');const next=index<0?(event.key==='ArrowDown'?0:navigation.ids.length-1):(index+(event.key==='ArrowDown'?1:-1)+navigation.ids.length)%navigation.ids.length;const nextId=navigation.ids[next];if(!nextId)return;event.preventDefault();navigation.activeId=nextId;recentSessionNavigation.current=navigation;selectTask(nextId);return;}
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [projectEditor,shortcutsOpen,settingsOpen,sessionDialogOpen,panes,focusedPaneId,state?.tasks]);

  if (loading) return <div className="boot"><div className="brand-mark">P</div><span>Starting Pseudoharness</span></div>;
  const matchingTasks=(state?.tasks||[]).filter(task=>!query.trim()||task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>(Date.parse(b.lastInteractedAt||b.createdAt)||0)-(Date.parse(a.lastInteractedAt||a.createdAt)||0));
  const renderSessionRows=(tasks:Task[])=>tasks.map(task=><SessionRow key={task.id} task={task} selected={panes.some(pane=>pane.activeTab===task.id)} onSelect={selectTask} onSessionAction={openSessionDialog} onMoveStart={dragSession} projects={state?.projects||[]} onMove={moveSessionToProject}/>);
  const orderedProjects=[...(state?.projects||[])].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||a.name.localeCompare(b.name));
  const unclassifiedTasks=matchingTasks.filter(task=>!task.projectId||!(state?.projects||[]).some(project=>project.id===task.projectId));
  const projectSessionSection=(project:Project)=>{const tasks=matchingTasks.filter(task=>task.projectId===project.id);const expanded=(state?.expandedProjectIds||[]).includes(project.id);const shown=showAllProjects[project.id]?tasks:tasks.slice(0,5);return <section className={`project-session-group ${expanded?'expanded':''} ${projectDropTarget===project.id?'is-drop-target':''}`} key={project.id} onDragEnter={event=>{if(event.dataTransfer.types.includes('application/x-pseudoharness-session-project'))setProjectDropTarget(project.id);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setProjectDropTarget(null);}} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-pseudoharness-session-project'))event.preventDefault();}} onDrop={event=>dropSessionInto(event,project.id)}><div className="project-group-heading"><button className="project-expand" aria-label={`${expanded?'Collapse':'Expand'} ${project.name}`} aria-expanded={expanded} onClick={()=>toggleProjectExpanded(project.id)}>{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<Folder size={14}/><span>{project.name}</span><small>{tasks.length}</small></button><button className="project-group-pin" aria-label={`${project.pinned?'Unpin':'Pin'} ${project.name}`} title={project.pinned?'Unpin project':'Pin project'} onClick={()=>void api(`/api/projects/${project.id}/pin`,{pinned:!project.pinned}).then(refresh).catch(cause=>setError(String(cause)))}><Pin size={12}/></button><button className="project-group-edit" aria-label={`Configure ${project.name}`} title={`Configure ${project.name}`} onClick={()=>openProjectEditor(project)}><Settings2 size={13}/></button></div>{expanded&&<div className="project-session-rows">{renderSessionRows(shown)}{tasks.length>5&&<button className="session-history-more" onClick={()=>setShowAllProjects(current=>({...current,[project.id]:!current[project.id]}))}>{showAllProjects[project.id]?'Show recent five':`Show all ${tasks.length} sessions`}</button>}{!tasks.length&&<span className="project-empty">Drop a session here</span>}</div>}</section>;};
  const unclassifiedExpanded=(state?.expandedProjectIds??['unclassified']).includes('unclassified');

  const paneComposer = (tab: string, task: Task | null, paneId:string) => {
    const value = drafts[tab] || '';
    const files = pendingAttachments[tab] || [];
    const busy = !!task && ['routing', 'direct_running', 'simple_running', 'planning', 'worker_running', 'reviewing'].includes(task.phase);
    const disabled = !value.trim() && !files.length || !!sendingTabs[tab] || !runtime;
    return <Composer
      value={value}
      setValue={next => setDrafts(current => ({ ...current, [tab]: next }))}
      submit={() => void submitTab(tab)}
      disabled={disabled}
      hint={task?.phase === 'escalated' ? 'A decision will be sent to this session’s orchestrator…' : 'Ask a question or describe work for the router to classify.'}
      inputRef={tabInputRef(tab)}
      model={state?.settings.orchestratorModel || 'gpt-6-sol'}
      effort={state?.settings.orchestratorEffort || 'high'}
      approvalPolicy={state?.settings.approvalPolicy || 'on-request'}
      models={models}
      configDisabled={busy || !!sendingTabs[tab]}
      onModelChange={value => void setModel(value)}
      onEffortChange={value => void updateSettings({ orchestratorEffort: value })}
      onApprovalChange={value => void updateSettings({ approvalPolicy: value })}
      busy={busy}
      attachments={files}
      onFiles={selected => void setFilesFor(tab, selected)}
      onRemoveFile={index => removeFileFor(tab, index)}
      onOpenSkills={()=>openSkillsTab(paneId)}
    />;
  };
  const renderNewTabActions = (pane: SessionPane, tab: string) => (
    <div className="new-tab-actions">
      <button onClick={() => openNewTabInPane(pane.id)}><MessageSquarePlus size={14} />SESSION</button>
      <button onClick={() => openWorkspaceTab('browser', pane.id, tab)}><Globe size={14} />BROWSER</button>
      <button onClick={() => openWorkspaceTab('git', pane.id, tab)}><GitBranch size={14} />GIT</button>
      <div className="new-tab-context"><Folder size={12}/><span>{selectedProject?.name||rootLabel(state?.settings.projectRoot)}</span><span>·</span><span>Codex {runtime?.codex.state==='connected'?'connected':'offline'}</span><span>·</span><span>{selectedProject?selectedProject.agentmemEnabled?'AgentMem enabled · service '+(runtime?.agentmem.connected?'connected':'offline'):'AgentMem disabled':state?.settings.agentmemProjectId?'AgentMem enabled · service '+(runtime?.agentmem.connected?'connected':'offline'):'AgentMem disabled'}</span></div>
    </div>
  );
  const renderSessionPaneActions = (tab: string, task: Task | null) => {
    const busy = !!task && ['routing', 'direct_running', 'simple_running', 'planning', 'worker_running', 'reviewing'].includes(task.phase);
    return <div className="session-pane-actions" data-session-actions-for={tab} role="group" aria-label={(task?.title || 'New session') + ' controls'}>
      {busy && <button className="session-pane-action session-pane-stop" aria-label="Stop" title="Stop this session" onClick={() => void stopTask(tab)}><Square size={13} fill="currentColor" /></button>}
      <button ref={headsUpTriggerRef(tab)} className="session-pane-action details-toggle heads-up-toggle" aria-label="Heads-up" title="Heads-up"
        aria-expanded={!!headsUpOpen[tab]} onClick={() => setHeadsUpOpen(current => ({ ...current, [tab]: !current[tab] }))}><PanelRight size={16} /></button>
    </div>;
  };
  const renderPaneTabs = (pane: SessionPane, index: number, split: boolean) => {
    const listLabel = split ? index === 1 ? 'Side pane workspaces' : 'Pane ' + (index + 1) + ' workspaces' : 'Open workspaces';
    return <div className={'document-tabs ' + (split ? 'split-pane-tabbar' : '')} role="tablist" aria-label={listLabel}
      style={split ? { gridColumn: index * 2 + 1, gridRow: 1 } : undefined} onDragOver={allowTabDrop} onDrop={dropTabOnStrip}>
      {pane.tabs.map(tab => {
        const kind = workspaceTabKind(tab);
        const task = kind === 'session' ? taskForTab(tab) : null;
        const title = workspaceTabTitle(tab, task?.title);
        const selected = pane.activeTab === tab;
        const symbol = kind === 'browser' ? <Globe size={13} /> : kind === 'git' ? <GitBranch size={13} /> : kind==='skills'?<BookOpen size={13}/>: index === 0 && !split ? <MessageSquarePlus size={13} /> : null;
        const activate=()=>{setPaneActive(pane.id,tab);setFocusedPaneId(pane.id);if(kind==='session'&&!tab.startsWith('new:'))void selectSessionContext(tab).catch(cause=>setTabError(tab,String(cause)));};
        const activateFromClick=(event:React.MouseEvent<HTMLElement>)=>{if(tabDragSuppressUntil.current?.tab===tab&&Date.now()<tabDragSuppressUntil.current.until||event.target instanceof Element&&event.target.closest('.tab-close')){event.preventDefault();event.stopPropagation();return;}activate();};
        return <div className={'document-tab ' + (selected ? 'active ' : '') + (tabDropTarget === tab ? 'tab-drop-target ' : '') + (sessionArrival === tab ? 'session-arrived tab-arrived ' : '') + (closingTabs[tab] ? 'tab-closing' : '')}
          key={tab} data-workspace-tab={tab} data-session-tab={tab} draggable={!closingTabs[tab]}
          onClick={activateFromClick}
          onPointerDown={event=>{if(event.button===0&&tabDragSuppressUntil.current?.tab===tab)tabDragSuppressUntil.current=null;}}
          onMouseDown={event=>{if(event.button===1)event.preventDefault();}}
          onAuxClick={event=>{if(event.button===1){event.preventDefault();closeTab(tab);}}}
          onDragStart={event => {
            if(event.target instanceof Element&&event.target.closest('.tab-close')){event.preventDefault();return;}
            tabDragSuppressUntil.current={tab,until:Date.now()+600};
            clearTabDrop();
            setDraggedTab(tab);
            event.dataTransfer.setData('application/x-pseudoharness-workspace-tab', tab);
            event.dataTransfer.setData('application/x-pseudoharness-session-tab', tab);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => finishTabDrag(tab)}
          onPointerCancel={()=>{clearTabDrop();setDraggedTab(null);setDropTarget(null);tabDragSuppressUntil.current=null;}}
          onDragOver={event => {
            if (Array.from(event.dataTransfer.types).some(type => type === 'application/x-pseudoharness-workspace-tab' || type === 'application/x-pseudoharness-session-tab')) {
              event.preventDefault();
              tabDropTargetRef.current = tab;
              setTabDropTarget(tab);
            }
          }}
          onDrop={event => {
            const source = readDraggedTab(event.dataTransfer);
            if (!source) return;
            event.preventDefault();
            event.stopPropagation();
            moveTab(source, tab);
          }}>
          <button role="tab" aria-label={title} aria-selected={selected} onClick={event=>{event.stopPropagation();activateFromClick(event);}}>{symbol}<span>{title}</span></button>
          <button className="tab-close" aria-label={'Close ' + title + ' tab'} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();closeTab(tab);}} disabled={!!closingTabs[tab]}><X size={13} /></button>
        </div>;
      })}
      <button className="new-tab" aria-label={split ? index === 1 ? 'New session in side pane' : 'New session in pane ' + (index + 1) : 'Open new session tab'} onClick={() => openNewTabInPane(pane.id)}><Plus size={15} /></button>
      {windowControls && (!split || index === panes.length - 1) && <div className="window-controls" role="group" aria-label="Window controls">
        <button aria-label="Minimize window" title="Minimize" onClick={() => void windowControls.minimize()}><Minus size={14} /></button>
        <button aria-label={windowMaximized ? 'Restore window' : 'Maximize window'} title={windowMaximized ? 'Restore' : 'Maximize'} onClick={() => void windowControls.toggleMaximize()}>{windowMaximized ? <Copy size={12} /> : <Maximize2 size={12} />}</button>
        <button className="window-close" aria-label="Close window" title="Close" onClick={() => void windowControls.close()}><X size={15} /></button>
      </div>}
    </div>;
  };
  const renderWorkspaceTab = (tab: string, pane: SessionPane, index: number) => {
    const kind = workspaceTabKind(tab);
    const selected = pane.activeTab === tab;
    const task = kind === 'session' ? taskForTab(tab) : null;
    const record = workspaceTabs[tab];
    const contextTask = record?.originTaskId ? taskForTab(record.originTaskId) : null;
    const workspaceRoot = record?.originTaskId ? (contextTask?.userRoot || record.projectRoot) : (selectedProject?.projectRoot || record?.projectRoot || state?.settings.projectRoot || '');
    const isSession = kind === 'session';
    const baseClass = (index > 0 ? 'session-pane side-session-view ' : 'task-view ') + 'pane-body ' + (!task && isSession ? 'new-tab-view ' : '') + (sessionArrival === tab ? 'session-entering ' : '') + (selected ? 'workspace-tab-active ' : '') + (dropTarget?.paneId === pane.id ? 'drop-half-' + dropTarget.half : '');
    const row = panes.length > 1 ? 2 : 1;
    const column = index * 2 + 1;
    const onDragOver = (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      if (types.includes('application/x-pseudoharness-workspace-tab') || types.includes('application/x-pseudoharness-session-tab')) {
        event.preventDefault();
        clearTabDrop();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropTarget({ paneId: pane.id, half: event.clientX < rect.left + rect.width / 2 ? 'left' : 'right' });
      }
    };
    if(kind==='skills')return <div key={tab} data-workspace-tab={tab} data-tab-kind="skills" className={baseClass+' skill-library-tab'} style={{gridColumn:column,gridRow:row}} hidden={!selected} aria-hidden={!selected} inert={!selected} onClick={()=>setFocusedPaneId(pane.id)}><Suspense fallback={<div className="skill-library-loading" role="status">Loading skills…</div>}><SkillsLibraryPage active={selected}/></Suspense></div>;
    if (kind === 'browser' || kind === 'git') {
      return <div key={tab} data-workspace-tab={tab} data-tab-kind={kind} className={baseClass + ' peer-workspace-pane ' + (kind === 'browser' ? 'browser-peer-tab' : 'git-peer-tab')}
        style={{ gridColumn: column, gridRow: row }} hidden={!selected} aria-hidden={!selected} inert={!selected}
        onClick={() => setFocusedPaneId(pane.id)} onDragOver={onDragOver}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
        onDrop={event => dropPane(event, pane.id)}>
        <EmbeddedWorkspace mode={kind === 'browser' ? 'browser' : 'github'} task={contextTask} placement="full" docked={false}
          workspaceId={tab} active={selected} sidebarCollapsed={sidebarCollapsed} sidebarWidth={sidebarWidth} initialUrl={record?.initialUrl || record?.focusUrl} projectRoot={workspaceRoot}
          onOpenBrowserTab={url => openWorkspaceTab('browser', pane.id, tab, url)}
          onSummary={() => returnToOrigin(record)}
          onAnnotation={(annotation, comment) => record && addBrowserAnnotation(record, annotation, comment)} />
      </div>;
    }
    const taskView = task ? <div className="conversation" ref={element => { sessionScrollRefs.current[tab] = element; }}
      onScroll={event => {
        const element = event.currentTarget;
        nearBottom.current[tab] = element.scrollHeight - element.scrollTop - element.clientHeight < 180;
      }}>
      {tabErrors[tab] && <div className="tab-error" role="alert"><AlertCircle size={15} /><span>{tabErrors[tab]}</span><button className="icon-btn" aria-label="Dismiss session error" onClick={() => clearTabError(tab)}><X size={13} /></button></div>}
      {task.messages.filter(message => !message.passId).map(message => <ConversationMessage key={message.id} message={message} />)}
      {task.passes?.map(pass => <PassPanel key={pass.id} pass={pass} messages={task.messages.filter(message => message.passId === pass.id)}
        active={pass.id === task.currentPassId} task={task}
        selectedSteerWorkerId={pass.recruitmentTeam?recruitmentSteerTargets[task.id]:undefined} onSelectSteerWorker={workerId=>setRecruitmentSteerTargets(current=>({...current,[task.id]:workerId}))}
        assignmentExpanded={expanded['assignment:' + pass.id] ?? false} receiptExpanded={expanded['receipt:' + pass.id] ?? false}
        workerActivityExpanded={expanded['workerActivity:' + pass.id] ?? false} agentmemAuditExpanded={expanded['agentmemAudit:' + pass.id] ?? false} retrying={retryingPassId === pass.id}
        onRetryAgentMem={() => void retryAgentMemFor(task.id, pass.id)}
        toggleAssignment={() => setExpanded(current => ({ ...current, ['assignment:' + pass.id]: !current['assignment:' + pass.id] }))}
        toggleReceipt={() => setExpanded(current => ({ ...current, ['receipt:' + pass.id]: !current['receipt:' + pass.id] }))}
        toggleWorkerActivity={() => setExpanded(current => ({ ...current, ['workerActivity:' + pass.id]: !current['workerActivity:' + pass.id] }))}
        toggleAgentMemAudit={() => setExpanded(current => ({ ...current, ['agentmemAudit:' + pass.id]: !current['agentmemAudit:' + pass.id] }))} />)}
      {task.approvalRequests?.map(request => <ApprovalCard key={String(request.requestId)} request={request} onDecision={(decision,content) => void approveTask(task.id, request.requestId, decision,content)} />)}
    </div> : <div className="new-tab-center">
      {tabErrors[tab] && <div className="tab-error" role="alert"><AlertCircle size={15} /><span>{tabErrors[tab]}</span><button className="icon-btn" aria-label="Dismiss session error" onClick={() => clearTabError(tab)}><X size={13} /></button></div>}
      <div className="composer-dock">{paneComposer(tab, null, pane.id)}</div>
      {renderNewTabActions(pane, tab)}
    </div>;
    return <div key={tab} data-workspace-tab={tab} data-tab-kind="session" className={baseClass} style={{ gridColumn: column, gridRow: row }} hidden={!selected} aria-hidden={!selected} inert={!selected}
      onClick={() => setFocusedPaneId(pane.id)} onDragOver={onDragOver}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
      onDrop={event => dropPane(event, pane.id)}>
      {renderSessionPaneActions(tab, task)}
      {task && <>{taskView}<div className={'composer-dock ' + (index > 0 ? 'side-composer-dock' : '')}>{paneComposer(tab, task, pane.id)}</div></>}
      {!task && taskView}
      <HeadsUpPanel task={task} settings={task?{...(state?.settings||fallbackSettings),projectRoot:task.userRoot,agentmemProjectId:task.agentmemProjectId||''}:selectedProject?{...(state?.settings||fallbackSettings),projectRoot:selectedProject.projectRoot,agentmemProjectId:selectedProject.agentmemProjectId}:state?.settings||fallbackSettings} runtime={runtime} open={selected && !!headsUpOpen[tab]}
        onClose={() => setHeadsUpOpen(current => ({ ...current, [tab]: false }))}
        onOpenSettings={openSettings} triggerRef={headsUpTriggerRef(tab)} />
    </div>;
  };

  return <div className={'app-shell ' + (windowControls ? 'has-custom-chrome ' : '') + (sidebarCollapsed ? 'sidebar-collapsed ' : '') + (sidebarResizing ? 'sidebar-resizing' : '')} style={{ '--sidebar-width': sidebarCollapsed ? '0px' : sidebarWidth + 'px' } as React.CSSProperties}>
    <nav className="activity-rail" aria-label="App navigation">
      <button className="rail-toggle" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Toggle sidebar (Ctrl/Cmd+B)" aria-keyshortcuts="Control+B Meta+B" aria-expanded={!sidebarCollapsed} aria-controls="primary-sidebar" onClick={() => setSidebarCollapsed(value => !value)}><PanelLeft size={17} /></button>
      <button role="tab" aria-label="Sessions" onClick={() => {
        const pane = panes.find(item => item.id === focusedPaneId) || rootPane;
        if (workspaceTabKind(pane.activeTab) !== 'session') activateSessionTab(pane.tabs.find(tab => workspaceTabKind(tab) === 'session') || 'new:0');
      }}><FileText size={17} /></button>
      <button role="tab" draggable aria-label="Browser" aria-current={panes.some(pane => workspaceTabKind(pane.activeTab) === 'browser') ? 'page' : undefined}
        onDragStart={event => { event.dataTransfer.setData('application/x-pseudoharness-workspace', 'browser'); event.dataTransfer.effectAllowed = 'move'; }}
        onClick={() => {
          const pane = panes.find(item => item.id === focusedPaneId) || rootPane;
          openWorkspaceTab('browser', pane.id, pane.activeTab);
        }}><Globe size={17} /></button>
      <button role="tab" draggable aria-label="Git" title="Git (Ctrl/Cmd+Shift+G)" aria-keyshortcuts="Control+Shift+G Meta+Shift+G" aria-current={panes.some(pane => workspaceTabKind(pane.activeTab) === 'git') ? 'page' : undefined}
        onDragStart={event => { event.dataTransfer.setData('application/x-pseudoharness-workspace', 'git'); event.dataTransfer.effectAllowed = 'move'; }}
        onClick={() => {
          const pane = panes.find(item => item.id === focusedPaneId) || rootPane;
          openWorkspaceTab('git', pane.id, pane.activeTab);
        }}><GitBranch size={17} /></button>
          <button role="tab" aria-label="Skills" title="Skills (Ctrl/Cmd+Shift+L)" aria-keyshortcuts="Control+Shift+L Meta+Shift+L" aria-current={panes.some(pane=>workspaceTabKind(pane.activeTab)==='skills')?'page':undefined} onClick={()=>openSkillsTab()}><BookOpen size={17}/></button>
      <div className="rail-spacer" />
      <button aria-label="Settings" title="Settings (Ctrl/Cmd+,)" aria-keyshortcuts="Control+, Meta+," onClick={openSettings}><Settings2 size={17} /></button>
    </nav>
    <aside id="primary-sidebar" aria-label="Session explorer" className="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
      <div className="sidebar-tools">
        <span className="sidebar-title">Sessions</span>
        <button className="icon-btn" aria-label="New session" title="New session (Ctrl/Cmd+N)" aria-keyshortcuts="Control+N Meta+N" onClick={openNewTab}><Plus size={16} /></button>
        <button className="icon-btn" aria-label="Create project" title="Create project" onClick={()=>openProjectEditor('new')}><FolderPlus size={15}/></button>
        <button className="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={()=>setShortcutsOpen(true)}><Keyboard size={15}/></button>
        <button className="icon-btn" aria-label="Search sessions" onClick={() => document.querySelector<HTMLInputElement>('.session-search')?.focus()}><Search size={15} /></button>
      </div>
      <input className="session-search" type="search" aria-label="Search sessions" placeholder="Filter sessions" value={query} onChange={event => setQuery(event.target.value)} />
      <nav className="task-list project-task-list" aria-label="Sessions" onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-pseudoharness-session-project'))event.preventDefault();}}>
        {orderedProjects.filter(project=>project.pinned).map(projectSessionSection)}
        {orderedProjects.filter(project=>!project.pinned).map(projectSessionSection)}
        <section className={`project-session-group unclassified-group ${projectDropTarget==='unclassified'?'is-drop-target':''}`} onDragEnter={event=>{if(event.dataTransfer.types.includes('application/x-pseudoharness-session-project'))setProjectDropTarget('unclassified');}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setProjectDropTarget(null);}} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-pseudoharness-session-project'))event.preventDefault();}} onDrop={event=>dropSessionInto(event,null)}><div className="project-group-heading"><button className="project-expand" aria-label={`${unclassifiedExpanded?'Collapse':'Expand'} Unclassified`} aria-expanded={unclassifiedExpanded} onClick={()=>toggleProjectExpanded('unclassified')}>{unclassifiedExpanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<Folder size={14}/><span>Unclassified</span><small>{unclassifiedTasks.length}</small></button></div>{unclassifiedExpanded&&<div className="project-session-rows">{renderSessionRows(showAllProjects.unclassified?unclassifiedTasks:unclassifiedTasks.slice(0,5))}{unclassifiedTasks.length>5&&<button className="session-history-more" onClick={()=>setShowAllProjects(current=>({...current,unclassified:!current.unclassified}))}>{showAllProjects.unclassified?'Show recent five':`Show all ${unclassifiedTasks.length} sessions`}</button>}</div>}</section>
      </nav>
      {projectMoveError&&<div className="project-move-error" role="alert">{projectMoveError}<button className="icon-btn" aria-label="Dismiss move error" onClick={()=>setProjectMoveError('')}><X size={13}/></button></div>}
      <div className="sidebar-bottom"><button className="project-mini" aria-label={selectedProject?.name||rootLabel(state?.settings.projectRoot)+' project settings'} onClick={()=>selectedProject?openProjectEditor(selectedProject):openSettings}><Folder size={15} /><span className="project-mini-text">{selectedProject?.name||rootLabel(state?.settings.projectRoot)}</span></button></div>
    </aside>
    <div className="sidebar-resizer" role="separator" aria-label="Resize session explorer" aria-orientation="vertical" aria-valuemin={112} aria-valuenow={sidebarCollapsed ? 0 : sidebarWidth} tabIndex={0}
      onPointerDown={event => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSidebarResizing(true);
        resizeRef.current = { kind: 'sidebar', x: event.clientX, width: sidebarCollapsed ? 0 : sidebarWidth, pointerId: event.pointerId };
      }}
      onPointerMove={event => {
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
      onPointerUp={event => { if (resizeRef.current?.pointerId === event.pointerId) { resizeRef.current = null; setSidebarResizing(false); } }}
      onPointerCancel={() => { resizeRef.current = null; setSidebarResizing(false); }}
      onLostPointerCapture={() => { resizeRef.current = null; setSidebarResizing(false); }}
      onKeyDown={event => {
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
    <div className="workspace-area">
      <main className="main-column">
        <header className="topbar">{panes.length===1&&renderPaneTabs(rootPane,0,false)}<div className="topbar-project-context"><label><span className="sr-only">Project for new sessions</span><select ref={projectSelectorRef} aria-label="Project for new sessions" title="Choose project (Ctrl/Cmd+Alt+P)" aria-keyshortcuts="Control+Alt+P Meta+Alt+P" value={state?.selectedProjectId||''} onChange={event=>void selectProject(event.currentTarget.value||null)}><option value="">Unclassified · legacy default</option>{(state?.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span className={'topbar-project-connection '+(runtime?.codex.state==='connected'?'connected':'')}><i aria-hidden="true"/>{runtime?.codex.state==='connected'?'Connected':'Offline'}</span></div></header>
        <div className={'workspace-content mode-tasks ' + (panes.length > 1 ? 'has-session-panes has-side-session ' : '') + (draggedTab ? 'dragging-session' : '')}
          style={{ gridTemplateColumns: panes.flatMap((pane, index) => index < panes.length - 1 ? ['minmax(0,' + pane.weight + 'fr)', '5px'] : ['minmax(0,' + pane.weight + 'fr)']).join(' '), transition: 'grid-template-columns 180ms cubic-bezier(.2,.75,.25,1)' }}
          onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('application/x-pseudoharness-workspace')) event.preventDefault(); }}
          onDrop={event => {
            const mode = event.dataTransfer.getData('application/x-pseudoharness-workspace');
            const kind = workspaceKindForMode(mode);
            if (kind) {
              event.preventDefault();
              const pane = panes.find(item => item.id === focusedPaneId) || rootPane;
              openWorkspaceTab(kind, pane.id, pane.activeTab);
              return;
            }
            const tab = readDraggedTab(event.dataTransfer);
            if (!tab) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            splitTab(tab, panes[0].id, event.clientX < rect.left + rect.width / 2 ? 'left' : 'right');
          }}>
          {panes.map((pane, index) => <div className="pane-grid-group" key={pane.id}>
            {panes.length > 1 && renderPaneTabs(pane, index, true)}
            {index > 0 && <div className="workspace-resizer" role="separator" aria-label={'Resize pane ' + index} aria-orientation="vertical"
              aria-valuemin={168} aria-valuenow={Math.round(pane.weight / (pane.weight + panes[index - 1].weight) * 100)} tabIndex={0}
              style={{ gridColumn: index * 2, gridRow: '1 / -1' }}
              onPointerDown={event => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                resizeRef.current = { kind: 'pane', x: event.clientX, left: panes[index - 1].id, right: pane.id, pointerId: event.pointerId };
              }}
              onPointerMove={event => {
                const drag = resizeRef.current;
                if (!drag || drag.pointerId !== event.pointerId || drag.kind !== 'pane') return;
                const delta = event.clientX - drag.x;
                drag.x = event.clientX;
                const rect = document.querySelector('.workspace-content')?.getBoundingClientRect();
                if (rect && drag.left && drag.right) setPanes(current => resizeAdjacentPanes(current, drag.left, drag.right, delta, rect.width, 168).panes);
              }}
              onPointerUp={event => { if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null; }}
              onLostPointerCapture={() => { resizeRef.current = null; }}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const rect = document.querySelector('.workspace-content')?.getBoundingClientRect();
                if (rect) setPanes(current => resizeAdjacentPanes(current, panes[index - 1].id, pane.id, (event.key === 'ArrowRight' ? 1 : -1) * 24, rect.width, 168).panes);
              }} />}
            {pane.tabs.map(tab => renderWorkspaceTab(tab, pane, index))}
          </div>)}
        </div>
      </main>
    </div>
    {error && <div className="toast-error" role="alert"><AlertCircle size={15} />{error}<button className="icon-btn" aria-label="Dismiss app error" onClick={() => setError('')}><X size={14} /></button></div>}
    {projectEditor&&<div className="dialog-backdrop" data-open="true" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&!projectSaving&&setProjectEditor(null)}><form className="project-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="project-editor-title" onSubmit={saveProject}>
      <header><div><h2 id="project-editor-title">{projectEditor==='new'?'Create project':`Configure ${projectEditor.name}`}</h2><p>Project settings apply to new sessions and future passes. Saved pass roots and knowledge base audit snapshots remain unchanged.</p></div><button type="button" className="icon-btn" aria-label="Close project settings" onClick={()=>setProjectEditor(null)} disabled={projectSaving}><X size={16}/></button></header>
      <label>Project name<input autoFocus value={projectName} maxLength={80} onChange={event=>setProjectName(event.target.value)} required/></label>
      <label>Working directory<input value={projectRootDraft} maxLength={1024} placeholder="D:\\work\\project" onChange={event=>{const next=event.currentTarget.value;setProjectRootDraft(next);if(projectAgentMemAuto)setProjectAgentMemId('');}} required/><small>Choose an existing folder. The server resolves and validates the path when saving.</small></label>
      <label className="project-editor-toggle"><input type="checkbox" checked={projectPinned} onChange={event=>setProjectPinned(event.target.checked)}/><span>Pin project above the rest</span></label>
      <label className="project-editor-toggle"><input type="checkbox" checked={projectAgentMemEnabled} onChange={event=>setProjectAgentMemEnabled(event.target.checked)}/><span>Enable AgentMem for this project</span></label>
      {projectAgentMemEnabled&&<><label>AgentMem project ID<input value={projectAgentMemId} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" onChange={event=>setProjectAgentMemId(event.target.value)} disabled={projectAgentMemAuto}/><small>Use the exact ID for a registered knowledge base. Automatic setup derives a stable ID for this folder.</small></label><label className="project-editor-toggle"><input type="checkbox" checked={projectAgentMemAuto} onChange={event=>setProjectAgentMemAuto(event.target.checked)}/><span>Set up a knowledge base for this folder automatically</span></label></>}
      {projectError&&<p className="project-editor-error" role="alert">{projectError}</p>}
      <footer><button type="button" className="secondary-btn" onClick={()=>setProjectEditor(null)} disabled={projectSaving}>Cancel</button><button className="primary-btn" disabled={projectSaving||!projectName.trim()||!projectRootDraft.trim()}>{projectSaving?'Saving…':'Save project'}</button></footer>
    </form></div>}
    {shortcutsOpen&&<div className="dialog-backdrop" data-open="true" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&setShortcutsOpen(false)}><section className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title"><header><div><h2 id="shortcuts-title">Keyboard shortcuts</h2><p>Use Ctrl on Windows/Linux or Command on macOS.</p></div><button type="button" className="icon-btn" aria-label="Close shortcuts" onClick={()=>setShortcutsOpen(false)}><X size={16}/></button></header><dl><dt>New session</dt><dd>Ctrl/⌘ + N</dd><dt>Previous / next session</dt><dd>Ctrl/⌘ + Shift + ↑ / ↓</dd><dt>Choose project</dt><dd>Ctrl/⌘ + Alt + P</dd><dt>Settings</dt><dd>Ctrl/⌘ + ,</dd><dt>Git</dt><dd>Ctrl/⌘ + Shift + G</dd><dt>Skills</dt><dd>Ctrl/⌘ + Shift + L</dd><dt>Toggle sidebar</dt><dd>Ctrl/⌘ + B</dd><dt>Dismiss dialog</dt><dd>Escape</dd></dl></section></div>}
    {settingsMounted && state && <SettingsDialog open={settingsOpen} settings={selectedProject?{...state.settings,projectRoot:selectedProject.projectRoot,agentmemProjectId:selectedProject.agentmemProjectId,agentmemAutoSetup:selectedProject.agentmemAutoSetup}:state.settings} models={models} runtime={runtime} close={closeSettings} reconnect={refresh} saved={async settings => {
      try {
        const project=selectedProject;
        await api('/api/settings',project?{...settings,projectRoot:state.settings.projectRoot,agentmemProjectId:state.settings.agentmemProjectId,agentmemAutoSetup:state.settings.agentmemAutoSetup}:settings);
        if(project)await api('/api/projects',{id:project.id,name:project.name,projectRoot:settings.projectRoot,agentmemEnabled:!!settings.agentmemProjectId||!!settings.agentmemAutoSetup,agentmemProjectId:settings.agentmemProjectId,agentmemAutoSetup:!!settings.agentmemAutoSetup,pinned:project.pinned});
        await refresh();
        return true;
      } catch (cause) {
        setError(String(cause));
        return false;
      }
    }} />}
    {sessionDialogMounted && sessionDialog && <SessionDialog open={sessionDialogOpen} kind={sessionDialog.kind} task={state?.tasks.find(task => task.id === sessionDialog.taskId)} close={closeSessionDialog} rename={renameSession} remove={deleteSession} />}
  </div>;
}


function ConversationMessage({message:m,execution}:{message:Message;execution?:DeepSeekExecutionProfile}){
  if(m.role==='user')return <div className="message user-message" key={m.id}><div className="user-avatar">U</div><div className="message-main"><div className="message-meta"><strong>You</strong><span>{stamp(m.createdAt)}</span>{m.submissionKind==='steering'&&<span className={`model-chip steering-chip ${m.deliveryStatus||'pending'}`}>{m.deliveryStatus==='steered'?'Steered active turn':m.deliveryStatus==='unconfirmed'?'Steering delivery unconfirmed':'Sending steering'}</span>}</div><div className="message-body markdown-body"><Markdown>{m.text}</Markdown></div></div></div>;
  if(m.role==='system')return <div className={`system-event ${m.text.startsWith('Worker activity:')?'progress-event':''}`} key={m.id}><span className="event-glyph">{m.text.startsWith('Worker activity:')?<Activity size={14}/>:<AlertCircle size={14}/>}</span><span>{m.text.replace(/^Worker activity: /,'')}</span></div>;
  return <div className="message agent-message" key={m.id}><div className={`agent-avatar ${m.role}`}>{m.role==='worker'?<Terminal size={15}/>:<Command size={15}/>}</div><div className="message-main"><div className="message-meta"><strong>{execution&&m.role==='worker'?`DeepSeek Harness worker · ${execution.provider}`:m.role==='worker'?'Luna worker':m.role==='router'?'Routing agent':m.role==='direct'?'Direct answer':m.role==='simple'?'Luna simple implementation':'Orchestrator'}</strong><span>{stamp(m.createdAt)}</span>{(['worker','router','direct','simple'].includes(m.role))&&<span className="model-chip">{execution&&m.role==='worker'?`${execution.model} · requested native effort ${execution.nativeReasoningEffort} · effective effort unknown`:`gpt-6-luna · ${m.role==='worker'?'high':m.role==='simple'?'xhigh':m.role==='router'?'low · Fast':'high'}`}</span>}</div><div className="message-body markdown-body"><Markdown>{m.text}</Markdown></div></div></div>;
}

function ActivityRow({item}:{item:LiveActivity}){
  if(item.kind==='commentary')return <div className="live-activity-row commentary" data-activity-id={item.itemId}><span className="live-activity-icon"><Activity size={14}/></span><div className="live-activity-main"><div className="live-commentary-text">{item.text||'Preparing response…'}</div></div></div>;
  const label=item.status==='running'?`Running ${item.title}`:item.status==='failed'?`Failed ${item.title}`:item.status==='interrupted'?`Interrupted ${item.title}`:`Ran ${item.title}`;
  const details=[item.detail,item.output].filter(Boolean).join('\n\n');
  return <div className={`live-activity-row tool ${item.status}`} data-activity-id={item.itemId}><span className="live-activity-icon">{item.status==='running'?<span className="activity-spinner"/>:item.status==='failed'?<AlertCircle size={14}/>:<Check size={14}/>}</span><div className="live-activity-main"><div className="live-activity-title">{label}</div>{details&&<details className="live-activity-details"><summary>Details</summary><pre>{details}</pre></details>}</div></div>;
}
function ReasoningResponse({turn,summaries,activities,live,fallbackTime}:{turn:NonNullable<TaskPass['reasoningTurns']>[number];summaries:NonNullable<TaskPass['reasoningSummaries']>;activities:LiveActivity[];live:boolean;fallbackTime:string}){
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{if(!live)return;const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[live]);
  const turnSummaries=summaries.filter(x=>x.role===turn.role&&x.threadId===turn.threadId&&x.turnId===turn.turnId&&x.text.trim());
  const activity=activities.filter(x=>x.role===turn.role&&x.threadId===turn.threadId&&x.turnId===turn.turnId);
  const events=[...turnSummaries.map(summary=>({kind:'summary' as const,at:Date.parse(summary.updatedAt||turn.startedAt||fallbackTime)||0,index:summary.summaryIndex,summary})),...activity.map((item,index)=>({kind:'activity' as const,at:Date.parse(item.startedAt)||0,index,item}))].sort((a,b)=>a.at-b.at||a.index-b.index);
  const elapsedSeconds=Math.max(0,Math.floor((clock-Date.parse(turn.startedAt||fallbackTime))/1000));
  const elapsed=elapsedSeconds>=3600?`${Math.floor(elapsedSeconds/3600)}h`:elapsedSeconds>=60?`${Math.floor(elapsedSeconds/60)}m`:`${elapsedSeconds}s`;
  const durationLabel=turn.status==='interrupted'?'Interrupted after':turn.status==='failed'?'Failed after':live?'Working for':'Worked for';
  const turnLabel=turn.provider?`DeepSeek Harness worker · ${turn.provider}`:turn.role==='worker'?'Luna worker':turn.role==='orchestrator'?'Orchestrator':'GPT-6 Luna';
  const modelLabel=turn.provider?`${turn.provider} / ${turn.requestedModel} · requested native effort ${turn.requestedEffort} · effective effort unknown`:`${turn.requestedModel} · ${turn.requestedEffort}`;
  return <section className={`turn-activity ${live?'is-live':''}`} aria-label={`${turn.role} model response`} data-status={turn.status}>
    <header className="turn-activity-heading"><span>{turnLabel}</span><span className="turn-activity-duration">{durationLabel} {elapsed}</span>{turn.role!=='orchestrator'&&<span className="model-chip">{modelLabel}</span>}</header>
    <div className="turn-activity-events">{events.map(event=>event.kind==='summary'?<div className="live-activity-row commentary summary" key={`summary:${event.summary.itemId}:${event.summary.summaryIndex}`}><span className="live-activity-icon"><Command size={14}/></span><div className="live-activity-main"><div className="markdown-body"><Markdown>{event.summary.text}</Markdown></div></div></div>:<ActivityRow key={`activity:${event.item.itemId}`} item={event.item}/>)}{!events.length&&<div className="reasoning-response-empty">{live?'Waiting for activity…':turn.status==='failed'?'Turn failed.':turn.status==='interrupted'?'Turn interrupted.':'No activity details were reported for this turn.'}</div>}</div>
  </section>;
}

function PassPanel({pass:p,messages,active,task,assignmentExpanded,receiptExpanded,workerActivityExpanded,agentmemAuditExpanded,retrying,selectedSteerWorkerId,onRetryAgentMem,onSelectSteerWorker,toggleAssignment,toggleReceipt,toggleWorkerActivity,toggleAgentMemAudit}:{pass:TaskPass;messages:Message[];active:boolean;task:Task;assignmentExpanded:boolean;receiptExpanded:boolean;workerActivityExpanded:boolean;agentmemAuditExpanded:boolean;retrying:boolean;selectedSteerWorkerId?:string;onRetryAgentMem:()=>void;onSelectSteerWorker:(workerId:string)=>void;toggleAssignment:()=>void;toggleReceipt:()=>void;toggleWorkerActivity:()=>void;toggleAgentMemAudit:()=>void}){
  const live=active&&task.phase===p.phase&&['routing','direct_running','simple_running','planning','worker_running','reviewing'].includes(p.phase);
  const recruitedExecution=p.recruitmentTeam?p.deepSeekExecution:undefined;
  const recruitedWorkerLabel=recruitedExecution?`${recruitedExecution.provider} / ${recruitedExecution.model} · requested native effort ${recruitedExecution.nativeReasoningEffort} · effective effort unknown`:'gpt-6-luna · high';
  const output=p.publicAnswer||p.receipt?.result||'';
  const visibleMessages=messages.filter(m=>!(m.role==='orchestrator'&&m.text==='Prepared a complete assignment.'&&(p.reasoningTurns||[]).some(turn=>turn.role==='orchestrator'))&&!(output&&m.role!=='user'&&m.text===output)&&!(p.error&&m.role==='system'&&m.text===p.error));
  const turns=p.reasoningTurns||[];const directTurn=turns.filter(turn=>turn.role==='direct'&&turn.threadId===p.directThreadId).at(-1);const directOutputLabel=directTurn?`${directTurn.requestedModel==='gpt-6-luna'?'GPT-6 Luna':directTurn.requestedModel}${directTurn.requestedEffort?` · ${directTurn.requestedEffort}`:''}`:p.directThreadId?'GPT-6 Luna':'Orchestrator';const timeline=[...visibleMessages.map((message,index)=>({kind:'message' as const,at:Date.parse(message.createdAt)||0,index,message})),...turns.map((turn,index)=>{const roleTurns=turns.filter(item=>item.role===turn.role);const roleMessages=visibleMessages.filter(message=>message.role===turn.role);const roleIndex=roleTurns.findIndex(item=>item.threadId===turn.threadId&&item.turnId===turn.turnId);const matchingMessage=roleMessages[roleIndex];const latestUser=visibleMessages.filter(message=>message.role==='user').at(-1);const fallbackAt=matchingMessage?(Date.parse(matchingMessage.createdAt)||0)-1:(Date.parse(latestUser?.createdAt||p.createdAt)||0)+1;return {kind:'reasoning' as const,at:Date.parse(turn.startedAt||'')||fallbackAt,index,turn};})].sort((a,b)=>a.at-b.at||(a.kind!==b.kind?(a.kind==='reasoning'?-1:1):a.index-b.index));
  const workerRows=timeline.filter(row=>row.kind==='reasoning'?row.turn.role==='worker':row.message.role==='worker'||row.message.role==='system'&&row.message.text.startsWith('Worker activity:'));
  const workerActivityCount=workerRows.reduce((count,row)=>count+(row.kind==='reasoning'?Math.max(1,(p.reasoningSummaries||[]).filter(item=>item.role===row.turn.role&&item.threadId===row.turn.threadId&&item.turnId===row.turn.turnId).length+(p.liveActivity||[]).filter(item=>item.role===row.turn.role&&item.threadId===row.turn.threadId&&item.turnId===row.turn.turnId).length):1),0);
  const visibleTimeline=timeline.filter(row=>row.kind==='reasoning'?row.turn.role!=='worker':row.message.role!=='worker'&&!(row.message.role==='system'&&row.message.text.startsWith('Worker activity:')));
  const recordStatus=p.agentmemRecordStatus||(p.agentmemTaskId?undefined:task.agentmemRecordStatus);
  const recordError=p.agentmemRecordError||(p.agentmemTaskId?undefined:task.agentmemRecordError);
  return <section className={`pass-panel ${p.legacyUnassociated?'legacy-pass':''}`} aria-label={p.legacyUnassociated?'Legacy pass with unassociated history':`Pass ${p.index}`}>
    <header className="pass-heading"><span>{p.legacyUnassociated?'Legacy history':`Pass ${p.index}`}</span><span className={`pass-status ${p.phase}`}>{phaseText[p.phase]||p.phase}</span><time>{stamp(p.createdAt)}</time></header>
    {p.legacyUnassociated&&<div className="legacy-association-note">This older session predates per-pass records. Its messages and saved artifacts cannot be reliably matched, so they are shown as unassociated history.</div>}
    {((p.selectedSkills?.length||0)+(p.loadedSkills?.length||0)>0)&&<div className="pass-skill-provenance"><strong>Saved skills used</strong>{[...(p.selectedSkills||[]).map(skill=>({...skill,usage:'Invoked by you'})),...(p.loadedSkills||[]).map(skill=>({...skill,usage:`Loaded${skill.role?` by ${skill.role}`:''}`}))].map((skill,index)=><details key={`${skill.id}:${skill.revision}:${skill.usage}:${index}`}><summary>{skill.name} · {skill.usage} · {skill.revision.slice(0,12)}</summary><small>{skill.source}</small><pre>{skill.instructions}</pre></details>)}</div>}{(p.savedSkills?.length||0)>0&&<div className="pass-skill-provenance"><strong>Skills saved by agents</strong>{p.savedSkills!.map((skill,index)=><div key={`${skill.id}:${skill.revision}:${index}`}><span>{skill.name} · {skill.action} · {skill.revision.slice(0,12)}</span><small>{skill.source} · {skill.role}</small></div>)}</div>}
    {visibleTimeline.map(row=>row.kind==='message'?<ConversationMessage key={row.message.id} message={row.message} execution={recruitedExecution}/>:<ReasoningResponse key={`${row.turn.threadId}:${row.turn.turnId}`} turn={row.turn} summaries={p.reasoningSummaries||[]} activities={p.liveActivity||[]} live={live&&p.activeRole===row.turn.role&&p.activeTurnId===row.turn.turnId} fallbackTime={p.createdAt}/>)}
    {workerRows.length>0&&<div className="worker-activity"><Disclosure title={`${recruitedExecution?'DeepSeek Harness':'Luna'} activity · ${live&&p.activeRole==='worker'?'live · ':''}${workerActivityCount} ${workerActivityCount===1?'item':'items'}`} icon={<Terminal size={15}/>} open={workerActivityExpanded} onToggle={toggleWorkerActivity}><div className="worker-activity-scroll">{workerRows.map(row=>row.kind==='message'?<ConversationMessage key={row.message.id} message={row.message} execution={recruitedExecution}/>:<ReasoningResponse key={`${row.turn.threadId}:${row.turn.turnId}`} turn={row.turn} summaries={p.reasoningSummaries||[]} activities={p.liveActivity||[]} live={live&&p.activeRole==='worker'&&p.activeTurnId===row.turn.turnId} fallbackTime={p.createdAt}/>)}</div></Disclosure></div>}
    {p.simpleThreadId&&<div className="worker-status" role="status">{p.phase==='simple_running'?<div className="activity-spinner"/>:<Check size={17} className="worker-activity-icon"/>}<strong>{p.phase==='simple_running'?'Simple implementation is working':'Simple implementation complete'}</strong><span className="worker-model">GPT-6 Luna · xhigh</span><span className={`worker-state ${p.phase}`}>{p.phase==='simple_running'?'Verifying · no Sol review':'Self-verified · no Sol review'}</span></div>}{(p.assignment||p.workerThreadId||p.receipt)&&p.resolution!=='direct'&&p.resolution!=='simple'&&<div className="worker-status" role="status">{p.phase==='worker_running'?<div className="activity-spinner"/>:<Activity size={17} className="worker-activity-icon"/>}<strong>{p.phase==='worker_running'?'Worker is working':p.phase==='accepted'?'Worker review':'Worker task'}</strong><span className="worker-model">{recruitedWorkerLabel}</span><span className={`worker-state ${p.phase}`}>{p.phase==='accepted'&&p.receipt?'Complete':p.phase==='worker_running'?p.workerStage==='context_plan'?'Composing scope context · orchestrator idle':p.workerStage==='context_compose'?`${p.workerContextStatus?.status==='retrieved'?'Reviewing retrieved context':p.workerContextStatus?.status==='disabled'?'AgentMem disabled · composing context':'AgentMem unavailable · composing context'} · orchestrator idle`:p.workerStage==='execute'?'Executing assignment · orchestrator idle':'Preparing worker · orchestrator idle':phaseText[p.phase]||p.phase}</span></div>}
    {p.recruitmentTeam&&<RecruitmentTeamPanel team={{teamId:p.recruitmentTeam.teamId,status:p.recruitmentTeam.status,workers:p.recruitmentTeam.workers.map(worker=>({workerId:worker.workerId,name:worker.name,status:worker.status,canSteer:!!worker.activeTurnId&&!worker.deepSeekExecution,effort:worker.effort,branch:worker.branch,worktreePath:worker.worktreeRoot,assignment:worker.assignment,receipt:worker.receipt,error:worker.error,deepSeekExecution:worker.deepSeekExecution,deepSeekRuntime:worker.deepSeekRuntime,deepSeekPhaseRuns:worker.deepSeekPhaseRuns})),integration:{status:p.recruitmentTeam.integration.status,canSteer:!!p.recruitmentTeam.integration.activeTurnId&&!p.recruitmentTeam.integration.deepSeekExecution,branch:p.recruitmentTeam.integration.branch,worktreePath:p.recruitmentTeam.integration.worktreeRoot,receipt:p.recruitmentTeam.integration.receipt,error:p.recruitmentTeam.integration.error,deepSeekExecution:p.recruitmentTeam.integration.deepSeekExecution,deepSeekRuntime:p.recruitmentTeam.integration.deepSeekRuntime,deepSeekPhaseRuns:p.recruitmentTeam.integration.deepSeekPhaseRuns}}} selectedWorkerId={selectedSteerWorkerId} onSelectSteerWorker={active?onSelectSteerWorker:undefined}/>}
    {p.assignment&&<Disclosure title="Assignment" icon={<FileText size={15}/>} open={assignmentExpanded} onToggle={toggleAssignment}><AssignmentView assignment={p.assignment}/></Disclosure>}
    <Disclosure title={agentMemAuditTitle(p)} icon={<Database size={15}/>} open={agentmemAuditExpanded} onToggle={toggleAgentMemAudit}><AgentMemAuditView pass={p}/></Disclosure>
    {p.escalation&&<div className="escalation-card"><div className="escalation-head"><AlertCircle size={16}/><strong>Worker needs a decision</strong></div><p>{p.escalation.decision_needed}</p>{p.escalation.evidence?.map((x:string,i:number)=><div className="escalation-detail" key={i}>{x}</div>)}<div className="escalation-options">{p.escalation.options?.map((x:string,i:number)=><span key={i}>{x}</span>)}</div>{p.escalation.recommendation&&<p className="rec-line"><b>Recommendation:</b> {p.escalation.recommendation}</p>}</div>}
    {p.reviewNote&&<div className={`review-outcome ${p.phase}`}><span>{p.phase==='accepted'?<Check size={15}/>:<AlertCircle size={15}/>}</span><div><strong>{p.phase==='accepted'?(p.resolution==='direct'?'Direct answer':p.resolution==='simple'?'Simple implementation complete':'Receipt accepted'):phaseText[p.phase]}</strong><div className="markdown-body"><Markdown>{p.reviewNote}</Markdown></div>{p.resolution==='direct'&&p.routingNote&&<small className="routing-note">Routing basis: {p.routingNote}</small>}</div></div>}
    {p.phase==='accepted'&&task.agentmemProjectId&&recordStatus&&recordStatus!=='done'&&<div className={`agentmem-pass-status ${recordStatus==='failed'?'is-error':''}`} role="status"><span>{recordStatus==='saving'?'Saving AgentMem receipt…':recordStatus==='failed'?'AgentMem save failed':recordStatus==='in_progress'?'Receipt saved · AgentMem task still open':recordStatus==='released'?'AgentMem lease released':'Checking AgentMem receipt status…'}</span>{recordError&&<small>{recordError}</small>}{p.agentmemTaskId&&(recordStatus==='failed'||recordStatus==='in_progress')&&<button className="text-button" disabled={retrying} onClick={onRetryAgentMem}>{retrying?'Retrying…':'Retry AgentMem completion'}</button>}</div>}
    {p.error&&<div className="error-card"><AlertCircle size={16}/><div><strong>{p.phase==='needs_attention'?'Action needed':'Workflow error'}</strong><p>{p.error}</p>{p.phase==='paused_after_restart'&&<small>Send an explicit update to reattach the saved threads and continue.</small>}</div></div>}
    <PassUsagePanel pass={p}/>
    {output&&<section className="final-artifact" aria-label="Final output"><header><FileText size={16}/><strong>Final output</strong><span>{p.resolution==='direct'?directOutputLabel:p.resolution==='simple'?'GPT-6 Luna · xhigh · self-verified':recruitedExecution?`DeepSeek Harness (${recruitedExecution.provider}) · reviewed by orchestrator`:'Luna · reviewed by orchestrator'}</span></header><div className="final-artifact-body markdown-body"><Markdown>{output}</Markdown></div></section>}
    <Disclosure title="Run receipt · repository and knowledge base changes" icon={<Check size={15}/>} open={receiptExpanded} onToggle={toggleReceipt}><RunReceipt pass={p} taskId={task.id}/></Disclosure>
  </section>;
}

function agentMemAuditTitle(pass:TaskPass){const audit=pass.agentmemAudit;if(!audit?.recorded)return 'AgentMem usage · historical record unavailable';const app=audit.calls.filter(call=>call.source==='application').length;const model=audit.calls.filter(call=>call.source==='model').length;return `AgentMem usage · ${model} model calls · ${app} app calls`;}
function AgentMemAuditView({pass}:{pass:TaskPass}){
  const audit=pass.agentmemAudit;
  if(!audit?.recorded)return <div className="agentmem-audit-unknown" role="status">This pass predates AgentMem call auditing. Model-issued MCP calls and app-provided context were not recorded, so usage is unknown.</div>;
  const modelStatus=audit.modelMcpStatus==='observed'?'Model-issued AgentMem MCP calls were observed.':audit.modelMcpStatus==='disabled'?'AgentMem MCP was disabled for this pass.':audit.modelMcpStatus==='available'?'AgentMem MCP was available to execution roles; no call has been recorded yet.':audit.modelMcpStatus==='unavailable'?'AgentMem MCP was unavailable to the execution runtime.':audit.modelMcpStatus==='no_calls_observed'?'No AgentMem MCP call was observed for this pass.':'Model MCP availability and usage are unknown.';
  const identity=audit.identityStatus==='verified'?`Verified: ${audit.verifiedProjectId||audit.selectedProjectId} ↔ ${audit.verifiedRoot||audit.workspaceRoot}`:audit.identityStatus==='disabled'?'No AgentMem project was selected for this pass.':audit.identityStatus==='mismatch'?`Project identity mismatch. Selected: ${audit.selectedProjectId||'none'}; workspace: ${audit.workspaceRoot}.`:`Selected: ${audit.selectedProjectId||'none'} ↔ ${audit.workspaceRoot} · ${audit.identityStatus}.`;
  return <div className="agentmem-audit" data-model-mcp-status={audit.modelMcpStatus}>
    <p className={audit.identityStatus==='mismatch'||audit.identityStatus==='unavailable'?'is-error':''}><strong>Selected knowledge base:</strong> {identity}</p>
    <p><strong>Selected repository index:</strong> {audit.verifiedRepositoryId||'Not verified for this pass'}</p>
    <p><strong>Model-issued MCP:</strong> {modelStatus}</p>
    {audit.coverage==='from_first_recorded_call'&&<p>This older pass was only audited from its first newly observed call; earlier AgentMem usage is unknown.</p>}
    {audit.contexts.length>0&&<section><strong>App context retrieval</strong><ul>{audit.contexts.map(context=><li key={context.id}><span>{context.role} · {context.purpose} · {context.status==='supplied'?'supplied to model':context.status}</span><small>{auditStamp(context.startedAt)}{context.threadId&&context.turnId?` · turn ${context.turnId}`:''}</small>{context.resultSummary&&<small>{context.resultSummary}</small>}{context.error&&<small className="is-error">{context.error}</small>}</li>)}</ul></section>}
    {audit.calls.length>0&&<section><strong>Observed MCP calls</strong><ul>{audit.calls.map(call=><li key={call.id}><span>{call.source==='model'?'Model':'App'} · {call.method} · {call.status}</span><small>{call.service?`${call.service.replace('_',' ')} · `:''}{call.operation?`${call.operation} · `:''}{call.role}{call.purpose?` · ${call.purpose}`:''}{call.projectId?` · KB ${call.projectId}`:''}{call.repositoryId?` · repo ${call.repositoryId}`:''}{call.turnId?` · turn ${call.turnId}`:''} · {auditStamp(call.startedAt)}</small>{call.resultSummary&&<small>{call.resultSummary}</small>}{call.error&&<small className="is-error">{call.error}</small>}</li>)}</ul></section>}
    {!audit.contexts.length&&!audit.calls.length&&<p>No AgentMem context retrieval or tool call was recorded for this pass.</p>}
  </div>;
}

const tokenCount=(value:number)=>new Intl.NumberFormat(undefined).format(value);
function formatMicros(value:string|undefined,unit:'credits'|'USD'){
  if(value===undefined)return null;
  try{
    const amount=BigInt(value);const whole=amount/1_000_000n;const fraction=(amount%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');
    const numeric=`${whole.toLocaleString()}${fraction?`.${fraction}`:''}`;
    return unit==='USD'?`~$${numeric}`:`~${numeric} credits`;
  }catch{return null;}
}
function PassUsagePanel({pass}:{pass:TaskPass}){
  const usage=pass.usage||{};const allRoles:[keyof typeof usage,string][]=[['router','Router · Luna low · Fast'],['direct','Direct · Luna high'],['simple','Simple · Luna xhigh'],['orchestrator','Orchestrator'],['worker','Luna worker']];
  const expected=allRoles.filter(([role])=>role==='router'?!!pass.routerThreadId:role==='direct'?!!pass.directThreadId:role==='simple'?!!pass.simpleThreadId:role==='orchestrator'?!!pass.orchestratorThreadId:!!pass.workerThreadId||pass.resolution==='delegated');
  const roles=allRoles.filter(([role])=>expected.some(([candidate])=>candidate===role)||!!usage[role]);
  const complete=['accepted','cancelled','escalated','needs_attention','paused_after_restart'].includes(pass.phase);
  if(!complete)return null;
  const availableTokens=expected.map(([role,label])=>({role,label,value:usage[role]})).filter(x=>x.value?.tokens&&x.value.tokenStatus==='available');
  const availableCredits=expected.map(([role,label])=>({role,label,value:usage[role]})).filter(x=>x.value?.creditStatus==='available'&&x.value.estimatedCreditsMicros!==undefined);
  const allTokensAvailable=expected.length>0&&availableTokens.length===expected.length;
  const allCreditsAvailable=expected.length>0&&availableCredits.length===expected.length;
  const totalTokens=availableTokens.reduce((sum,row)=>sum+(row.value?.tokens?.totalTokens||0),0);
  const credits=availableCredits.reduce((sum,row)=>sum+BigInt(row.value!.estimatedCreditsMicros!),0n).toString();
  const dollars=allCreditsAvailable&&availableCredits.every(row=>row.value?.estimatedUsdMicros!==null&&row.value?.estimatedUsdMicros!==undefined)?availableCredits.reduce((sum,row)=>sum+BigInt(row.value!.estimatedUsdMicros!),0n).toString():undefined;
  const tokenPending=expected.some(([role])=>usage[role]?.tokenStatus==='pending');
  const creditPending=expected.some(([role])=>usage[role]?.creditStatus==='pending');
  const tokenHeadline=availableTokens.length?`${pass.phase==='accepted'&&allTokensAvailable?'':'Recorded '}${tokenCount(totalTokens)} tokens`:tokenPending?'Collecting…':'Unavailable';
  const creditValue=(dollars?formatMicros(dollars,'USD'):formatMicros(credits,'credits'))||'Unavailable';
  const creditHeadline=pass.phase==='accepted'&&allCreditsAvailable?creditValue:availableCredits.length?`Recorded so far · ${creditValue}`:creditPending?'Collecting…':'Unavailable';
  const fiveHourValues=expected.map(([role])=>usage[role]?.allowance?.fiveHourPercent).filter((value):value is number=>value!==null&&value!==undefined);
  const weeklyValues=expected.map(([role])=>usage[role]?.allowance?.weeklyPercent).filter((value):value is number=>value!==null&&value!==undefined);
  const allowanceValue=(values:number[])=>values.length?`~${values.reduce((sum,value)=>sum+value,0).toFixed(2)}%${values.length<expected.length?' partial':''}`:'unavailable';
  const allowanceHeadline=`5-hour ${allowanceValue(fiveHourValues)} · weekly ${allowanceValue(weeklyValues)}`;
  const detail=(role:keyof typeof usage,label:string,metric:'tokens'|'cost'|'allowance')=>{
    const entry=usage[role];const expectedRole=expected.some(([candidate])=>candidate===role);
    if(!expectedRole)return `${label}: not used`;
    if(metric==='tokens')return entry?.tokens&&entry.tokenStatus==='available'?`${label}: ${tokenCount(entry.tokens.totalTokens)} tokens`:`${label}: ${entry?.tokenStatus==='unavailable'?'unavailable':'not reported'}`;
    if(metric==='cost')return entry?.creditStatus==='available'?`${label}: ${formatMicros(entry.estimatedUsdMicros||undefined,'USD')||formatMicros(entry.estimatedCreditsMicros,'credits')} (Codex estimate${entry.groups?.length?`; ${entry.groups.map(group=>[group.model,group.reasoningEffort,group.speed].filter(Boolean).join(' · ')).join(', ')}`:''})`:`${label}: ${entry?.creditStatus==='unavailable'?'unavailable':'not reported'}`;
    const allowance=entry?.allowance;
    return `${label}: 5-hour ${allowance?.fiveHourPercent===null||allowance?.fiveHourPercent===undefined?'unavailable':`~${allowance.fiveHourPercent.toFixed(2)}%`}; weekly ${allowance?.weeklyPercent===null||allowance?.weeklyPercent===undefined?'unavailable':`~${allowance.weeklyPercent.toFixed(2)}%`}`;
  };
  const Datum=({label,value,metric}:{label:string;value:string;metric:'tokens'|'cost'|'allowance'})=>{const tooltipId=`pass-usage-${pass.id}-${metric}`;return <span className="pass-usage-datum" tabIndex={0} aria-label={`${label}: ${value}`} aria-describedby={tooltipId}><strong>{label}</strong><span>{value}</span><span id={tooltipId} className="pass-usage-tooltip" role="tooltip">{roles.map(([role,name])=><span key={`${metric}-${role}`}>{detail(role,name,metric)}</span>)}{metric==='allowance'&&<small>Approximate change in the shared Codex account snapshot during each role’s turns; activity in other Codex clients can affect it.</small>}</span></span>;};
  return <section className="pass-usage" aria-label={`Usage summary for pass ${pass.index}`}>
    <strong className="pass-usage-title">Pass usage</strong><div className="pass-usage-summary">
      <Datum label="Total tokens" value={tokenHeadline} metric="tokens"/>
      <Datum label="Estimated cost" value={creditHeadline} metric="cost"/>
      <Datum label="Codex allowance" value={allowanceHeadline} metric="allowance"/>
      <small>Codex-reported estimates; allowance percentages are approximate shared-account snapshot changes.</small>
    </div>
  </section>;
}
function ApprovalCard({request,onDecision}:{request:any;onDecision:(decision:'accept'|'decline'|'cancel',content?:Record<string,unknown>)=>void}){const [contentText,setContentText]=useState('{}');const [contentError,setContentError]=useState('');const permission=request.method==='item/permissions/requestApproval';const elicitation=request.method==='mcpServer/elicitation/request';const accept=()=>{if(!elicitation||request.mode==='url'||!request.requestedSchema){onDecision('accept');return;}try{const value=JSON.parse(contentText||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Response must be a JSON object.');onDecision('accept',value as Record<string,unknown>);setContentError('');}catch(error){setContentError(error instanceof Error?error.message:'Enter a valid JSON object.');}};return <section className="approval-card" aria-label={elicitation?'MCP server input request':'Codex approval needed'}><div className="approval-heading"><ShieldCheck size={15}/><strong>{elicitation?'MCP server needs your input':'Approval needed'}</strong><span>{elicitation?`${request.serverName||'MCP server'} · ${request.mode||'form'}`:permission?'Permission request':request.method.includes('fileChange')?'File change':'Command execution'}</span></div>{(elicitation?request.message:request.reason)&&<p>{elicitation?request.message:request.reason}</p>}{request.url&&elicitation&&<div className="approval-meta">Requested URL: {request.url}</div>}{elicitation&&request.requestedSchema&&<><div className="approval-meta">Requested fields</div><pre className="permission-preview">{JSON.stringify(request.requestedSchema,null,2)}</pre><label className="approval-form-label">Response JSON<textarea value={contentText} onChange={event=>{setContentText(event.target.value);setContentError('');}} spellCheck={false} aria-label="MCP response JSON" /></label>{contentError&&<div role="alert" className="approval-error">{contentError}</div>}</>}{request.command&&<pre>{request.command}</pre>}{request.networkHost&&<div className="approval-meta">Network destination: {request.networkHost} ({request.networkProtocol})</div>}{request.cwd&&<div className="approval-meta">Working directory: {request.cwd}</div>}{request.grantRoot&&<div className="approval-meta">Requested write root: {request.grantRoot}</div>}{permission&&<pre className="permission-preview">{JSON.stringify(request.permissionRequest,null,2)}</pre>}<div className="approval-actions"><button onClick={()=>onDecision('decline')}>Decline</button><button onClick={()=>onDecision('cancel')}>Cancel turn</button><button className="approval-accept" onClick={accept}>{elicitation?'Send response':permission?'Grant requested permissions':'Approve once'}</button></div></section>}
function Disclosure({title,icon,open,onToggle,children}:{title:string;icon:React.ReactNode;open:boolean;onToggle:()=>void;children:React.ReactNode}){return <div className={`disclosure ${open?'open':''}`}><button className="disclosure-head" onClick={onToggle} aria-expanded={open}><span className="disclosure-icon">{icon}</span><strong>{title}</strong><ChevronDown size={14} className="disclosure-chevron"/><span className="disclosure-spacer"/></button><div className="disclosure-panel" aria-hidden={!open} inert={!open}><div className="disclosure-panel-inner"><div className="disclosure-content">{children}</div></div></div></div>}
function AssignmentView({assignment:a}:{assignment:Assignment}){const data:[string,string[]][]=[['Outcome',[a.outcome,a.deliverable]],['Authorized read scope',a.read_scope],['Authorized write scope',a.write_scope],['Constraints',a.constraints],['Acceptance',a.acceptance],['Verification',a.verification],['Escalate when',a.escalation_conditions],['Exclusions',a.exclusions]];return <div className="assignment-grid">{data.map(([label,items])=><div key={label} className="assignment-block"><span>{label}</span><ul>{items.map((x,i)=><li key={i}>{x}</li>)}</ul></div>)}</div>;}
function RunReceipt({pass:p,taskId}:{pass:TaskPass;taskId:string}){
  const receipt=p.receipt;
  return <div className="run-receipt-content">
    <div className={`receipt-status ${receipt?.status||'unavailable'}`}>{receipt?.status||'No worker receipt'}</div>
    {!receipt?<p className="receipt-unavailable">This pass has no Pseudoharness worker receipt to summarize.</p>:<>
      <PassGitDiff key={`${taskId}:${p.id}`} taskId={taskId} passId={p.id}/>
      {p.receiptProvenance?<p className="receipt-provenance">Produced by {p.receiptProvenance.producerRole} · turn {p.receiptProvenance.turnId} · {p.receiptProvenance.artifactRefs.length} artifact references</p>:<p className="receipt-provenance">Producer and turn provenance is unavailable for this historical receipt.</p>}
      {(p.agentReceipts?.length||0)>1&&<section className="agent-receipt-history"><b>Receipts from artifact-producing turns</b>{p.agentReceipts!.map(record=><details key={`${record.producerRole}:${record.threadId}:${record.turnId}`}><summary>{record.producerRole} · turn {record.turnId} · {record.receipt.status}</summary><p>{record.receipt.result}</p><div><b>Artifact references</b>{list(record.artifactRefs)}</div><div><b>Knowledge and index updates</b>{list(record.receipt.knowledge.updated)}</div></details>)}</section>}
      {!!p.turnSourceChanges?.length&&<section className="source-turn-audit"><b>Workspace changes verified by artifact turn</b><ul>{p.turnSourceChanges.map(source=><li key={`${source.role}:${source.threadId}:${source.turnId}`}><span>{source.role} · turn {source.turnId} · {source.status}</span><small>{source.changedPaths.length?source.changedPaths.join(', '):source.repositoryRevisionChanged?'Repository revision changed':'No workspace source changes detected'}{source.reason&&` · ${source.reason}`}</small></li>)}</ul></section>}
      <div className="receipt-change-grid"><div><b>Worker-reported repository changes</b>{list(receipt.changes)}</div><div><b>Knowledge base changes</b>{list(receipt.knowledge?.updated)}</div></div>
      <div className="receipt-acceptance-grid"><div><b>Acceptance met</b>{list(receipt.acceptance?.met)}</div><div><b>Unmet</b>{list(receipt.acceptance?.unmet)}</div></div>
      <div className="receipt-verification"><b>Verification</b>{receipt.verification?.length?<ul>{receipt.verification.map((item,index)=><li key={index}><span className={`check-state ${item.result}`}>{item.result==='passed'?'✓':item.result==='failed'?'!':'·'}</span><span>{item.check}{item.evidence&&<small>{item.evidence}</small>}</span></li>)}</ul>:<div className="none">Not reported</div>}</div>
      {receipt.risks?.length>0&&<div className="receipt-risks"><b>Risks and limits</b>{list(receipt.risks)}</div>}
      {receipt.decision_required&&<div className="decision-line">Decision required: {receipt.decision_required}</div>}
    </>}
  </div>;
}
function list(items:string[]=[]){return items.length?<ul>{items.map((v,i)=><li key={i}>{v}</li>)}</ul>:<div className="none">None</div>;}
