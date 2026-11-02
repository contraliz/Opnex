// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LocalGitWorkspace } from '../src/ui/LocalGitWorkspace';

vi.mock('../src/ui/api', () => ({ api: vi.fn() }));
import { api } from '../src/ui/api';

const github = { available: false, authenticated: false, detail: 'GitHub CLI is unavailable.' };
const projectId = '11111111-1111-4111-8111-111111111111';
let clipboardDescriptor: PropertyDescriptor | undefined;
function page(repository: string, historyOffset = 0, branchOffset = 0) {
  const branches = Array.from({ length: 100 }, (_, i) => ({
    name: `branch-${String(branchOffset + i).padStart(3, '0')}`,
    hash: `b${branchOffset + i}`,
    current: branchOffset === 0 && i === 0,
    remote: false,
  }));
  const commits = Array.from({ length: 100 }, (_, i) => ({
    hash: `c${historyOffset + i}`,
    parents: i === 99 ? [`outside-${historyOffset + 100}`] : [`c${historyOffset + i + 1}`],
    author: 'Fixture',
    date: '2026-10-24T00:00:00Z',
    subject: `${repository} commit ${historyOffset + i}`,
    refs: [],
  }));
  return {
    available: true,
    authorizedRoot: repository,
    repositoryRoot: repository,
    currentBranch: 'branch-000',
    branches,
    branchPage: {
      offset: branchOffset,
      pageSize: 100,
      totalCount: 200,
      totalIsExact: true,
      hasMore: branchOffset === 0,
      nextOffset: branchOffset === 0 ? 100 : null,
    },
    worktrees: [],
    commits,
    history: {
      offset: historyOffset,
      pageSize: 100,
      hasMore: historyOffset === 0,
      nextOffset: historyOffset === 0 ? 100 : null,
    },
    github,
  };
}
function unavailable(detail: string, repositoryRoot?: string) {
  return {
    available: false,
    authorizedRoot: 'C:/repo/project',
    ...(repositoryRoot ? { repositoryRoot } : {}),
    detail,
    branches: [],
    worktrees: [],
    commits: [],
    history: { offset: 0, pageSize: 100, hasMore: false, nextOffset: null },
    github,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.resetAllMocks();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  clipboardDescriptor = undefined;
});

describe('native local Git workspace paging and routes', () => {
  it('reports a denied GitHub URL clipboard write instead of leaving an unhandled rejection', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const workspace = {
      ...page('C:/repo'),
      github: {
        available: true,
        authenticated: true,
        repositoryAvailable: true,
        pullRequestsAvailable: true,
        issuesAvailable: true,
        repository: {
          name: 'repo',
          url: 'https://github.com/example/repo',
          defaultBranch: 'main',
        },
        pullRequests: [
          {
            number: 7,
            title: 'Fix the branch guard',
            url: 'https://github.com/example/repo/pull/7',
            state: 'OPEN',
            updatedAt: '2026-11-02T00:00:00.000Z',
          },
        ],
        issues: [],
      },
    };
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: true } as any;
      if (url.includes('/github')) return workspace as any;
      return workspace as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/repo' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pull requests' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy URL for pull request 7' }));

    expect(writeText).toHaveBeenCalledWith('https://github.com/example/repo/pull/7');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not copy the GitHub URL. Open it and copy the address directly.'
    );
  });

  it('previews the non-ignored files and requires a commit message before creating the first commit', async () => {
    const preview = {
      status: 'unborn',
      eligible: true,
      branch: 'main',
      files: [
        { path: 'src/app.ts', status: 'working' },
        { path: 'README.md', status: 'staged' },
      ],
      totalFiles: 2,
      empty: false,
      truncated: false,
      previewToken: '11111111-1111-4111-8111-111111111112',
    };
    let committed = false;
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github')) return github as any;
      if (url.startsWith('/api/git-workspace/initial-commit-preview'))
        return (
          committed
            ? {
                status: 'committed',
                eligible: false,
                reason: 'already-committed',
                files: [],
                totalFiles: 0,
                empty: true,
                truncated: false,
              }
            : preview
        ) as any;
      if (url === '/api/git-workspace/initial-commit') {
        committed = true;
        return { commit: 'a'.repeat(40), branch: 'main' } as any;
      }
      return { ...page('C:/repo'), repositoryStatus: 'repository' } as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/repo' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create initial commit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create initial commit' });
    expect(dialog.textContent).toContain('2 paths will be included');
    expect(dialog.textContent).toContain('src/app.ts');
    expect(dialog.textContent).toContain('README.md');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'Set the project baseline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create initial commit' }));
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith('/api/git-workspace/initial-commit', {
        projectId,
        previewToken: preview.previewToken,
        message: 'Set the project baseline',
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create initial commit' })).toBeNull()
    );
  });

  it('does not show the initial commit action for a repository with existing history', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github')) return github as any;
      if (url.startsWith('/api/git-workspace/initial-commit-preview'))
        return {
          status: 'committed',
          eligible: false,
          reason: 'already-committed',
          files: [],
          totalFiles: 0,
          empty: true,
          truncated: false,
        } as any;
      return { ...page('C:/repo'), repositoryStatus: 'repository' } as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/repo' />);
    await screen.findByText('C:/repo');
    expect(screen.queryByRole('button', { name: 'Create initial commit' })).toBeNull();
  });

  it('shows the repository creation action when the selected workspace has no Git repository', async () => {
    const workspace = {
      id: projectId,
      name: 'project',
      projectRoot: 'C:/repo/project',
      needsLocation: false,
      pinned: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    let status: 'missing' | 'repository' = 'missing';
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.includes('/github')) return github as any;
      if (url === '/api/git-workspace/init') {
        status = 'repository';
        return { created: true } as any;
      }
      return {
        ...unavailable(
          'Choose a folder inside a Git repository to see local branches and history.'
        ),
        repositoryStatus: status,
      } as any;
    });
    render(<LocalGitWorkspace projectId={projectId} workspaces={[workspace]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create repository' }));
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith('/api/git-workspace/init', { projectId })
    );
  });

  it('does not apply a delayed refresh to a workspace selected while repository creation is pending', async () => {
    const workspaceA = {
      id: projectId,
      name: 'Workspace A',
      projectRoot: 'C:/repo-a',
      needsLocation: false,
      pinned: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const workspaceB = {
      ...workspaceA,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Workspace B',
      projectRoot: 'C:/repo-b',
    };
    const initialization = deferred<any>();
    const lateWorkspaceA = deferred<any>();
    let workspaceALoads = 0;
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.includes('/github')) return github as any;
      if (url === '/api/git-workspace/init') return initialization.promise as any;
      if (url.startsWith('/api/git-workspace/initial-commit-preview'))
        return {
          status: 'committed',
          eligible: false,
          reason: 'already-committed',
          files: [],
          totalFiles: 0,
          empty: true,
          truncated: false,
        } as any;
      if (url.includes(`projectId=${workspaceA.id}`)) {
        workspaceALoads += 1;
        return workspaceALoads === 1
          ? ({
              ...unavailable('Create a repository in this workspace.', workspaceA.projectRoot),
              repositoryStatus: 'missing',
            } as any)
          : (lateWorkspaceA.promise as any);
      }
      if (url.includes(`projectId=${workspaceB.id}`))
        return { ...page(workspaceB.projectRoot), repositoryStatus: 'repository' } as any;
      return {} as any;
    });

    render(<LocalGitWorkspace projectId={workspaceA.id} workspaces={[workspaceA, workspaceB]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create repository' }));
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith('/api/git-workspace/init', {
        projectId: workspaceA.id,
      })
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Git workspace' }), {
      target: { value: workspaceB.id },
    });
    expect(await screen.findByText(workspaceB.projectRoot)).toBeTruthy();
    initialization.resolve({ created: true });
    await waitFor(() => expect(workspaceALoads).toBe(2));
    lateWorkspaceA.resolve(page(workspaceA.projectRoot));

    await waitFor(() => expect(screen.getByText(workspaceB.projectRoot)).toBeTruthy());
    expect(screen.queryByText(workspaceA.projectRoot)).toBeNull();
  });

  it('explains that the selected workspace root must contain the repository root', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github') || url.includes('/github?')) return github as any;
      return unavailable(
        'The Git repository is outside the selected workspace folder.',
        'C:/repo'
      ) as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/repo/project' />);
    expect(
      await screen.findByText('The Git repository is outside the selected workspace folder.', {
        selector: '.git-empty strong',
      })
    ).toBeTruthy();
    expect(
      screen.getByText(/select the repository root itself or a workspace folder that contains it/i)
    ).toBeTruthy();
    expect(
      screen.queryByText(/choose a workspace folder inside a local Git repository/i)
    ).toBeNull();
  });

  it('keeps the inside-a-repository guidance when the selected folder has no repository', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github') || url.includes('/github?')) return github as any;
      return unavailable(
        'Choose a folder inside a Git repository to see local branches and history.'
      ) as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/repo/project' />);
    expect(
      await screen.findByText(
        'Choose a folder inside a Git repository to see local branches and history.',
        { selector: '.git-empty strong' }
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/choose a workspace folder inside a local Git repository/i)
    ).toBeTruthy();
  });

  it('connects the actual lane node toward commit text and omits the duplicate glyph', async () => {
    const graphCommits = [
      {
        hash: 'merge',
        parents: ['main', 'feature'],
        author: 'Fixture',
        date: '2026-10-24T00:00:00Z',
        subject: 'merge commit',
        refs: [],
      },
      {
        hash: 'main',
        parents: ['base'],
        author: 'Fixture',
        date: '2026-10-24T00:00:00Z',
        subject: 'main commit',
        refs: [],
      },
      {
        hash: 'feature',
        parents: ['base'],
        author: 'Fixture',
        date: '2026-10-24T00:00:00Z',
        subject: 'feature commit',
        refs: [],
      },
      {
        hash: 'base',
        parents: [],
        author: 'Fixture',
        date: '2026-10-24T00:00:00Z',
        subject: 'base commit',
        refs: [],
      },
    ];
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github')) return github as any;
      return { ...page('C:/fixture'), commits: graphCommits } as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='C:/fixture' />);
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    await screen.findByText('feature commit');

    const rows = [...document.querySelectorAll<HTMLElement>('.git-commit-row')];
    const featureRow = rows.find(
      (row) => row.querySelector('.git-commit-copy strong')?.textContent === 'feature commit'
    );
    const connectorPaths = [
      ...document.querySelectorAll<SVGPathElement>('.git-graph-lines .git-commit-connector'),
    ];
    expect(connectorPaths).toHaveLength(graphCommits.length);
    expect(featureRow?.querySelector('.git-graph-space > i')?.getAttribute('style')).toContain(
      'left: 19px'
    );
    expect(connectorPaths[2].getAttribute('d')).toBe('M 19 125 H 43');
    expect(document.querySelector('.commit-glyph')).toBeNull();
  });

  it('keeps branch and history pages independently while alternating their load-more controls', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github')) return github as any;
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      return page(
        'C:/fixture',
        Number(query.get('offset')),
        Number(query.get('branchOffset'))
      ) as any;
    });
    render(<LocalGitWorkspace projectId={projectId} />);
    fireEvent.click(await screen.findByRole('button', { name: /Branches/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load next 100 branches' }));
    await waitFor(() => expect(document.querySelectorAll('.git-branch-row')).toHaveLength(200));
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load next 100 commits' }));
    await waitFor(() => expect(document.querySelectorAll('.git-commit-row')).toHaveLength(200));
    fireEvent.click(screen.getByRole('button', { name: /Branches/ }));
    expect(document.querySelectorAll('.git-branch-row')).toHaveLength(200);
    const callUrls = vi.mocked(api).mock.calls.map(([url]) => url as string);
    expect(callUrls).toContain(
      `/api/git-workspace?projectId=${projectId}&offset=0&branchOffset=100`
    );
    expect(callUrls).toContain(
      `/api/git-workspace?projectId=${projectId}&offset=100&branchOffset=100`
    );
    expect(
      new Set([...document.querySelectorAll('.git-branch-row strong')].map((el) => el.textContent))
        .size
    ).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(document.querySelectorAll('.git-commit-row')).toHaveLength(200);
    expect(
      new Set([...document.querySelectorAll('.git-commit-copy strong')].map((el) => el.textContent))
        .size
    ).toBe(200);
  });

  it('aborts the prior task route and ignores its late local and GitHub responses', async () => {
    const oldLocal = deferred<any>(),
      oldGithub = deferred<any>();
    vi.mocked(api).mockImplementation((url) => {
      if (url === '/api/github/auth')
        return Promise.resolve({ state: 'idle', cliAvailable: true, authenticated: false }) as any;
      if (url.includes('old-task'))
        return (url.endsWith('/github') ? oldGithub.promise : oldLocal.promise) as any;
      if (url.endsWith('/github')) return Promise.resolve(github) as any;
      return Promise.resolve(page('C:/new-repo')) as any;
    });
    const { rerender } = render(<LocalGitWorkspace taskId='old-task' />);
    rerender(<LocalGitWorkspace taskId='new-task' />);
    expect(await screen.findByText('new-repo')).toBeTruthy();
    oldLocal.resolve(page('C:/old-repo'));
    oldGithub.resolve({ available: true, authenticated: true, repository: { name: 'old/cloud' } });
    await waitFor(() => expect(screen.getByText('new-repo')).toBeTruthy());
    expect(screen.queryByText('old-repo')).toBeNull();
    expect(screen.queryByText('old/cloud')).toBeNull();
    const oldCall = vi.mocked(api).mock.calls.find(([url]) => (url as string).includes('old-task'));
    expect(oldCall?.[2]?.aborted).toBe(true);
  });

  it('uses the selected workspace identity only when there is no task route', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.endsWith('/github')) return github as any;
      return page('D:/fixture root') as any;
    });
    render(<LocalGitWorkspace projectId={projectId} projectRoot='D:/fixture root' />);
    await screen.findByText('D:/fixture root');
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).toContain(
      `/api/git-workspace?projectId=${projectId}&offset=0&branchOffset=0`
    );

    cleanup();
    vi.resetAllMocks();
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/github/auth')
        return { state: 'idle', cliAvailable: true, authenticated: false } as any;
      if (url.includes('/tasks/captured-task/')) return page('D:/captured-task') as any;
      return github as any;
    });
    render(<LocalGitWorkspace taskId='captured-task' projectRoot='D:/settings-after-open' />);
    await screen.findByText('D:/captured-task');
    expect(vi.mocked(api).mock.calls.some(([url]) => (url as string).includes('root='))).toBe(
      false
    );
  });

  it('starts device sign-in, opens the verification page in a peer Browser workspace, and can cancel', async () => {
    const openBrowserTab = vi.fn();
    const pending = {
      state: 'awaiting',
      cliAvailable: true,
      authenticated: false,
      attemptId: 'fixture-attempt',
      verificationUrl: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 60_000,
    };
    vi.mocked(api).mockImplementation(async (url, body) => {
      if (url === '/api/github/auth')
        return (body as any)?.action === 'start'
          ? pending
          : ({ state: 'idle', cliAvailable: true, authenticated: false } as any);
      if (url.endsWith('/github')) return github as any;
      return page('C:/fixture') as any;
    });
    render(
      <LocalGitWorkspace
        projectId={projectId}
        projectRoot='C:/fixture'
        onOpenBrowserTab={openBrowserTab}
      />
    );
    const signIn = await screen.findByRole('button', { name: 'Sign in with GitHub' });
    await waitFor(() => expect((signIn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signIn);
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    await waitFor(() =>
      expect(openBrowserTab).toHaveBeenCalledWith('https://github.com/login/device')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open verification page' }));
    expect(openBrowserTab).toHaveBeenCalledTimes(2);
  });
});
