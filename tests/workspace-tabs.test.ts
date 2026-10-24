import { describe, expect, it } from 'vitest';
import {
  createWorkspaceTabId,
  createWorkspaceTabRecord,
  registerWorkspaceTab,
  removeWorkspaceTab,
  workspaceKindForMode,
  workspaceTabKind,
  workspaceTabTitle,
} from '../src/ui/workspaceTabs';

describe('typed workspace tabs', () => {
  it('keeps existing task and new-session IDs as session tabs while prefixing peer workspaces', () => {
    expect(workspaceTabKind('new:0')).toBe('session');
    expect(workspaceTabKind('task-123')).toBe('session');
    expect(createWorkspaceTabId('browser', 'one')).toBe('browser:one');
    expect(createWorkspaceTabId('git', 'two')).toBe('git:two');
    expect(workspaceTabKind('browser:one')).toBe('browser');
    expect(workspaceTabKind('git:two')).toBe('git');
  });

  it('adapts legacy browser and GitHub workspace commands into typed tab intents', () => {
    expect(workspaceKindForMode('browser')).toBe('browser');
    expect(workspaceKindForMode('github')).toBe('git');
    expect(workspaceKindForMode('git')).toBe('git');
    expect(workspaceKindForMode('settings')).toBeNull();
  });

  it('snapshots the opening session, task, root, and optional browser URL', () => {
    const browser = createWorkspaceTabRecord('browser', 'browser:one', {
      originTabId: 'task-123',
      projectRoot: 'D:\\work\\repo',
      initialUrl: 'https://example.test',
    });
    const git = createWorkspaceTabRecord('git', 'git:two', {
      originTabId: 'new:0',
      projectRoot: 'D:\\work\\repo',
      focusUrl: '/pull/42',
    });

    expect(browser).toEqual({
      id: 'browser:one', kind: 'browser', originTabId: 'task-123', originTaskId: 'task-123',
      projectRoot: 'D:\\work\\repo', initialUrl: 'https://example.test',
    });
    expect(git).toEqual({
      id: 'git:two', kind: 'git', originTabId: 'new:0', originTaskId: null,
      projectRoot: 'D:\\work\\repo', focusUrl: '/pull/42',
    });
  });

  it('uses stable titles and rejects metadata that disagrees with its typed ID', () => {
    expect(workspaceTabTitle('browser:one')).toBe('Browser');
    expect(workspaceTabTitle('git:two')).toBe('Git');
    expect(workspaceTabTitle('new:0')).toBe('New session');
    expect(workspaceTabTitle('task-123', 'Research')).toBe('Research');
    expect(() => createWorkspaceTabRecord('git', 'browser:one', { originTabId: null, projectRoot: '' })).toThrow('git: prefix');
  });

  it('registers and removes peer tabs immutably by their stable IDs', () => {
    const first = createWorkspaceTabRecord('browser', 'browser:one', { originTabId: 'task-123', projectRoot: 'D:\\repo' });
    const registry = registerWorkspaceTab({}, first);
    const second = createWorkspaceTabRecord('git', 'git:two', { originTabId: 'task-123', projectRoot: 'D:\\repo' });
    const expanded = registerWorkspaceTab(registry, second);

    expect(registry).toEqual({ 'browser:one': first });
    expect(expanded).toEqual({ 'browser:one': first, 'git:two': second });
    expect(removeWorkspaceTab(expanded, 'browser:one')).toEqual({ 'git:two': second });
    expect(removeWorkspaceTab(expanded, 'missing')).toBe(expanded);
  });
});
