import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ForgeCoordinator } from '../server/forge-coordinator.js';
import { upgradeStoredState, saveProjectInState } from '../server/state.js';
import type { ForgeProviderApprovalRequest, ForgeProviderEvent, ForgeProviderHandle, ForgeProviderOutcome, ForgeProviderRequest, ForgeProviderStartEvidence } from '../server/forge-provider.js';

const root = 'D:/programming/opnex-forge-private/runtime-high';
const projectId = '11111111-1111-4111-8111-111111111111';
const receipt = {
  status: 'complete', result: 'Implemented the accepted assignment.', changes: ['src/feature.ts'],
  acceptance: { met: ['The feature exists.'], unmet: [] },
  verification: [{ check: 'Worker commit', result: 'passed', evidence: 'Host observed an in-scope commit.' }],
  risks: [], knowledge: { consulted: [], updated: [] }, decision_required: null,
};
const assignment = {
  outcome: 'Implement the requested feature.', deliverable: 'src/feature.ts', read_scope: ['src'], write_scope: ['src'],
  exclusions: [], constraints: [], context_refs: [], acceptance: ['The feature exists.'], verification: ['The candidate check passes.'],
  ordinary_authority: ['Make ordinary implementation decisions.'], escalation_conditions: ['A public interface must change.'], receipt_requirements: ['Return a complete receipt.'],
};

function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim(); }
function objectFromPrompt(prompt: string, label: string) {
  const at = prompt.indexOf(`${label}:\n`);
  if (at < 0) throw new Error(`Fixture prompt omitted ${label}.`);
  const start = prompt.indexOf('{', at);
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < prompt.length; i++) {
    const char = prompt[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(prompt.slice(start, i + 1));
  }
  throw new Error(`Fixture prompt has malformed ${label}.`);
}

describe('Forge runtime lifecycle on a disposable repository', () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
  let fixture = '';
  let testRepo = '';
  const children: ChildProcess[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.resetModules();
    for (const child of children.splice(0)) if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>((resolve) => child.once('exit', () => resolve())); }
    if (testRepo) {
      try {
        const worktrees = git(testRepo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)).filter((row) => path.resolve(row) !== path.resolve(testRepo));
        for (const worktree of worktrees) try { git(testRepo, 'worktree', 'remove', '--force', worktree); } catch { /* The fixture root is disposable. */ }
      } catch { /* The fixture root is disposable. */ }
    }
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = ''; testRepo = '';
  });

  it('plans, claims, verifies, integrates, reviews, and reads back a guarded local main merge', async () => {
    await mkdir(root, { recursive: true });
    fixture = await mkdtemp(path.join(root, 'h-'));
    const repo = path.join(fixture, 'r'); const worktrees = path.join(fixture, 'w');
    testRepo = repo;
    await mkdir(repo); await mkdir(path.join(repo, 'src')); await mkdir(worktrees);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'core.longpaths', 'true'); git(repo, 'config', 'user.name', 'Forge fixture'); git(repo, 'config', 'user.email', 'forge@example.invalid');
    await writeFile(path.join(repo, 'src', 'base.ts'), 'export const base = true;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline');

    const state = upgradeStoredState({ version: 7, revision: 0, settings: { approvalPolicy: 'on-request', executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' } }, tasks: [], projects: [], selectedProjectId: null, expandedProjectIds: ['unclassified'] });
    saveProjectInState(state, { id: projectId, projectRoot: repo, needsLocation: false, pinned: false });
    let sequence = 0;
    const requests: Array<{ request: ForgeProviderRequest; handle: ForgeProviderHandle; resolve: (outcome: ForgeProviderOutcome) => void }> = [];
    const startRole = async (request: ForgeProviderRequest, onStarted?: (evidence: ForgeProviderStartEvidence) => void | Promise<void>, onEvent?: (event: ForgeProviderEvent) => void | Promise<void>, onApproval?: (approval: ForgeProviderApprovalRequest) => void | Promise<void>) => {
      const id = ++sequence; const threadId = `fixture-thread-${id}`; const turnId = `fixture-turn-${id}`;
      const observedAt = new Date().toISOString();
      const evidence: ForgeProviderStartEvidence = { provider: 'codex', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, model: request.model, effort: request.effort, observedAt };
      await onStarted?.(evidence);
      let resolve!: (outcome: ForgeProviderOutcome) => void;
      const completion = new Promise<ForgeProviderOutcome>((done) => { resolve = done; });
      const handle: ForgeProviderHandle = { ...evidence, completion };
      requests.push({ request, handle, resolve });
      if (request.prompt.startsWith('Create one complete Forge execution plan')) await onApproval?.({ requestId: 700, method: 'item/commandExecution/requestApproval', itemId: 'plan-approval', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, request: { command: 'git status', availableDecisions: ['accept', 'decline'] } });
      if (request.role === 'integrator') {
        const command = 'git status --short'; git(request.executionRoot, 'status', '--short');
        await onEvent?.({ method: 'item/started', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, params: { item: { id: `check-${id}`, type: 'commandExecution', command } } });
        await onEvent?.({ method: 'item/completed', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, params: { item: { id: `check-${id}`, type: 'commandExecution', command, exitCode: 0, status: 'completed' } } });
      }
      return handle;
    };
    const coordinator = new ForgeCoordinator({
      getState: () => state,
      mutate: async (fn) => { fn(state); state.revision++; },
      startRole,
      cancelRole: async () => ({ status: 'stopped' }),
      respondApproval: () => true,
      stateRoot: worktrees,
      now: () => new Date().toISOString(),
    });
    const ticket = await coordinator.create({ projectId, title: 'Lifecycle fixture', description: 'Write one feature file.', acceptanceCriteria: ['Feature file is merged.'], scope: { read: ['src'], write: ['src'], knowledge: ['knowledge/opnex'] }, orchestrator: { model: 'gpt-6.1-terra', effort: 'low' }, workerProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' } });
    expect(ticket.phase).toBe('draft');
    await coordinator.start(ticket.id);
    const planning = requests.at(-1)!;
    const savedApproval = state.tasks.find((task) => task.id === ticket.id)!.approvalRequests![0];
    expect(savedApproval).toMatchObject({ requestId: 700, threadId: planning.handle.threadId, turnId: planning.handle.turnId, forgeContext: { ticketId: ticket.id, targetId: planning.request.taskId } });
    await coordinator.approve(ticket.id, savedApproval.requestId, { decision: 'decline' });
    expect(state.tasks.find((task) => task.id === ticket.id)!.approvalRequests).toEqual([]);
    const knowledgeSkill = state.tasks.find((task) => task.id === ticket.id)!.forge!.orchestratorSkills.find((skill) => skill.name === 'agentmem-project')!;
    const plan = { type: 'plan', knowledgeOperations: 0, tasks: [
      { id: 'feature-a', title: 'Add first feature', description: 'Create src/feature-a.ts.', dependencyIds: [], assignment, knowledgeScope: ['knowledge/opnex'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, skillIds: [knowledgeSkill.id] },
      { id: 'feature-b', title: 'Add dependent feature', description: 'Create src/feature-b.ts after feature-a.', dependencyIds: ['feature-a'], assignment, knowledgeScope: ['knowledge/opnex'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, skillIds: [knowledgeSkill.id] },
    ] };
    planning.resolve({ status: 'completed', text: JSON.stringify(plan), turn: { id: planning.handle.turnId, status: 'completed' } });
    await waitFor(() => !!coordinator.getTicket(ticket.id)?.proposedPlan, 5_000, () => JSON.stringify(coordinator.getTicket(ticket.id)));
    const accepted = await coordinator.start(ticket.id, 1);
    expect(accepted.workitems[0]).toMatchObject({ id: 'feature-a', state: 'claimed' });
    const worker = requests.at(-1)!;
    expect(worker.request.role).toBe('worker');
    const workerFile = 'src/feature-1.ts';
    await writeFile(path.join(worker.request.executionRoot, workerFile), 'export const feature_1 = true;\n');
    git(worker.request.executionRoot, 'add', workerFile); git(worker.request.executionRoot, 'commit', '-m', 'worker feature one');
    worker.resolve({ status: 'completed', text: JSON.stringify({ type: 'receipt', receipt, decision_needed: null, evidence: [], options: [], recommendation: null, consequences: [], knowledgeOperations: 0 }), turn: { id: worker.handle.turnId, status: 'completed' } });
    await waitFor(() => requests.filter((row) => row.request.role === 'worker').length === 2, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, workitems: coordinator.getTicket(ticket.id)?.workitems }));
    const dependent = requests.at(-1)!;
    expect(coordinator.getTicket(ticket.id)?.attempts.at(-1)?.dispatchBaselineSha).not.toBe(coordinator.getTicket(ticket.id)?.attempts.at(-1)?.sourceBaselineSha);
    const dependentFile = 'src/feature-2.ts';
    await writeFile(path.join(dependent.request.executionRoot, dependentFile), 'export const feature_2 = true;\n');
    git(dependent.request.executionRoot, 'add', dependentFile); git(dependent.request.executionRoot, 'commit', '-m', 'worker feature two');
    dependent.resolve({ status: 'completed', text: JSON.stringify({ type: 'receipt', receipt: { ...receipt, changes: [dependentFile] }, decision_needed: null, evidence: [], options: [], recommendation: null, consequences: [], knowledgeOperations: 0 }), turn: { id: dependent.handle.turnId, status: 'completed' } });
    await waitFor(() => requests.at(-1)?.request.role === 'integrator', 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, integration: coordinator.getTicket(ticket.id)?.integration.runs.map(({ status, failureReason }) => ({ status, failureReason })), roles: requests.map(({ request }) => request.role) }));
    const integrator = requests.at(-1)!;
    expect(integrator.request.role).toBe('integrator');
    const pinned = objectFromPrompt(integrator.request.prompt, 'PINNED CANDIDATE');
    const integrated = { type: 'integration', knowledgeOperations: 0, receipt: { ...receipt, changes: ['src/feature-1.ts', 'src/feature-2.ts'], verification: [{ check: 'Candidate Git check', result: 'passed', evidence: 'git status --short exited 0' }] }, workerReceipts: pinned.workerReceipts.map((row: any) => ({ taskId: row.taskId, attemptId: row.attemptId, receiptId: row.receiptId, receipt: row.receipt })), scopeValidation: { status: 'passed', evidence: ['Worker commits are in scope.'] }, verification: [{ check: 'Candidate Git check', result: 'passed', evidence: 'git status --short' }], findings: [], corrections: [] };
    integrator.resolve({ status: 'completed', text: JSON.stringify(integrated), turn: { id: integrator.handle.turnId, status: 'completed' } });
    await waitFor(() => coordinator.getTicket(ticket.id)?.phase === 'review');
    await waitFor(() => requests.at(-1)?.request.role === 'orchestrator' && requests.at(-1)?.request.taskId !== ticket.id && requests.at(-1)?.request.taskId !== planning.request.taskId, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, runs: coordinator.getTicket(ticket.id)?.orchestratorRuns.map(({ purpose, status, failureReason }) => ({ purpose, status, failureReason })), roles: requests.map(({ request }) => [request.role, request.taskId]) }));
    const review = requests.at(-1)!;
    const identity = objectFromPrompt(review.request.prompt, 'CANDIDATE IDENTITY');
    review.resolve({ status: 'completed', text: JSON.stringify({ type: 'review', knowledgeOperations: 0, ...identity, disposition: 'accept', note: 'The combined receipt, checks, and diff are accepted.', corrections: [] }), turn: { id: review.handle.turnId, status: 'completed' } });
    await waitFor(() => coordinator.getTicket(ticket.id)?.phase === 'complete', 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, mergeReadbacks: coordinator.getTicket(ticket.id)?.integration.mergeReadbacks, attention: coordinator.getTicket(ticket.id)?.attentionReason }));
    const done = coordinator.getTicket(ticket.id)!;
    const targetHead = git(repo, 'rev-parse', 'main');
    expect(done.integration.mergeReadbacks).toEqual([expect.objectContaining({ result: 'merged', commitReadbackSha: targetHead, observedMainSha: targetHead })]);
    expect(done.workitems.map((item) => item.state)).toEqual(['finished', 'finished']);
    expect(done.receipts[0].hostAttestation).toMatchObject({ status: 'verified', commitObserved: true, scopeValidation: 'passed' });
    expect(done.integration.candidates[0].candidateSha).not.toBe(done.integration.candidates[0].targetMainSha);
    expect(state.tasks.find((task) => task.id === ticket.id)!.toolCalls?.calls).toHaveLength(1);
    expect(requests.map((row) => row.request.role)).toEqual(['orchestrator', 'worker', 'worker', 'integrator', 'orchestrator']);
    expect(git(repo, 'show', 'main:src/feature-1.ts')).toContain('feature_1 = true');
    expect(git(repo, 'show', 'main:src/feature-2.ts')).toContain('feature_2 = true');
  });

  it('serves the Forge create, read, guarded start, and cancel routes over HTTP', async () => {
    await mkdir(root, { recursive: true });
    fixture = await mkdtemp(path.join(root, 'api-'));
    const repo = path.join(fixture, 'r'); const data = path.join(fixture, 'd');
    await mkdir(path.join(repo, 'src'), { recursive: true }); await mkdir(data);
    const codexHome = path.join(fixture, 'codex'); await mkdir(codexHome);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'core.longpaths', 'true'); git(repo, 'config', 'user.name', 'Forge API fixture'); git(repo, 'config', 'user.email', 'forge@example.invalid');
    await writeFile(path.join(repo, 'src', 'base.ts'), 'export const base = true;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline');
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: '0', PSEUDOHARNESS_DATA_DIR: data, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    let output = ''; child.stdout?.on('data', (chunk) => { output += String(chunk); }); child.stderr?.on('data', (chunk) => { output += String(chunk); });
    await waitFor(() => !!output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/));
    const origin = `http://127.0.0.1:${output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1]}`;
    await waitFor(async () => (await fetch(`${origin}/api/health`).catch(() => undefined))?.ok);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { csrf: string };
    const headers = { origin, 'content-type': 'application/json', 'x-pseudoharness-token': bootstrap.csrf };
    const projectResponse = await fetch(`${origin}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ id: projectId, name: 'Fixture', projectRoot: repo, pinned: false }) });
    expect(projectResponse.status).toBe(200);
    const createdResponse = await fetch(`${origin}/api/forge/tickets`, { method: 'POST', headers, body: JSON.stringify({ projectId, title: 'HTTP ticket', description: 'Exercise the Forge HTTP contract.', acceptanceCriteria: ['The draft is saved.'], scope: { read: ['src'], write: ['src'], knowledge: ['knowledge/opnex'] }, orchestrator: { model: 'gpt-6.1-terra', effort: 'low' }, workerProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, skillIds: [] }) });
    const created = await createdResponse.json();
    expect(createdResponse.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({ projectId, phase: 'draft', title: 'HTTP ticket', targetBranch: 'main' });
    expect((await (await fetch(`${origin}/api/forge/tickets/${created.id}`)).json()).id).toBe(created.id);
    const eventResponse = await fetch(`${origin}/events`);
    const eventReader = eventResponse.body!.getReader();
    const eventText = new TextDecoder().decode((await eventReader.read()).value);
    expect(eventText).toContain(`"id":"${created.id}"`);
    expect(eventText).toContain('"sessionType":"forge"');
    await eventReader.cancel();
    const staleStart = await fetch(`${origin}/api/forge/tickets/${created.id}/start`, { method: 'POST', headers, body: JSON.stringify({ planRevision: 1 }) });
    expect(staleStart.status).toBe(409);
    const cancelled = await fetch(`${origin}/api/forge/tickets/${created.id}/cancel`, { method: 'POST', headers, body: '{}' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ id: created.id, phase: 'cancelled' });
    const saved = await fetch(`${origin}/api/forge/tickets/${created.id}`);
    expect((await saved.json()).phase).toBe('cancelled');
    if (child.exitCode !== null) throw new Error(`Forge API kernel exited early: ${output}`);
  });
});

async function waitFor(check: () => boolean | undefined | Promise<unknown>, timeoutMs = 5_000, details: () => string = () => '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Forge lifecycle fixture did not reach the expected persisted phase. ${details()}`);
}
