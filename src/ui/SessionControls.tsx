import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, MoreHorizontal, Pencil, Pin, Trash2, X } from 'lucide-react';
import type { Project, Task } from '../types';
import { workspaceOptionLabel } from './workspace-label';

type SessionRowProps = {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
  onSessionAction: (kind: 'rename' | 'delete', id: string) => void;
  onPin: (task: Task, pinned: boolean) => void;
  onArchive: (task: Task, archived: boolean) => void;
  onMoveStart?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
  onMoveEnd?: () => void;
  projects?: Project[];
  onMove?: (taskId: string, projectId: string | null) => void;
  archived?: boolean;
};

export const SessionRow = memo(function SessionRow({
  task,
  selected,
  onSelect,
  onSessionAction,
  onPin,
  onArchive,
  onMoveStart,
  onMoveEnd,
  projects,
  onMove,
  archived = false,
}: SessionRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dragSuppressUntil = useRef(0);
  const isForge = task.sessionType === 'forge';
  const busy =
    isForge ||
    [
      'intake',
      'routing',
      'direct_running',
      'simple_running',
      'planning',
      'worker_running',
      'reviewing',
      'escalated',
    ].includes(task.phase) ||
    !!task.activeTurnId ||
    !!task.activeRole;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.session-row') && !target?.closest('.session-actions-menu')) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  const placeMenu = (x: number, y: number) =>
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 216)),
      y: Math.max(8, Math.min(y, window.innerHeight - 248)),
    });
  const openMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    placeMenu(rect.right - 204, rect.bottom + 4);
  };
  const openContext = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    placeMenu(event.clientX, event.clientY);
  };
  const item = (
    label: string,
    icon: React.ReactNode,
    run: () => void,
    disabled = false,
    title?: string
  ) => (
    <button
      role='menuitem'
      disabled={disabled}
      title={title}
      onClick={() => {
        setMenu(null);
        run();
      }}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div
      className={`session-row ${isForge ? 'forge-session-row ' : ''}${selected ? 'selected ' : ''}${task.pinned ? 'pinned ' : ''}${archived ? 'archived' : ''}`}
      data-session-type={isForge ? 'forge' : 'conversation'}
      draggable={!isForge && !archived}
      onContextMenu={openContext}
      onDragStart={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.session-actions-trigger,.session-actions-menu,.session-row-actions'
          )
        ) {
          event.preventDefault();
          return;
        }
        dragSuppressUntil.current = Date.now() + 600;
        onMoveStart?.(event, task);
      }}
      onDragEnd={() => {
        dragSuppressUntil.current = Date.now() + 600;
        onMoveEnd?.();
      }}
      onPointerCancel={() => {
        dragSuppressUntil.current = 0;
      }}
    >
      <button
        className={`task-nav ${selected ? 'selected' : ''}`}
        aria-label={task.title}
        aria-current={selected ? 'page' : undefined}
        onClick={(event) => {
          if (Date.now() < dragSuppressUntil.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onSelect(task.id);
        }}
      >
        <span className='task-title'>{task.title}</span>
        {task.pinned && <Pin className='session-pin-mark' size={10} aria-hidden='true' />}
        {isForge && (
          <span className='session-type-label' title='Forge ticket'>
            Forge
          </span>
        )}
      </button>
      <span className='session-row-actions'>
        {!archived && (
          <button
            type='button'
            className='session-row-action'
            aria-label={`${task.pinned ? 'Unpin' : 'Pin'} ${task.title}`}
            aria-pressed={!!task.pinned}
            title={task.pinned ? 'Unpin session' : 'Pin session'}
            onClick={(event) => {
              event.stopPropagation();
              onPin(task, !task.pinned);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Pin size={12} />
          </button>
        )}
        <button
          type='button'
          className='session-row-action'
          aria-label={`${archived ? 'Unarchive' : 'Archive'} ${task.title}`}
          title={
            archived
              ? 'Unarchive session'
              : busy
                ? 'Stop or finish the active turn first'
                : 'Archive session'
          }
          disabled={!archived && busy}
          onClick={(event) => {
            event.stopPropagation();
            onArchive(task, !archived);
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Archive size={12} />
        </button>
        <button
          type='button'
          className='session-actions-trigger'
          aria-label={`Actions for ${task.title}`}
          aria-expanded={!!menu}
          onClick={openMenu}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={15} />
        </button>
      </span>
      {menu &&
        createPortal(
          <div
            className='session-actions-menu session-actions-menu-fixed'
            role='menu'
            style={{ left: menu.x, top: menu.y }}
          >
            {item(task.pinned ? 'Unpin session' : 'Pin session', <Pin size={14} />, () =>
              onPin(task, !task.pinned)
            )}
            {item(
              archived ? 'Unarchive session' : 'Archive session',
              <Archive size={14} />,
              () => onArchive(task, !archived),
              !archived && busy,
              'Stop or finish the active turn first'
            )}
            {item('Rename', <Pencil size={14} />, () => onSessionAction('rename', task.id))}
            {onMove && !isForge && !archived && (
              <label className='session-move-menu'>
                Move to workspace
                <select
                  aria-label={`Move ${task.title} to workspace`}
                  value={task.projectId || ''}
                  onChange={(event) => {
                    onMove(task.id, event.currentTarget.value || null);
                    setMenu(null);
                  }}
                >
                  <option value=''>Unclassified</option>
                  {(projects || []).map((project) => (
                    <option key={project.id} value={project.id} title={project.projectRoot}>
                      {workspaceOptionLabel(project, projects || [])}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!isForge &&
              item(
                'Delete session',
                <Trash2 size={14} />,
                () => onSessionAction('delete', task.id),
                busy,
                'Stop or finish the active turn first'
              )}
          </div>,
          document.body
        )}
    </div>
  );
});

export function SessionDialog({
  open,
  kind,
  task,
  close,
  rename,
  remove,
}: {
  open: boolean;
  kind: 'rename' | 'delete';
  task?: Task;
  close: () => void;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title || '');
  const [working, setWorking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && kind === 'rename') {
      setTitle(task?.title || '');
      input.current?.focus();
    }
  }, [open, kind, task?.id]);
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !working) close();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [close, working]);
  const blocked =
    !!task &&
    ([
      'intake',
      'routing',
      'direct_running',
      'simple_running',
      'planning',
      'worker_running',
      'reviewing',
      'escalated',
    ].includes(task.phase) ||
      !!task.activeTurnId ||
      !!task.activeRole);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task || working) return;
    const clean = title.trim();
    if (kind === 'rename' && !clean) return;
    setWorking(true);
    try {
      if (kind === 'rename') await rename(task.id, clean);
      else await remove(task.id);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div
      className='dialog-backdrop'
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onMouseDown={(e) => e.target === e.currentTarget && !working && close()}
    >
      <form
        className='session-dialog'
        data-open={open}
        role='dialog'
        aria-modal='true'
        aria-labelledby='session-dialog-title'
        onSubmit={submit}
      >
        <header>
          <div>
            <h2 id='session-dialog-title'>
              {kind === 'rename' ? 'Rename session' : 'Delete session?'}
            </h2>
            <p>
              {kind === 'rename'
                ? 'Choose a name for this conversation.'
                : 'This removes the local conversation and its saved pass history.'}
            </p>
          </div>
          <button
            type='button'
            className='icon-btn'
            aria-label='Close dialog'
            onClick={close}
            disabled={working}
          >
            <X size={16} />
          </button>
        </header>
        {!task ? (
          <p role='alert'>This session is no longer available.</p>
        ) : kind === 'rename' ? (
          <label>
            Session name
            <input
              ref={input}
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoComplete='off'
            />
            <small>
              Up to 120 characters. Rename does not create a new task or alter its history.
            </small>
          </label>
        ) : (
          <div className='delete-confirm'>
            <strong>{task.title}</strong>
            {blocked && (
              <p role='alert'>Stop or finish the active turn before deleting this session.</p>
            )}
          </div>
        )}
        <footer>
          <button type='button' className='secondary-btn' onClick={close} disabled={working}>
            Cancel
          </button>
          {task && kind === 'rename' ? (
            <button className='primary-btn' disabled={working || !title.trim()}>
              {working ? 'Saving…' : 'Save name'}
            </button>
          ) : (
            task && (
              <button className='danger-btn' disabled={working || blocked}>
                {working ? 'Deleting…' : 'Delete local session'}
              </button>
            )
          )}
        </footer>
      </form>
    </div>
  );
}
