import type { PassTokenUsage, Task, TaskPass, WorkflowRole } from '../types';

const roleFields: readonly [WorkflowRole, keyof TaskPass][] = [
  ['router', 'routerThreadId'],
  ['direct', 'directThreadId'],
  ['simple', 'simpleThreadId'],
  ['orchestrator', 'orchestratorThreadId'],
  ['worker', 'workerThreadId'],
];

export type SessionThreadUsage = {
  threadId: string;
  role: WorkflowRole;
  status: 'available' | 'pending' | 'unavailable' | 'not-reported';
  tokens?: PassTokenUsage;
  latestPassIndex: number;
};

export type SessionUsageBucket = {
  totalTokens: bigint | null;
  expectedThreads: number;
  reportedThreads: number;
  pendingThreads: number;
  unavailableThreads: number;
  notReportedThreads: number;
  authoritativeThreads: number;
  estimatedThreads: number;
  status: 'not-used' | 'available' | 'partial' | 'pending' | 'unavailable' | 'not-reported';
};

export type SessionUsageSummary = {
  total: SessionUsageBucket;
  other: SessionUsageBucket;
  roles: Record<WorkflowRole, SessionUsageBucket>;
  threads: SessionThreadUsage[];
};

type Candidate = SessionThreadUsage & { updatedAt?: string };

function validTokenUsage(tokens: PassTokenUsage | undefined): tokens is PassTokenUsage {
  return !!tokens && Number.isSafeInteger(tokens.totalTokens) && tokens.totalTokens >= 0;
}

function usageStatus(pass: TaskPass, role: WorkflowRole, threadId: string) {
  const entry = pass.usage?.[role];
  if (entry?.threadId !== threadId) return { status: 'not-reported' as const };
  if (entry.tokenStatus === 'available' && validTokenUsage(entry.tokens)) {
    return { status: 'available' as const, tokens: entry.tokens, updatedAt: entry.updatedAt };
  }
  if (entry.tokenStatus === 'pending') return { status: 'pending' as const };
  if (entry.tokenStatus === 'unavailable') return { status: 'unavailable' as const };
  return { status: 'not-reported' as const };
}

function statusWithoutValue(a: Candidate['status'], b: Candidate['status']): Candidate['status'] {
  if (a === 'pending' || b === 'pending') return 'pending';
  if (a === 'unavailable' || b === 'unavailable') return 'unavailable';
  return 'not-reported';
}

function sourceRank(tokens: PassTokenUsage | undefined) {
  if (tokens?.source === 'thread') return 2;
  if (tokens?.source === 'thread-estimate') return 1;
  return 0;
}

function isPreferredSnapshot(next: Candidate, current: Candidate) {
  const nextRank = sourceRank(next.tokens);
  const currentRank = sourceRank(current.tokens);
  if (nextRank !== currentRank) return nextRank > currentRank;

  const nextTotal = next.tokens?.totalTokens ?? -1;
  const currentTotal = current.tokens?.totalTokens ?? -1;
  if (nextTotal !== currentTotal) return nextTotal > currentTotal;
  return (next.updatedAt || '') > (current.updatedAt || '');
}

function candidateFor(pass: TaskPass, role: WorkflowRole, threadId: string): Candidate {
  const snapshot = usageStatus(pass, role, threadId);
  return {
    threadId,
    role,
    latestPassIndex: pass.index,
    ...snapshot,
  };
}

function considerPass(threads: Map<string, Candidate>, pass: TaskPass) {
  for (const [role, field] of roleFields) {
    const threadId = pass[field];
    if (typeof threadId !== 'string' || !threadId) continue;

    const next = candidateFor(pass, role, threadId);
    const current = threads.get(threadId);
    if (!current) {
      threads.set(threadId, next);
      continue;
    }

    // Follow-up passes can refer to the same Codex thread. Its total is cumulative,
    // so keep one strongest snapshot instead of adding pass snapshots together.
    const selected = isPreferredSnapshot(next, current) ? next : current;
    const roleOwner = next.latestPassIndex >= current.latestPassIndex ? next : current;
    threads.set(threadId, {
      ...selected,
      role: roleOwner.role,
      latestPassIndex: Math.max(current.latestPassIndex, next.latestPassIndex),
      status: selected.tokens ? 'available' : statusWithoutValue(current.status, next.status),
    });
  }
}

function considerTaskLevelThreads(threads: Map<string, Candidate>, task: Task) {
  const pass: TaskPass = {
    id: task.currentPassId || 'current-task',
    index: task.passes?.length ? Math.max(...task.passes.map((row) => row.index)) + 1 : 1,
    createdAt: task.updatedAt,
    userInput: '',
    userInputs: [],
    userMessageIds: [],
    phase: task.phase,
    correctionCount: task.correctionCount,
    processedTurns: [],
    routerThreadId: task.routerThreadId,
    directThreadId: task.directThreadId,
    simpleThreadId: task.simpleThreadId,
    orchestratorThreadId: task.orchestratorThreadId,
    workerThreadId: task.workerThreadId,
    activeRole: task.activeRole,
  };
  for (const [role, field] of roleFields) {
    const threadId = pass[field];
    if (typeof threadId === 'string' && threadId && !threads.has(threadId)) {
      threads.set(threadId, candidateFor(pass, role, threadId));
    }
  }
}

function summarize(threads: SessionThreadUsage[]): SessionUsageBucket {
  const bucket = {
    expectedThreads: threads.length,
    reportedThreads: 0,
    pendingThreads: 0,
    unavailableThreads: 0,
    notReportedThreads: 0,
    authoritativeThreads: 0,
    estimatedThreads: 0,
  };
  let totalTokens = 0n;

  for (const thread of threads) {
    if (thread.status === 'available' && thread.tokens) {
      bucket.reportedThreads += 1;
      totalTokens += BigInt(thread.tokens.totalTokens);
      if (thread.tokens.source === 'thread') bucket.authoritativeThreads += 1;
      else bucket.estimatedThreads += 1;
    } else if (thread.status === 'pending') {
      bucket.pendingThreads += 1;
    } else if (thread.status === 'unavailable') {
      bucket.unavailableThreads += 1;
    } else {
      bucket.notReportedThreads += 1;
    }
  }

  let status: SessionUsageBucket['status'];
  if (bucket.expectedThreads === 0) status = 'not-used';
  else if (bucket.reportedThreads === bucket.expectedThreads) status = 'available';
  else if (bucket.reportedThreads > 0) status = 'partial';
  else if (bucket.pendingThreads > 0) status = 'pending';
  else if (bucket.unavailableThreads === bucket.expectedThreads) status = 'unavailable';
  else status = 'not-reported';

  return { ...bucket, totalTokens: bucket.reportedThreads ? totalTokens : null, status };
}

export function getCurrentTaskPass(task: Task | null): TaskPass | undefined {
  if (!task) return undefined;
  const passes = task.passes || [];
  return passes.find((pass) => pass.id === task.currentPassId) || passes[passes.length - 1];
}

export function summarizeSessionUsage(task: Task | null): SessionUsageSummary {
  const threadMap = new Map<string, Candidate>();
  if (task) {
    for (const pass of task.passes || []) considerPass(threadMap, pass);
    considerTaskLevelThreads(threadMap, task);
  }

  const threads = [...threadMap.values()].sort((a, b) => a.latestPassIndex - b.latestPassIndex || a.role.localeCompare(b.role) || a.threadId.localeCompare(b.threadId));
  const roles = Object.fromEntries(roleFields.map(([role]) => [role, summarize(threads.filter((thread) => thread.role === role))])) as Record<WorkflowRole, SessionUsageBucket>;
  const other = summarize(threads.filter((thread) => thread.role !== 'orchestrator' && thread.role !== 'worker'));
  return { total: summarize(threads), other, roles, threads };
}
