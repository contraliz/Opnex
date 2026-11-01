import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ForgeCoordinator } from '../server/forge-coordinator.js';
import { upgradeStoredState, saveProjectInState } from '../server/state.js';
import type { ForgeProviderApprovalRequest, ForgeProviderEvent, ForgeProviderHandle, ForgeProviderOutcome, ForgeProviderRequest, ForgeProviderStartEvidence } from '../server/forge-provider.js';

const root = path.join(os.tmpdir(), 'opx');
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
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
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
    fixture = await realpath(await mkdtemp(path.join(root, 'h-')));
    const codexHome = path.join(fixture, 'codex'); await mkdir(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
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
    expect(requests).toHaveLength(0);
    await coordinator.start(ticket.id);
    expect(requests.map((row) => row.request.role)).toEqual(['orchestrator']);
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
    await waitFor(() => requests.filter((row) => row.request.role === 'worker').length === 1);
    const accepted = coordinator.getTicket(ticket.id)!;
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
    const integrated = { type: 'integration', knowledgeOperations: 0, receipt: { ...receipt, changes: ['src/feature-1.ts', 'src/feature-2.ts'], verification: [{ check: 'Candidate Git check', result: 'passed', evidence: 'git status --short exited 0' }] }, workerReceipts: pinned.workerReceipts.map((row: any) => ({ taskId: row.taskId, attemptId: row.attemptId, receiptId: row.receiptId, receipt: row.receipt })), scopeValidation: { status: 'passed', evidence: ['Worker commits are in scope.'] }, verification: [{ check: 'Candidate Git check', result: 'passed', evidence: 'git status --short' }], findings: [{ id: 'finding-b', taskId: 'feature-b', title: 'Correction fixture', issue: 'The dependent change needs one bounded correction.', requiredFix: 'Update the dependent feature implementation.', evidence: ['The fixture asks for a correction round.'] }], corrections: [{ taskId: 'feature-b', findingIds: ['finding-b'], assignment, knowledgeScope: ['knowledge/opnex'], skillIds: [knowledgeSkill.id] }] };
    integrator.resolve({ status: 'completed', text: JSON.stringify(integrated), turn: { id: integrator.handle.turnId, status: 'completed' } });
    await waitFor(() => requests.filter((row) => row.request.role === 'worker').length === 3, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, rounds: coordinator.getTicket(ticket.id)?.integration.correctionRounds }));
    const correctionWorker = requests.filter((row) => row.request.role === 'worker').at(-1)!;
    await writeFile(path.join(correctionWorker.request.executionRoot, dependentFile), 'export const feature_2 = true;\nexport const correction_applied = true;\n');
    git(correctionWorker.request.executionRoot, 'add', dependentFile); git(correctionWorker.request.executionRoot, 'commit', '-m', 'correct dependent feature');
    correctionWorker.resolve({ status: 'completed', text: JSON.stringify({ type: 'receipt', receipt: { ...receipt, changes: [dependentFile] }, decision_needed: null, evidence: [], options: [], recommendation: null, consequences: [], knowledgeOperations: 0 }), turn: { id: correctionWorker.handle.turnId, status: 'completed' } });
    await waitFor(() => requests.filter((row) => row.request.role === 'integrator').length === 2, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, roles: requests.map(({ request }) => request.role) }));
    const finalIntegrator = requests.filter((row) => row.request.role === 'integrator').at(-1)!;
    const repinned = objectFromPrompt(finalIntegrator.request.prompt, 'PINNED CANDIDATE');
    const correctedIntegration = { ...integrated, workerReceipts: repinned.workerReceipts.map((row: any) => ({ taskId: row.taskId, attemptId: row.attemptId, receiptId: row.receiptId, receipt: row.receipt })), findings: [], corrections: [] };
    finalIntegrator.resolve({ status: 'completed', text: JSON.stringify(correctedIntegration), turn: { id: finalIntegrator.handle.turnId, status: 'completed' } });
    await waitFor(() => coordinator.getTicket(ticket.id)?.phase === 'review');
    await waitFor(() => requests.at(-1)?.request.role === 'orchestrator' && requests.at(-1)?.request.taskId !== ticket.id && requests.at(-1)?.request.taskId !== planning.request.taskId, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, runs: coordinator.getTicket(ticket.id)?.orchestratorRuns.map(({ purpose, status, failureReason }) => ({ purpose, status, failureReason })), roles: requests.map(({ request }) => [request.role, request.taskId]) }));
    const review = requests.at(-1)!;
    const identity = objectFromPrompt(review.request.prompt, 'CANDIDATE IDENTITY');
    review.resolve({ status: 'completed', text: JSON.stringify({ type: 'review', knowledgeOperations: 0, ...identity, candidateSha: '0'.repeat(40), disposition: 'accept', note: 'The stale candidate must be rejected.', corrections: [] }), turn: { id: review.handle.turnId, status: 'completed' } });
    await waitFor(() => requests.filter((row) => row.request.role === 'orchestrator' && row.request.taskId !== ticket.id && row.request.taskId !== planning.request.taskId).length === 2, 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, reviews: coordinator.getTicket(ticket.id)?.orchestratorRuns.filter((run) => run.purpose === 'final_review').map(({ status, failureReason }) => ({ status, failureReason })) }));
    expect(coordinator.getTicket(ticket.id)?.phase).toBe('review');
    expect(git(repo, 'rev-parse', 'main')).toBe(coordinator.getTicket(ticket.id)?.integration.candidates[1].targetMainSha);
    const currentReview = requests.at(-1)!;
    const currentIdentity = objectFromPrompt(currentReview.request.prompt, 'CANDIDATE IDENTITY');
    currentReview.resolve({ status: 'completed', text: JSON.stringify({ type: 'review', knowledgeOperations: 0, ...currentIdentity, disposition: 'accept', note: 'The combined receipt, checks, and diff are accepted.', corrections: [] }), turn: { id: currentReview.handle.turnId, status: 'completed' } });
    await waitFor(() => coordinator.getTicket(ticket.id)?.phase === 'complete', 20_000, () => JSON.stringify({ phase: coordinator.getTicket(ticket.id)?.phase, mergeReadbacks: coordinator.getTicket(ticket.id)?.integration.mergeReadbacks, attention: coordinator.getTicket(ticket.id)?.attentionReason }));
    const done = coordinator.getTicket(ticket.id)!;
    const targetHead = git(repo, 'rev-parse', 'main');
    expect(done.integration.mergeReadbacks).toEqual([expect.objectContaining({ result: 'merged', commitReadbackSha: targetHead, observedMainSha: targetHead })]);
    expect(done.workitems.map((item) => item.state)).toEqual(['finished', 'finished']);
    expect(done.integration.correctionRounds).toHaveLength(1);
    expect(done.integration.correctionRounds[0].items.map((item) => item.taskId)).toEqual(['feature-b']);
    expect(done.attempts.filter((attempt) => attempt.taskId === 'feature-b')).toHaveLength(2);
    expect(done.receipts.filter((row) => row.attemptId && done.attempts.find((attempt) => attempt.id === row.attemptId)?.taskId === 'feature-b')).toHaveLength(2);
    expect([...done.orchestratorRuns, ...done.attempts, ...done.integration.runs].reduce((sum, run) => sum + (run.knowledgeAllocation?.operations || 0), 0)).toBe(16);
    expect(done.receipts[0].hostAttestation).toMatchObject({ status: 'verified', commitObserved: true, scopeValidation: 'passed' });
    expect(done.integration.candidates[0].candidateSha).not.toBe(done.integration.candidates[0].targetMainSha);
    expect(state.tasks.find((task) => task.id === ticket.id)!.toolCalls?.calls).toHaveLength(2);
    expect(requests.map((row) => row.request.role)).toEqual(['orchestrator', 'worker', 'worker', 'integrator', 'worker', 'integrator', 'orchestrator', 'orchestrator']);
    expect(git(repo, 'show', 'main:src/feature-1.ts')).toContain('feature_1 = true');
    expect(git(repo, 'show', 'main:src/feature-2.ts')).toContain('feature_2 = true');
  });

  it('serves the Forge create, read, guarded start, and cancel routes over HTTP', async () => {
    await mkdir(root, { recursive: true });
    fixture = await realpath(await mkdtemp(path.join(root, 'api-')));
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
    const malformedStart = await fetch(`${origin}/api/forge/tickets/${created.id}/start`, { method: 'POST', headers, body: JSON.stringify({ ignored: true }) });
    expect(malformedStart.status).toBe(409);
    expect(await malformedStart.json()).toMatchObject({ error: expect.stringContaining('Unrecognized key') });
    const malformedCancel = await fetch(`${origin}/api/forge/tickets/${created.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ force: true }) });
    expect(malformedCancel.status).toBe(409);
    expect((await (await fetch(`${origin}/api/forge/tickets/${created.id}`)).json()).phase).toBe('draft');
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

  it('keeps a possibly-live worker owned across restart and cleans approval only after confirmed stop', async () => {
    const uncertain = await createActiveWorkerFixture('uncertain');
    try {
      const request = uncertain.requests.at(-1)!;
      expect(request.request.role).toBe('worker');
      const task = uncertain.state.tasks.find((row) => row.id === uncertain.ticket.id)!;
      expect(task.approvalRequests).toHaveLength(1);

      const paused = await uncertain.coordinator.pause(uncertain.ticket.id);
      expect(paused.attempts[0].status).toBe('unknown_effect');
      expect(uncertain.state.tasks.find((row) => row.id === uncertain.ticket.id)!.approvalRequests).toHaveLength(1);

      const restarted = new ForgeCoordinator({
        getState: () => uncertain.state,
        mutate: async (fn) => { fn(uncertain.state); uncertain.state.revision++; },
        startRole: async () => { throw new Error('Restart must reconcile the saved writer before launching another.'); },
        cancelRole: async () => ({ status: 'uncertain' }),
        stateRoot: uncertain.worktrees,
      });
      await expect(restarted.resume(uncertain.ticket.id)).rejects.toThrow(/reconcile unknown Forge attempts/i);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(uncertain.requests.filter((row) => row.request.role === 'worker')).toHaveLength(1);
      expect(restarted.getTicket(uncertain.ticket.id)?.attempts).toHaveLength(1);
      expect(uncertain.state.tasks.find((row) => row.id === uncertain.ticket.id)!.approvalRequests).toHaveLength(1);
    } finally { await uncertain.cleanup(); }

    const confirmed = await createActiveWorkerFixture('stopped');
    try {
      const request = confirmed.requests.at(-1)!;
      const saved = confirmed.state.tasks.find((row) => row.id === confirmed.ticket.id)!.approvalRequests![0];
      await confirmed.coordinator.pause(confirmed.ticket.id);
      expect(confirmed.state.tasks.find((row) => row.id === confirmed.ticket.id)!.approvalRequests).toEqual([]);
      expect(confirmed.coordinator.getTicket(confirmed.ticket.id)?.receipts).toHaveLength(1);
      expect(confirmed.coordinator.getTicket(confirmed.ticket.id)?.receipts[0]).toMatchObject({ provenance: { threadId: request.handle.threadId, turnId: request.handle.turnId } });
      expect(saved.forgeContext).toMatchObject({ ticketId: confirmed.ticket.id, targetType: 'worker_attempt' });
    } finally { await confirmed.cleanup(); }
  });

  it('retains failed worker attempts and reuses the saved allocation on retry', async () => {
    const fixture = await createActiveWorkerFixture('uncertain', 2);
    try {
      const first = fixture.requests.at(-1)!;
      const firstAttempt = fixture.coordinator.getTicket(fixture.ticket.id)!.attempts[0];
      expect(firstAttempt.knowledgeAllocation?.operations).toBe(2);
      first.resolve({ status: 'failed', text: 'provider transport failed', turn: { id: first.handle.turnId, status: 'failed' } });
      await waitFor(() => fixture.requests.filter((row) => row.request.role === 'worker').length === 2, 10_000);
      const retried = fixture.coordinator.getTicket(fixture.ticket.id)!;
      expect(retried.attempts).toHaveLength(2);
      expect(retried.attempts[0]).toMatchObject({ status: 'failed', knowledgeAllocation: { operations: 2 } });
      expect(retried.attempts[1]).toMatchObject({ status: 'claimed', knowledgeAllocation: { operations: 2 } });
      expect(retried.receipts).toHaveLength(1);
      expect(retried.receipts[0].provenance).toMatchObject({ turnId: first.handle.turnId });
      const second = fixture.requests.filter((row) => row.request.role === 'worker').at(-1)!;
      second.resolve({ status: 'failed', text: 'provider failed again', turn: { id: second.handle.turnId, status: 'failed' } });
      await waitFor(() => fixture.coordinator.getTicket(fixture.ticket.id)?.phase === 'blocked', 10_000);
      const exhausted = fixture.coordinator.getTicket(fixture.ticket.id)!;
      expect(exhausted.workitems[0]).toMatchObject({ state: 'blocked', blockedReason: { code: 'retry_limit' } });
      expect(exhausted.attempts).toHaveLength(2);
      expect(fixture.requests.filter((row) => row.request.role === 'worker')).toHaveLength(2);
      expect([...exhausted.orchestratorRuns, ...exhausted.attempts, ...exhausted.integration.runs].reduce((sum, run) => sum + (run.knowledgeAllocation?.operations || 0), 0)).toBe(6);
    } finally { await fixture.cleanup(); }
  });

  it('records a failed provider startup command without accepting a worker receipt', async () => {
    const fixture = await createActiveWorkerFixture('uncertain');
    try {
      const ticket = fixture.coordinator.getTicket(fixture.ticket.id)!;
      const attempt = ticket.attempts[0];
      const toolLog = fixture.state.tasks.find((row) => row.id === fixture.ticket.id)!.toolCalls!;
      expect(toolLog.total).toBe(1);
      expect(toolLog.calls[0]).toMatchObject({
        identity: { provider: 'codex', threadId: attempt.threadId, turnId: attempt.turnId, callId: 'startup-command-2' },
        type: 'commandExecution', status: 'completed',
      });
      expect(attempt.status).toBe('claimed');
      expect(ticket.receipts).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it('keeps pause and cancel authoritative when planning completes before dispatch', async () => {
    for (const action of ['pause', 'cancel'] as const) {
      const fixture = await createActivePlanningFixture(action === 'pause' ? 'stopped' : 'uncertain');
      try {
        expect(fixture.requests.map((row) => row.request.role)).toEqual(['orchestrator']);
        await fixture.coordinator[action](fixture.ticket.id);
        fixture.planning.resolve({ status: 'completed', text: JSON.stringify(fixture.plan), turn: { id: fixture.planning.handle.turnId, status: 'completed' } });
        await waitFor(() => ['failed', 'interrupted', 'unknown_after_restart'].includes(fixture.coordinator.getTicket(fixture.ticket.id)!.orchestratorRuns[0].status));
        expect(fixture.coordinator.getTicket(fixture.ticket.id)?.phase).toBe(action === 'pause' ? 'paused' : 'cancelled');
        expect(fixture.requests.filter((row) => row.request.role === 'worker')).toHaveLength(0);
      } finally { await fixture.cleanup(); }
    }
  });

  it('rejects an out-of-scope plan before worker dispatch', async () => {
    const fixture = await createActivePlanningFixture('uncertain');
    try {
      const invalid = structuredClone(fixture.plan);
      invalid.tasks[0].assignment.write_scope = ['D:/outside'];
      fixture.planning.resolve({ status: 'completed', text: JSON.stringify(invalid), turn: { id: fixture.planning.handle.turnId, status: 'completed' } });
      await waitFor(() => fixture.coordinator.getTicket(fixture.ticket.id)?.orchestratorRuns[0].status === 'failed');
      expect(fixture.coordinator.getTicket(fixture.ticket.id)?.orchestratorRuns[0].failureReason).toMatch(/scope|assignment/i);
      expect(fixture.requests.filter((row) => row.request.role === 'worker')).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it('ignores a late plan from a superseded planning run', async () => {
    const fixture = await createActivePlanningFixture('stopped', 2);
    try {
      const stale = fixture.planning;
      await fixture.coordinator.pause(fixture.ticket.id);
      await fixture.coordinator.resume(fixture.ticket.id);
      await waitFor(() => fixture.requests.filter((row) => row.request.role === 'orchestrator').length === 2, 5_000, () => JSON.stringify({ phase: fixture.coordinator.getTicket(fixture.ticket.id)?.phase, runs: fixture.coordinator.getTicket(fixture.ticket.id)?.orchestratorRuns.map(({ status, purpose }) => ({ status, purpose })) }));
      const current = fixture.requests.filter((row) => row.request.role === 'orchestrator').at(-1)!;
      expect(current.handle.threadId).not.toBe(stale.handle.threadId);
      stale.resolve({ status: 'completed', text: JSON.stringify(fixture.plan), turn: { id: stale.handle.turnId, status: 'completed' } });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fixture.coordinator.getTicket(fixture.ticket.id)?.proposedPlan).toBeUndefined();
      expect(fixture.requests.filter((row) => row.request.role === 'worker')).toHaveLength(0);
      current.resolve({ status: 'completed', text: JSON.stringify(fixture.plan), turn: { id: current.handle.turnId, status: 'completed' } });
      await waitFor(() => fixture.requests.some((row) => row.request.role === 'worker'));
      expect(fixture.coordinator.getTicket(fixture.ticket.id)?.acceptedPlan?.revision).toBe(1);
      expect(fixture.requests.filter((row) => row.request.role === 'worker')).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });
});

async function waitFor(check: () => boolean | undefined | Promise<unknown>, timeoutMs = 5_000, details: () => string = () => '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Forge lifecycle fixture did not reach the expected persisted phase. ${details()}`);
}

async function createActiveWorkerFixture(stopStatus: 'stopped' | 'uncertain', maxExecutionAttempts = 1) {
  const fixture = await createActivePlanningFixture(stopStatus, maxExecutionAttempts);
  fixture.planning.resolve({ status: 'completed', text: JSON.stringify(fixture.plan), turn: { id: fixture.planning.handle.turnId, status: 'completed' } });
  await waitFor(() => fixture.requests.some((row) => row.request.role === 'worker'));
  return fixture;
}

async function createActivePlanningFixture(stopStatus: 'stopped' | 'uncertain', maxExecutionAttempts = 1) {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-lifecycle-')));
  const codexHome = path.join(fixture, 'codex'); await mkdir(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
  const repo = path.join(fixture, 'r'); const worktrees = path.join(fixture, 'w');
  await mkdir(path.join(repo, 'src'), { recursive: true }); await mkdir(worktrees);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'core.longpaths', 'true'); git(repo, 'config', 'user.name', 'Forge runtime fixture'); git(repo, 'config', 'user.email', 'forge@example.invalid');
  await writeFile(path.join(repo, 'src', 'base.ts'), 'export const base = true;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline');
  const state = upgradeStoredState({ version: 7, revision: 0, settings: { approvalPolicy: 'on-request', executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' } }, tasks: [], projects: [], selectedProjectId: null, expandedProjectIds: ['unclassified'] });
  saveProjectInState(state, { id: projectId, projectRoot: repo, needsLocation: false, pinned: false });
  const requests: Array<{ request: ForgeProviderRequest; handle: ForgeProviderHandle; resolve: (outcome: ForgeProviderOutcome) => void }> = [];
  const startRole = async (request: ForgeProviderRequest, onStarted?: (evidence: ForgeProviderStartEvidence) => void | Promise<void>, onEvent?: (event: ForgeProviderEvent) => void | Promise<void>, onApproval?: (approval: ForgeProviderApprovalRequest) => void | Promise<void>) => {
    const id = requests.length + 1; const threadId = `fixture-thread-${id}`; const turnId = `fixture-turn-${id}`;
    const evidence: ForgeProviderStartEvidence = { provider: 'codex', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, model: request.model, effort: request.effort, observedAt: new Date().toISOString() };
    await onStarted?.(evidence);
    let resolve!: (outcome: ForgeProviderOutcome) => void;
    const completion = new Promise<ForgeProviderOutcome>((done) => { resolve = done; });
    const handle: ForgeProviderHandle = { ...evidence, completion };
    requests.push({ request, handle, resolve });
    if (request.role === 'worker') {
      const command = { type: 'commandExecution', id: `startup-command-${id}`, pluginId: null, scriptPath: null, command: 'pwsh -NoProfile', cwd: request.executionRoot, processId: null, source: 'unifiedExecStartup', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
      await onEvent?.({ method: 'item/started', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, params: { item: { ...command, status: 'inProgress' } } });
      await onEvent?.({ method: 'item/completed', role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, params: { item: { ...command, status: 'failed', aggregatedOutput: 'orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223', exitCode: -1, durationMs: 0 } } });
      await onApproval?.({ requestId: id, method: 'item/commandExecution/requestApproval', itemId: `approval-${id}`, role: request.role, ticketId: request.ticketId, taskId: request.taskId, threadId, turnId, request: { command: 'git status', availableDecisions: ['accept', 'decline'] } });
    }
    return handle;
  };
  const coordinator = new ForgeCoordinator({ getState: () => state, mutate: async (fn) => { fn(state); state.revision++; }, startRole, cancelRole: async () => ({ status: stopStatus }), stateRoot: worktrees });
  const ticket = await coordinator.create({ projectId, title: 'Worker recovery fixture', description: 'Exercise persisted worker ownership.', acceptanceCriteria: ['No duplicate writer starts.'], scope: { read: ['src'], write: ['src'], knowledge: ['knowledge/opnex'] }, orchestrator: { model: 'gpt-6.1-terra', effort: 'low' }, workerProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, limits: { maxExecutionAttempts }, ...(maxExecutionAttempts === 2 ? { knowledgeBudget: { totalOperations: 6 } } : {}) });
  await coordinator.start(ticket.id);
  const planning = requests.at(-1)!;
  const skill = coordinator.getTicket(ticket.id)!.orchestratorSkills.find((row) => row.name === 'agentmem-project')!;
  const plan = { type: 'plan', knowledgeOperations: 0, tasks: [{ id: 'one', title: 'One', description: 'Create src/one.ts.', dependencyIds: [], assignment, knowledgeScope: ['knowledge/opnex'], executionProfile: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, skillIds: [skill.id] }] };
  return { fixture, repo, worktrees, state, coordinator, ticket, requests, planning, plan, cleanup: async () => rm(fixture, { recursive: true, force: true }) };
}
