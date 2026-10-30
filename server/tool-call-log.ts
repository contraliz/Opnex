export type ToolCallStatus = 'started' | 'completed' | 'failed' | 'interrupted';
export type ToolCallSource = 'application' | 'model';

export type ToolCallIdentity = {
  /** Provider or harness that issued the invocation. */
  provider: string;
  agentId: string;
  threadId: string;
  turnId: string;
  /** Provider toolCallId when available; otherwise a caller-issued unique invocation ID. */
  callId: string;
};

export type ToolCallEvent = {
  identity: ToolCallIdentity;
  name: string;
  type: string;
  source: ToolCallSource;
  lifecycle: ToolCallStatus;
  timestamp: string;
  agentRole?: string;
  /** Caller-provided safe summary; raw arguments and results are intentionally not accepted. */
  summary?: string;
};

export type ToolCallRecord = {
  key: string;
  identity: ToolCallIdentity;
  name: string;
  type: string;
  status: ToolCallStatus;
  sources: ToolCallSource[];
  firstSeenAt: string;
  lastSeenAt: string;
  startedAt?: string;
  finishedAt?: string;
  agentRole?: string;
  summary?: string;
};

export type ToolCallLog = {
  schemaVersion: 1;
  total: number;
  statusCounts: Record<ToolCallStatus, number>;
  /** Exact dedup index retained after detail rows are omitted. */
  seen: Record<string, ToolCallStatus>;
  calls: ToolCallRecord[];
  omittedCount: number;
};

// shortcut: detailed rows stop at 1000 while exact dedup keeps one compact status entry per unique invocation.
const MAX_DETAILS = 1000;
const MAX_ID_PART = 256;
const MAX_LABEL = 160;
const MAX_ROLE = 80;
const MAX_TIMESTAMP = 64;
const MAX_SUMMARY = 500;
const terminalStatuses = new Set<ToolCallStatus>(['completed', 'failed', 'interrupted']);

export function createToolCallLog(): ToolCallLog {
  return {
    schemaVersion: 1,
    total: 0,
    statusCounts: { started: 0, completed: 0, failed: 0, interrupted: 0 },
    seen: {},
    calls: [],
    omittedCount: 0,
  };
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, max);
}

function identityKey(identity: ToolCallIdentity): string {
  const parts = [identity.provider, identity.agentId, identity.threadId, identity.turnId, identity.callId];
  if (parts.some(part => typeof part !== 'string' || part.length === 0 || part.length > MAX_ID_PART)) {
    throw new RangeError(`Tool call identity parts must be non-empty strings up to ${MAX_ID_PART} characters.`);
  }
  // JSON tuple encoding keeps every caller-supplied identity field distinct without delimiter collisions.
  return JSON.stringify(parts);
}

function statusAfter(previous: ToolCallStatus | undefined, lifecycle: ToolCallStatus): ToolCallStatus {
  if (!previous || previous === 'started' && terminalStatuses.has(lifecycle)) return lifecycle;
  return previous;
}

function increment(value: number, amount = 1): number {
  const next = value + amount;
  if (!Number.isSafeInteger(next)) throw new RangeError('Tool call totals exceeded the safe integer limit.');
  return next;
}

export function recordToolCall(log: ToolCallLog, event: ToolCallEvent): ToolCallLog {
  const key = identityKey(event.identity);
  const timestamp = bounded(event.timestamp, MAX_TIMESTAMP);
  if (!timestamp) throw new TypeError('Tool call timestamp must be a non-empty string.');
  if (event.source !== 'application' && event.source !== 'model') throw new TypeError('Unknown tool call source.');
  if (!['started', 'completed', 'failed', 'interrupted'].includes(event.lifecycle)) throw new TypeError('Unknown tool call lifecycle.');
  if (typeof event.name !== 'string' || !event.name || typeof event.type !== 'string' || !event.type) {
    throw new TypeError('Tool call name and type must be non-empty strings.');
  }

  const previousStatus = log.seen[key];
  const status = statusAfter(previousStatus, event.lifecycle);
  const isNew = previousStatus === undefined;
  const counts = { ...log.statusCounts };
  if (isNew) counts[status] = increment(counts[status]);
  else if (status !== previousStatus) {
    counts[previousStatus] -= 1;
    counts[status] = increment(counts[status]);
  }

  const oldRecord = log.calls.find(row => row.key === key);
  const sources = [...new Set([...(oldRecord?.sources || []), event.source])].sort() as ToolCallSource[];
  const summary = bounded(event.summary, MAX_SUMMARY);
  const total = isNew ? increment(log.total) : log.total;
  const record: ToolCallRecord = {
    key,
    identity: {
      provider: event.identity.provider,
      agentId: event.identity.agentId,
      threadId: event.identity.threadId,
      turnId: event.identity.turnId,
      callId: event.identity.callId,
    },
    name: event.name.slice(0, MAX_LABEL),
    type: event.type.slice(0, MAX_LABEL),
    status,
    sources,
    firstSeenAt: oldRecord?.firstSeenAt || timestamp,
    lastSeenAt: timestamp,
    ...(oldRecord?.startedAt || event.lifecycle === 'started' ? { startedAt: oldRecord?.startedAt || timestamp } : {}),
    ...(oldRecord?.finishedAt || terminalStatuses.has(event.lifecycle) ? { finishedAt: oldRecord?.finishedAt || timestamp } : {}),
    ...(bounded(event.agentRole, MAX_ROLE) || oldRecord?.agentRole ? { agentRole: bounded(event.agentRole, MAX_ROLE) || oldRecord?.agentRole } : {}),
    ...(summary || oldRecord?.summary ? { summary: summary || oldRecord?.summary } : {}),
  };
  const calls = oldRecord
    ? log.calls.map(row => row.key === key ? record : row)
    : isNew ? [...log.calls, record].slice(-MAX_DETAILS) : log.calls;

  return {
    ...log,
    total,
    statusCounts: counts,
    seen: { ...log.seen, [key]: status },
    calls,
    omittedCount: total - calls.length,
  };
}

export function interruptRunningToolCalls(log: ToolCallLog, at: string): ToolCallLog {
  const timestamp = bounded(at, MAX_TIMESTAMP);
  if (!timestamp) throw new TypeError('Interruption timestamp must be a non-empty string.');
  const runningKeys = new Set(Object.keys(log.seen).filter(key => log.seen[key] === 'started'));
  if (!runningKeys.size) return log;

  const seen = { ...log.seen };
  for (const key of runningKeys) seen[key] = 'interrupted';
  const statusCounts = {
    ...log.statusCounts,
    started: log.statusCounts.started - runningKeys.size,
    interrupted: increment(log.statusCounts.interrupted, runningKeys.size),
  };
  const calls = log.calls.map(row => runningKeys.has(row.key)
    ? { ...row, status: 'interrupted' as const, lastSeenAt: timestamp, finishedAt: timestamp }
    : row);
  return { ...log, seen, statusCounts, calls };
}
