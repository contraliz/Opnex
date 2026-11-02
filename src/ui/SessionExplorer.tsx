import { useRef, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import type { ReactNode } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Keyboard,
  Pin,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { SessionRow } from './SessionControls';
import { workspaceOptionLabel } from './workspace-label';
import type { Project, Task } from '../types';

type SessionExplorerProps = {
  tasks: Task[];
  projects: Project[];
  selectedProject: Project | null;
  expandedProjectIds: string[];
  activeTaskIds: string[];
  sidebarCollapsed: boolean;
  query: string;
  setQuery: (query: string) => void;
  showAllProjects: Record<string, boolean>;
  setShowAllProjects: Dispatch<SetStateAction<Record<string, boolean>>>;
  projectMoveError: string;
  onClearProjectMoveError: () => void;
  projectDropTarget: string | null;
  setProjectDropTarget: (target: string | null) => void;
  archivedExpanded: boolean;
  setArchivedExpanded: Dispatch<SetStateAction<boolean>>;
  onSelectTask: (id: string) => void;
  onOpenSessionDialog: (kind: 'rename' | 'delete', taskId: string) => void;
  onPinTask: (task: Task, pinned: boolean) => void;
  onArchiveTask: (task: Task, archived: boolean) => void;
  onMoveSessionToProject: (taskId: string, projectId: string | null) => void;
  onDragSession: (event: DragEvent<HTMLDivElement>, task: Task) => void;
  onDropSessionInto: (event: DragEvent<HTMLElement>, projectId: string | null) => void;
  onToggleProjectExpanded: (id: string) => void;
  onStartNewSessionInProject: (projectId: string) => void;
  onOpenNewTab: () => void;
  onOpenProjectEditor: (project: Project | 'new') => void;
  onPinProject: (projectId: string, pinned: boolean) => void;
  onOpenShortcuts: () => void;
};

function ExpandableSessionRows({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  return (
    <div
      className={`project-session-rows ${expanded ? 'open' : 'closed'}`}
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className='project-session-rows-content'>{children}</div>
    </div>
  );
}

export function SessionExplorer({
  tasks,
  projects,
  selectedProject,
  expandedProjectIds,
  activeTaskIds,
  sidebarCollapsed,
  query,
  setQuery,
  showAllProjects,
  setShowAllProjects,
  projectMoveError,
  onClearProjectMoveError,
  projectDropTarget,
  setProjectDropTarget,
  archivedExpanded,
  setArchivedExpanded,
  onSelectTask,
  onOpenSessionDialog,
  onPinTask,
  onArchiveTask,
  onMoveSessionToProject,
  onDragSession,
  onDropSessionInto,
  onToggleProjectExpanded,
  onStartNewSessionInProject,
  onOpenNewTab,
  onOpenProjectEditor,
  onPinProject,
  onOpenShortcuts,
}: SessionExplorerProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionMatches = (task: Task) =>
    !query.trim() || task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const sortSessions = (a: Task, b: Task) =>
    Number(!!b.pinned) - Number(!!a.pinned) ||
    (Date.parse(b.lastInteractedAt || b.createdAt) || 0) -
      (Date.parse(a.lastInteractedAt || a.createdAt) || 0);
  const matchingTasks = tasks
    .filter((task) => !task.archived && sessionMatches(task))
    .sort(sortSessions);
  const archivedTasks = tasks
    .filter((task) => task.archived && sessionMatches(task))
    .sort(sortSessions);
  const orderedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name)
  );
  const unclassifiedTasks = matchingTasks.filter(
    (task) => !task.projectId || !projects.some((project) => project.id === task.projectId)
  );
  const renderSessionRows = (rows: Task[], archived = false) =>
    rows.map((task) => (
      <SessionRow
        key={task.id}
        task={task}
        archived={archived}
        selected={activeTaskIds.includes(task.id)}
        onSelect={onSelectTask}
        onSessionAction={onOpenSessionDialog}
        onPin={onPinTask}
        onArchive={onArchiveTask}
        onMoveStart={task.sessionType === 'forge' ? undefined : onDragSession}
        projects={projects}
        onMove={task.sessionType === 'forge' ? undefined : onMoveSessionToProject}
      />
    ));
  const projectSessionSection = (project: Project) => {
    const projectTasks = matchingTasks.filter((task) => task.projectId === project.id);
    const expanded = expandedProjectIds.includes(project.id);
    const shown = showAllProjects[project.id] ? projectTasks : projectTasks.slice(0, 5);
    const label = workspaceOptionLabel(project, projects);
    return (
      <section
        className={`project-session-group ${expanded ? 'expanded' : ''} ${projectDropTarget === project.id ? 'is-drop-target' : ''}`}
        key={project.id}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('application/x-opnex-session-project'))
            setProjectDropTarget(project.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setProjectDropTarget(null);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-opnex-session-project'))
            event.preventDefault();
        }}
        onDrop={(event) => onDropSessionInto(event, project.id)}
      >
        <div className='project-group-heading'>
          <button
            className='project-expand'
            aria-label={`${expanded ? 'Collapse' : 'Expand'} workspace ${label}`}
            title={project.projectRoot}
            aria-expanded={expanded}
            onClick={() => onToggleProjectExpanded(project.id)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={14} />
            <span>{label}</span>
            <small>{projectTasks.length}</small>
          </button>
          <button
            className='project-group-new'
            aria-label={`New session in ${label}`}
            title='New session in this workspace'
            onClick={() => onStartNewSessionInProject(project.id)}
          >
            <Plus size={13} />
          </button>
          <button
            className='project-group-pin'
            aria-pressed={project.pinned}
            aria-label={`${project.pinned ? 'Unpin' : 'Pin'} workspace ${label}`}
            title={project.pinned ? 'Unpin workspace' : 'Pin workspace'}
            onClick={() => onPinProject(project.id, !project.pinned)}
          >
            <Pin size={12} />
          </button>
          <button
            className='project-group-edit'
            aria-label={`Configure workspace ${label}`}
            title={project.projectRoot}
            onClick={() => onOpenProjectEditor(project)}
          >
            <Settings2 size={13} />
          </button>
        </div>
        <ExpandableSessionRows expanded={expanded}>
          {renderSessionRows(shown)}
          {projectTasks.length > 5 && (
            <button
              className='session-history-more'
              onClick={() =>
                setShowAllProjects((current) => ({
                  ...current,
                  [project.id]: !current[project.id],
                }))
              }
            >
              {showAllProjects[project.id]
                ? 'Show recent five'
                : `Show all ${projectTasks.length} sessions`}
            </button>
          )}
          {!projectTasks.length && <span className='project-empty'>Drop a session here</span>}
        </ExpandableSessionRows>
      </section>
    );
  };
  const unclassifiedExpanded = expandedProjectIds.includes('unclassified');

  return (
    <aside
      id='primary-sidebar'
      aria-label='Session explorer'
      className='sidebar'
      aria-hidden={sidebarCollapsed}
      inert={sidebarCollapsed}
    >
      <div className='sidebar-tools'>
        <span className='sidebar-title'>Sessions</span>
        <button
          className='icon-btn'
          aria-label='New session'
          title='New session (Ctrl/Cmd+N)'
          aria-keyshortcuts='Control+N Meta+N'
          onClick={onOpenNewTab}
        >
          <Plus size={16} />
        </button>
        <button
          className='icon-btn'
          aria-label='Create workspace'
          title='Create workspace'
          onClick={() => onOpenProjectEditor('new')}
        >
          <FolderPlus size={15} />
        </button>
        <button
          className='icon-btn'
          aria-label='Keyboard shortcuts'
          title='Keyboard shortcuts'
          onClick={() => onOpenShortcuts()}
        >
          <Keyboard size={15} />
        </button>
        <button
          className='icon-btn'
          aria-label='Search sessions'
          onClick={() => searchInputRef.current?.focus()}
        >
          <Search size={15} />
        </button>
      </div>
      <input
        ref={searchInputRef}
        className='session-search'
        type='search'
        aria-label='Search sessions'
        placeholder='Filter sessions'
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <nav
        className='task-list project-task-list'
        aria-label='Sessions'
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-opnex-session-project'))
            event.preventDefault();
        }}
      >
        {orderedProjects.filter((project) => project.pinned).map(projectSessionSection)}
        {orderedProjects.filter((project) => !project.pinned).map(projectSessionSection)}
        <section
          className={`project-session-group unclassified-group ${projectDropTarget === 'unclassified' ? 'is-drop-target' : ''}`}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('application/x-opnex-session-project'))
              setProjectDropTarget('unclassified');
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setProjectDropTarget(null);
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('application/x-opnex-session-project'))
              event.preventDefault();
          }}
          onDrop={(event) => onDropSessionInto(event, null)}
        >
          <div className='project-group-heading'>
            <button
              className='project-expand'
              aria-label={`${unclassifiedExpanded ? 'Collapse' : 'Expand'} Unclassified`}
              aria-expanded={unclassifiedExpanded}
              onClick={() => onToggleProjectExpanded('unclassified')}
            >
              {unclassifiedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} />
              <span>Unclassified</span>
              <small>{unclassifiedTasks.length}</small>
            </button>
          </div>
          <ExpandableSessionRows expanded={unclassifiedExpanded}>
            {renderSessionRows(
              showAllProjects.unclassified ? unclassifiedTasks : unclassifiedTasks.slice(0, 5)
            )}
            {unclassifiedTasks.length > 5 && (
              <button
                className='session-history-more'
                onClick={() =>
                  setShowAllProjects((current) => ({
                    ...current,
                    unclassified: !current.unclassified,
                  }))
                }
              >
                {showAllProjects.unclassified
                  ? 'Show recent five'
                  : `Show all ${unclassifiedTasks.length} sessions`}
              </button>
            )}
          </ExpandableSessionRows>
        </section>
        {archivedTasks.length > 0 && (
          <section className='project-session-group archived-session-group'>
            <div className='project-group-heading'>
              <button
                className='project-expand'
                aria-label={`${archivedExpanded ? 'Collapse' : 'Expand'} Archived sessions`}
                aria-expanded={archivedExpanded}
                onClick={() => setArchivedExpanded((value) => !value)}
              >
                {archivedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Archive size={13} />
                <span>Archived</span>
                <small>{archivedTasks.length}</small>
              </button>
            </div>
            <ExpandableSessionRows expanded={archivedExpanded}>
              {renderSessionRows(archivedTasks, true)}
            </ExpandableSessionRows>
          </section>
        )}
      </nav>
      {projectMoveError && (
        <div className='project-move-error' role='alert'>
          {projectMoveError}
          <button
            className='icon-btn'
            aria-label='Dismiss move error'
            onClick={() => onClearProjectMoveError()}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className='sidebar-bottom'>
        <button
          className='project-mini'
          aria-label={
            selectedProject
              ? workspaceOptionLabel(selectedProject, projects)
              : 'Create or select workspace'
          }
          title={selectedProject?.projectRoot}
          onClick={() =>
            selectedProject ? onOpenProjectEditor(selectedProject) : onOpenProjectEditor('new')
          }
        >
          <Folder size={15} />
          <span className='project-mini-text'>
            {selectedProject ? workspaceOptionLabel(selectedProject, projects) : 'Choose workspace'}
          </span>
        </button>
      </div>
    </aside>
  );
}
