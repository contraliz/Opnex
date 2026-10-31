import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppServerRequestError } from '../server/codex.js';
import { ForgeCodexProvider } from '../server/forge-provider.js';

function fakeCodex() {
  const events = new EventEmitter();
  const client = Object.assign(events, {
    startThread: vi.fn(async () => 'thread-forge-1'),
    startTurn: vi.fn(async () => ({ turn: { id: 'turn-forge-1', status: 'inProgress' } })),
    interrupt: vi.fn(async (_threadId: string, _turnId: string) => ({})),
    respondServerRequest: vi.fn(),
    respondServerError: vi.fn(),
  });
  return client;
}

const request = {
  role: 'orchestrator' as const,
  ticketId: 'ticket-1',
  taskId: 'ticket-1',
  canonicalRoot: 'D:/work/project',
  executionRoot: 'D:/work/project',
  model: 'gpt-6.1-terra',
  effort: 'low' as const,
  prompt: 'Create the complete plan.',
  outputSchema: { type: 'object' },
  writeRoots: [],
  approvalPolicy: 'on-request' as const,
};

describe('Forge Codex provider contract', () => {
  it('uses the selected model, effort, role, root and bounded turn options', async () => {
    const client = fakeCodex();
    const validateProfile = vi.fn();
    const onStarted = vi.fn();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile, ensureReady: vi.fn() });

    const handle = await provider.start(request, onStarted);

    expect(validateProfile).toHaveBeenCalledWith('gpt-6.1-terra', 'low');
    expect(client.startThread).toHaveBeenCalledWith(
      'orchestrator', 'D:/work/project', 'gpt-6.1-terra', 'low', 'on-request', expect.any(String), undefined, undefined,
    );
    expect(client.startTurn).toHaveBeenCalledWith(
      'thread-forge-1', 'Create the complete plan.', 'orchestrator', 'gpt-6.1-terra', 'low',
      'D:/work/project', [], 'on-request', { type: 'object' },
    );
    expect(handle).toMatchObject({ provider: 'codex', role: 'orchestrator', threadId: 'thread-forge-1', turnId: 'turn-forge-1', model: 'gpt-6.1-terra', effort: 'low' });
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-forge-1', turnId: 'turn-forge-1' }));
  });

  it('rejects a profile the connected runtime does not advertise instead of falling back', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: () => { throw new Error('Model gpt-6.1-terra does not advertise low reasoning effort.'); }, ensureReady: vi.fn() });

    await expect(provider.start(request)).rejects.toThrow(/does not advertise low/);
    expect(client.startThread).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it('distinguishes an explicit turn-start rejection from a lost provider response', async () => {
    const rejected = fakeCodex();
    rejected.startTurn.mockRejectedValue(new AppServerRequestError('turn/start', 'Unsupported approval policy.'));
    const rejectedProvider = new ForgeCodexProvider({ client: rejected as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    await expect(rejectedProvider.start(request)).rejects.toMatchObject({ effect: 'not_started' });

    const uncertain = fakeCodex();
    uncertain.startTurn.mockRejectedValue(new Error('app-server connection closed after request send'));
    const uncertainProvider = new ForgeCodexProvider({ client: uncertain as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    await expect(uncertainProvider.start(request)).rejects.toMatchObject({ effect: 'uncertain' });
  });

  it('rejects Full Access for every Forge role before creating a thread', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn() });

    await expect(provider.start({ ...request, approvalPolicy: 'full-access' })).rejects.toThrow(/defeats the accepted role and filesystem boundaries/i);
    expect(client.startThread).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it('settles only on the matching observed provider turn and retains real completion details', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    const handle = await provider.start(request);
    const completion = handle.completion;
    client.emit('notification', 'turn/completed', { threadId: 'other-thread', turn: { id: 'turn-forge-1', status: 'completed', items: [] } });
    client.emit('notification', 'turn/completed', { threadId: 'thread-forge-1', turn: { id: 'other-turn', status: 'completed', items: [] } });
    let settled = false;
    void completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const turn = { id: 'turn-forge-1', status: 'completed', items: [{ type: 'agentMessage', text: '{"ok":true}' }] };
    client.emit('notification', 'turn/completed', { threadId: 'thread-forge-1', turn });

    await expect(completion).resolves.toEqual({ status: 'completed', turn, text: '{"ok":true}' });
  });

  it('reports uncertain cancellation when the runtime gives no stopped-turn evidence', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn(), cancelWaitMs: 1 });
    const handle = await provider.start(request);

    await expect(provider.cancel(handle)).resolves.toMatchObject({ status: 'uncertain' });
    expect(client.interrupt).toHaveBeenCalledWith('thread-forge-1', 'turn-forge-1');
  });

  it('persists an approval request through the owner callback before accepting a response', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    const onApproval = vi.fn();
    await provider.start(request, undefined, undefined, onApproval);
    const params = { threadId: 'thread-forge-1', turnId: 'turn-forge-1', itemId: 'item-1', command: 'git status', cwd: 'D:/work/project', availableDecisions: ['accept', 'decline'] };

    await expect(provider.handleServerRequest(7, 'item/commandExecution/requestApproval', params)).resolves.toBe(true);
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ requestId: 7, method: 'item/commandExecution/requestApproval', role: 'orchestrator', request: expect.objectContaining({ command: 'git status' }) }));
    const savedRequest = onApproval.mock.calls[0][0];
    expect(provider.respondApproval({ request: savedRequest, decision: 'accept' })).toBe(true);
    expect(client.respondServerRequest).toHaveBeenCalledWith(7, { decision: 'accept' });
    expect(provider.respondApproval({ request: savedRequest, decision: 'accept' })).toBe(false);
  });

  it('rejects stale approval requests without granting permissions', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    await provider.start(request, undefined, undefined, vi.fn());

    await expect(provider.handleServerRequest(8, 'item/fileChange/requestApproval', { threadId: 'thread-forge-1', turnId: 'old-turn', itemId: 'item-2' })).resolves.toBe(true);
    expect(client.respondServerError).toHaveBeenCalledWith(8, -32600, expect.stringContaining('Stale Forge approval'));
    expect(client.respondServerRequest).not.toHaveBeenCalled();
  });

  it('rejects app-owned tool calls on live Forge turns before Conversation dispatch', async () => {
    const client = fakeCodex();
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn() });
    await provider.start(request);

    await expect(provider.handleServerRequest(10, 'item/tool/call', {
      threadId: 'thread-forge-1', turnId: 'turn-forge-1', namespace: 'pseudoharness', tool: 'workspace', arguments: { action: 'initialize_git_repository' },
    })).resolves.toBe(true);
    expect(client.respondServerError).toHaveBeenCalledWith(10, -32601, expect.stringContaining('No application effect was applied'));
    expect(client.respondServerRequest).not.toHaveBeenCalled();

    await expect(provider.handleServerRequest(11, 'item/tool/call', {
      threadId: 'stale-thread', turnId: 'stale-turn', namespace: 'pseudoharness', tool: 'workspace', arguments: { action: 'initialize_git_repository' },
    })).resolves.toBe(false);
    expect(client.respondServerError).toHaveBeenCalledTimes(1);
  });

  it('cancels pending provider approvals before interrupting the owned turn', async () => {
    const client = fakeCodex();
    client.interrupt.mockImplementation(async (threadId: string, turnId: string) => {
      client.emit('notification', 'turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
      return {};
    });
    const provider = new ForgeCodexProvider({ client: client as never, validateProfile: vi.fn(), ensureReady: vi.fn(), cancelWaitMs: 10 });
    const handle = await provider.start(request, undefined, undefined, vi.fn());
    await provider.handleServerRequest(9, 'item/commandExecution/requestApproval', { threadId: 'thread-forge-1', turnId: 'turn-forge-1', itemId: 'item-3', command: 'git status' });

    await expect(provider.cancel(handle)).resolves.toMatchObject({ status: 'stopped' });
    expect(client.respondServerRequest).toHaveBeenCalledWith(9, { decision: 'cancel' });
    expect(client.interrupt).toHaveBeenCalledWith('thread-forge-1', 'turn-forge-1');
  });
});
