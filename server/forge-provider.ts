import {
  AppServerRequestError,
  approvalResponse,
  extractAssistantText,
  type AppServer,
  type CodexRole,
} from './codex.js';
import type { ApprovalPolicy } from './contracts.js';
import type { ForgeEffort } from './forge-contracts.js';

export type ForgeProviderRole = 'orchestrator' | 'worker' | 'integrator';
export type ForgeProviderRequest = {
  role: ForgeProviderRole;
  ticketId: string;
  taskId: string;
  canonicalRoot: string;
  executionRoot: string;
  model: string;
  effort: ForgeEffort;
  prompt: string;
  outputSchema: unknown;
  writeRoots: string[];
  approvalPolicy: ApprovalPolicy;
  registeredMcpServers?: Record<string, Record<string, unknown>>;
};
export type ForgeProviderStartEvidence = {
  provider: 'codex';
  role: ForgeProviderRole;
  ticketId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  model: string;
  effort: ForgeEffort;
  observedAt: string;
};
export type ForgeProviderOutcome = {
  status: 'completed' | 'failed' | 'interrupted' | 'unknown';
  turn: unknown;
  text: string;
};
export type ForgeProviderHandle = ForgeProviderStartEvidence & {
  completion: Promise<ForgeProviderOutcome>;
};
export type ForgeProviderEvent = {
  method: string;
  params: unknown;
  role: ForgeProviderRole;
  ticketId: string;
  taskId: string;
  threadId: string;
  turnId: string;
};
export type ForgeProviderCancelResult = {
  status: 'stopped' | 'completed' | 'uncertain';
  outcome?: ForgeProviderOutcome;
};
export type ForgeProviderApprovalRequest = {
  requestId: string | number;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  role: ForgeProviderRole;
  ticketId: string;
  taskId: string;
  request: Record<string, unknown>;
};
export type ForgeProviderApprovalDecision = {
  request: ForgeProviderApprovalRequest;
  decision: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
};

type CodexClient = Pick<
  AppServer,
  'startThread' | 'startTurn' | 'interrupt' | 'respondServerRequest' | 'respondServerError'
> &
  Pick<AppServer, 'on' | 'removeListener'>;
type PendingTurn = {
  request: ForgeProviderRequest;
  onStarted?: (evidence: ForgeProviderStartEvidence) => void | Promise<void>;
  onEvent?: (event: ForgeProviderEvent) => void | Promise<void>;
  onApproval?: (request: ForgeProviderApprovalRequest) => void | Promise<void>;
  approvals: Map<string, ForgeProviderApprovalRequest>;
  turnId?: string;
  handle?: ForgeProviderHandle;
  started?: Promise<void>;
  completedTurn?: any;
  resolve: (outcome: ForgeProviderOutcome) => void;
  reject: (error: unknown) => void;
  completion: Promise<ForgeProviderOutcome>;
  finished: boolean;
};

export class ForgeProviderStartError extends Error {
  constructor(
    message: string,
    readonly effect: 'not_started' | 'uncertain',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ForgeProviderStartError';
  }
}

const ORCHESTRATOR_POLICY = `Forge orchestration role: interpret the saved ticket, then return exactly one complete JSON plan or final review disposition matching the supplied schema. Decide whether one work item is sufficient or a dependency DAG is useful. Include complete assignments, allowed read/write/knowledge scopes, selected skill references, acceptance criteria, verification, ordinary authority, escalation conditions, and receipt requirements. Keep the plan within the ticket's immutable scope and selected execution profile. Do not create context-plan or context-compose stages. The application persists the plan before it schedules approved work; finish after the structured result.`;

function codexRole(role: ForgeProviderRole): CodexRole {
  return role;
}
function terminalOutcome(turn: any): ForgeProviderOutcome {
  const rawStatus = turn?.status;
  const status =
    rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'interrupted'
      ? rawStatus
      : 'unknown';
  return { status, turn, text: extractAssistantText(turn) };
}
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Runs ordinary single-turn Forge roles on the existing Opnex Codex app-server. */
export class ForgeCodexProvider {
  private readonly active = new Map<string, PendingTurn>();
  private readonly listener: (method: string, params: any) => void;

  constructor(
    private readonly options: {
      client: CodexClient;
      ensureReady: () => Promise<void>;
      validateProfile: (model: string, effort: ForgeEffort) => void;
      cancelWaitMs?: number;
    }
  ) {
    this.listener = (method, params) => this.onNotification(method, params);
    options.client.on('notification', this.listener);
  }

  async start(
    request: ForgeProviderRequest,
    onStarted?: PendingTurn['onStarted'],
    onEvent?: PendingTurn['onEvent'],
    onApproval?: PendingTurn['onApproval']
  ): Promise<ForgeProviderHandle> {
    try {
      await this.options.ensureReady();
      this.options.validateProfile(request.model, request.effort);
    } catch (error) {
      throw new ForgeProviderStartError(
        error instanceof Error ? error.message : 'Forge runtime preflight failed.',
        'not_started',
        { cause: error }
      );
    }
    if (!request.executionRoot || !request.canonicalRoot || !request.ticketId || !request.taskId)
      throw new ForgeProviderStartError(
        'Forge provider context must include the ticket, task, and canonical execution roots.',
        'not_started'
      );

    let threadId: string;
    try {
      const threadArgs = [
        codexRole(request.role),
        request.executionRoot,
        request.model,
        request.effort,
        request.approvalPolicy,
        request.role === 'orchestrator' ? ORCHESTRATOR_POLICY : undefined,
        undefined,
        undefined,
      ] as const;
      threadId = Object.keys(request.registeredMcpServers || {}).length
        ? await this.options.client.startThread(...threadArgs, request.registeredMcpServers!)
        : await this.options.client.startThread(...threadArgs);
    } catch (error) {
      throw new ForgeProviderStartError(
        error instanceof Error ? error.message : 'Forge provider thread setup failed.',
        'not_started',
        { cause: error }
      );
    }
    if (!threadId)
      throw new ForgeProviderStartError(
        'Codex did not return a Forge execution thread ID.',
        'not_started'
      );

    let resolve!: PendingTurn['resolve'];
    let reject!: PendingTurn['reject'];
    const completion = new Promise<ForgeProviderOutcome>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // A failed turn/start has no handle to expose this promise to a caller.
    void completion.catch(() => undefined);
    const pending: PendingTurn = {
      request,
      onStarted,
      onEvent,
      onApproval,
      approvals: new Map(),
      resolve,
      reject,
      completion,
      finished: false,
    };
    if (this.active.has(threadId))
      throw new ForgeProviderStartError(
        'Codex returned a thread ID that is already bound to a live Forge turn.',
        'not_started'
      );
    this.active.set(threadId, pending);
    try {
      const response = await this.options.client.startTurn(
        threadId,
        request.prompt,
        codexRole(request.role),
        request.model,
        request.effort,
        request.executionRoot,
        [...request.writeRoots],
        request.approvalPolicy,
        request.outputSchema
      );
      const turnId = response?.turn?.id ?? response?.turnId;
      if (typeof turnId !== 'string' || !turnId)
        throw new Error(
          'Codex accepted a Forge turn without returning its turn ID. The result cannot be safely attributed.'
        );
      await this.observeStarted(threadId, pending, turnId);
      const handle = pending.handle;
      if (!handle) throw new Error('Codex Forge runtime provenance was not recorded.');
      return handle;
    } catch (error) {
      if (pending.turnId)
        try {
          await this.options.client.interrupt(threadId, pending.turnId);
        } catch {
          /* The caller will persist an uncertain claim for recovery. */
        }
      if (!pending.finished) {
        pending.finished = true;
        pending.reject(error);
      }
      if (this.active.get(threadId) === pending) this.active.delete(threadId);
      const effect = error instanceof AppServerRequestError ? 'not_started' : 'uncertain';
      throw new ForgeProviderStartError(
        error instanceof Error ? error.message : 'Forge provider turn start failed.',
        effect,
        { cause: error }
      );
    }
  }

  async cancel(handle: ForgeProviderHandle): Promise<ForgeProviderCancelResult> {
    const pending = this.active.get(handle.threadId);
    if (!pending || pending.turnId !== handle.turnId) {
      const outcome = await Promise.race([
        handle.completion.then((value) => value),
        delay(0).then(() => undefined),
      ]);
      return outcome
        ? { status: outcome.status === 'completed' ? 'completed' : 'stopped', outcome }
        : { status: 'uncertain' };
    }
    let approvalsCancelled = true;
    for (const request of pending.approvals.values()) {
      try {
        this.options.client.respondServerRequest(
          request.requestId,
          approvalResponse(
            request.method,
            request.request.permissions ?? request.request.mode,
            'cancel'
          )
        );
        pending.approvals.delete(approvalKey(request.requestId));
      } catch {
        approvalsCancelled = false;
      }
    }
    try {
      await this.options.client.interrupt(handle.threadId, handle.turnId);
    } catch {
      return { status: 'uncertain' };
    }
    const outcome = await Promise.race([
      handle.completion.then((value) => value),
      delay(this.options.cancelWaitMs ?? 5000).then(() => undefined),
    ]);
    if (!outcome) return { status: 'uncertain' };
    if (!approvalsCancelled) return { status: 'uncertain', outcome };
    return {
      status:
        outcome.status === 'completed'
          ? 'completed'
          : outcome.status === 'unknown'
            ? 'uncertain'
            : 'stopped',
      outcome,
    };
  }

  /** Routes an app-server approval request only when its active Forge owner is known. */
  async handleServerRequest(id: string | number, method: string, params: any): Promise<boolean> {
    // Forge currently exposes no app-owned tools. Consume tool calls belonging
    // to a live Forge thread here so they cannot fall through to a Conversation
    // dispatcher that authorizes against unrelated task/pass state.
    if (method === 'item/tool/call') {
      const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
      const pending = threadId ? this.active.get(threadId) : undefined;
      if (!pending) return false;
      this.options.client.respondServerError(
        id,
        -32601,
        'Forge does not expose an app-owned tool for this execution. No application effect was applied.'
      );
      return true;
    }
    // Existing auth bridge owns this app-wide request.
    if (method === 'account/chatgptAuthTokens/refresh') return false;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const pending = threadId ? this.active.get(threadId) : undefined;
    if (!pending) return false;
    const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
    if (!turnId) {
      this.options.client.respondServerError(
        id,
        -32600,
        'Forge approval request omitted its provider turn identity; no permission was granted.'
      );
      return true;
    }
    if (!pending.turnId) {
      try {
        await this.observeStarted(threadId, pending, turnId);
      } catch {
        this.options.client.respondServerError(
          id,
          -32600,
          'Forge could not durably bind the approval to its provider turn; no permission was granted.'
        );
        return true;
      }
    }
    if (pending.turnId !== turnId) {
      this.options.client.respondServerError(
        id,
        -32600,
        'Stale Forge approval request; no permission was granted.'
      );
      return true;
    }
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
    ].includes(method);
    if (!supported) {
      this.options.client.respondServerError(
        id,
        -32601,
        'Unsupported Forge approval request; no permission was granted.'
      );
      return true;
    }
    const request = sanitizeApprovalRequest(id, method, params, pending);
    if (!pending.onApproval) {
      this.options.client.respondServerError(
        id,
        -32601,
        'Forge has no active approval handler; no permission was granted.'
      );
      return true;
    }
    const key = approvalKey(id);
    if (pending.approvals.has(key)) {
      this.options.client.respondServerError(
        id,
        -32600,
        'Duplicate Forge approval request; the saved request was not replaced.'
      );
      return true;
    }
    pending.approvals.set(key, request);
    try {
      await pending.onApproval(request);
    } catch {
      pending.approvals.delete(key);
      this.options.client.respondServerError(
        id,
        -32600,
        'Forge could not persist this approval request; no permission was granted.'
      );
    }
    return true;
  }

  respondApproval(input: ForgeProviderApprovalDecision): boolean {
    const { request, decision, content } = input;
    const pending = this.active.get(request.threadId);
    const key = approvalKey(request.requestId);
    const saved = pending?.approvals.get(key);
    if (
      !pending ||
      pending.turnId !== request.turnId ||
      !saved ||
      !sameApprovalIdentity(saved, request)
    )
      return false;
    this.options.client.respondServerRequest(
      saved.requestId,
      approvalResponse(
        saved.method,
        saved.request.permissions ?? saved.request.mode,
        decision,
        content
      )
    );
    pending.approvals.delete(key);
    return true;
  }

  dispose() {
    this.options.client.removeListener('notification', this.listener);
  }

  private onNotification(method: string, params: any) {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const pending = threadId ? this.active.get(threadId) : undefined;
    if (!pending) return;
    const turnId =
      method === 'turn/started' || method === 'turn/completed'
        ? typeof params?.turn?.id === 'string'
          ? params.turn.id
          : ''
        : typeof params?.turnId === 'string'
          ? params.turnId
          : '';
    if (method === 'turn/started' && turnId) {
      void this.observeStarted(threadId, pending, turnId).catch((error) =>
        this.fail(threadId, pending, error)
      );
      return;
    }
    if (method === 'turn/completed' && turnId) {
      if (pending.turnId && pending.turnId !== turnId) return;
      if (!pending.turnId) pending.completedTurn = params.turn;
      else void this.finish(threadId, pending, params.turn);
      return;
    }
    if (
      turnId &&
      pending.turnId === turnId &&
      (method === 'item/started' || method === 'item/completed' || method === 'turn/diff/updated')
    ) {
      const event: ForgeProviderEvent = {
        method,
        params,
        role: pending.request.role,
        ticketId: pending.request.ticketId,
        taskId: pending.request.taskId,
        threadId,
        turnId,
      };
      void Promise.resolve(pending.onEvent?.(event)).catch(() => undefined);
    }
  }

  private async observeStarted(threadId: string, pending: PendingTurn, turnId: string) {
    if (pending.turnId && pending.turnId !== turnId)
      throw new Error('Codex reported conflicting turn IDs for one Forge dispatch.');
    pending.turnId = turnId;
    if (!pending.started) {
      pending.started = Promise.resolve(
        pending.onStarted?.({
          provider: 'codex',
          role: pending.request.role,
          ticketId: pending.request.ticketId,
          taskId: pending.request.taskId,
          threadId,
          turnId,
          model: pending.request.model,
          effort: pending.request.effort,
          observedAt: new Date().toISOString(),
        })
      );
    }
    await pending.started;
    pending.handle ??= {
      provider: 'codex',
      role: pending.request.role,
      ticketId: pending.request.ticketId,
      taskId: pending.request.taskId,
      threadId,
      turnId,
      model: pending.request.model,
      effort: pending.request.effort,
      observedAt: new Date().toISOString(),
      completion: pending.completion,
    };
    if (pending.completedTurn?.id === turnId)
      await this.finish(threadId, pending, pending.completedTurn);
  }

  private async finish(threadId: string, pending: PendingTurn, turn: any) {
    if (pending.finished || pending.turnId !== turn?.id) return;
    try {
      await pending.started;
    } catch (error) {
      this.fail(threadId, pending, error);
      return;
    }
    pending.finished = true;
    pending.approvals.clear();
    pending.resolve(terminalOutcome(turn));
    if (this.active.get(threadId) === pending) this.active.delete(threadId);
  }

  private fail(threadId: string, pending: PendingTurn, error: unknown) {
    if (pending.finished) return;
    pending.finished = true;
    pending.reject(error);
    if (this.active.get(threadId) === pending) this.active.delete(threadId);
  }
}

function approvalKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}

function sanitizeApprovalRequest(
  id: string | number,
  method: string,
  params: any,
  pending: PendingTurn
): ForgeProviderApprovalRequest {
  const boundedString = (value: unknown, max = 2000) =>
    typeof value === 'string' ? value.slice(0, max) : undefined;
  const request: Record<string, unknown> = {};
  for (const field of [
    'reason',
    'command',
    'cwd',
    'grantRoot',
    'kind',
    'networkHost',
    'networkProtocol',
    'serverName',
    'mode',
    'message',
    'url',
  ]) {
    const value = boundedString(params?.[field]);
    if (value !== undefined) request[field] = value;
  }
  if (Array.isArray(params?.availableDecisions))
    request.availableDecisions = params.availableDecisions
      .filter((value: unknown) => typeof value === 'string')
      .slice(0, 20)
      .map((value: string) => value.slice(0, 80));
  if (
    params?.permissions &&
    typeof params.permissions === 'object' &&
    !Array.isArray(params.permissions)
  )
    request.permissions = params.permissions;
  if (
    params?.requestedSchema &&
    typeof params.requestedSchema === 'object' &&
    !Array.isArray(params.requestedSchema)
  )
    request.requestedSchema = params.requestedSchema;
  return {
    requestId: id,
    method,
    threadId: pending.handle?.threadId || String(params?.threadId || ''),
    turnId: pending.turnId!,
    itemId: String(params?.itemId || ''),
    role: pending.request.role,
    ticketId: pending.request.ticketId,
    taskId: pending.request.taskId,
    request,
  };
}

function sameApprovalIdentity(
  left: ForgeProviderApprovalRequest,
  right: ForgeProviderApprovalRequest
) {
  return (
    left.requestId === right.requestId &&
    left.method === right.method &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.itemId === right.itemId &&
    left.role === right.role &&
    left.ticketId === right.ticketId &&
    left.taskId === right.taskId
  );
}
