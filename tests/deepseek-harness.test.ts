import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createWindowsDeepSeekHarnessSdkLaunch,
  DeepSeekHarnessError,
  DeepSeekHarnessSdkRuntime,
  resolveDeepSeekHarnessPermission,
} from '../server/deepseek-harness.js';

const fixture = path.resolve('tests/fixtures/deepseek-harness-sdk-fixture.mjs');
const cwd = process.cwd();
const baseLaunch = (mode = 'normal') => ({
  command: process.execPath,
  args: [fixture, '--profile', 'sdk', `--fixture=${mode}`],
  harnessVersion: '0.2.1-fixture',
});
const fullAccess = resolveDeepSeekHarnessPermission({
  approvalPolicy: 'full-access', selectedForTask: true, workspaceRoot: cwd, writeScope: [cwd], requiresFilesystemConfinement: false,
});
const options = (mode = 'normal', sessionId?: string) => ({
  launch: baseLaunch(mode), cwd, provider: 'deepseek-official', model: 'deepseek-flash',
  reasoningEffort: 'high', permission: fullAccess, ...(sessionId ? { sessionId } : {}), requestTimeoutMs: 5000,
});

describe('DeepSeek Harness SDK worker boundary', () => {
  it('builds a shell-free SDK command from a verified Windows app installation root', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'pseudoharness-dsh-launch-'));
    try {
      const appResources = path.join(root, 'resources');
      await mkdir(appResources, { recursive: true });
      const exe = path.join(root, 'DeepSeek Harness.exe');
      const appArchive = path.join(appResources, 'app.asar');
      const cli = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      await writeFile(exe, 'fixture');
      await writeFile(appArchive, 'fixture');
      const launch = createWindowsDeepSeekHarnessSdkLaunch(root, '0.2.1-fixture');
      expect(launch.command).toBe(exe);
      expect(launch.args).toEqual(['--expose-internals', cli, '--profile', 'sdk']);
      expect(launch.harnessVersion).toBe('0.2.1-fixture');
      expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
      expect(() => createWindowsDeepSeekHarnessSdkLaunch(path.join(root, 'missing'))).toThrow(/does not contain the verified SDK runtime files/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs one task-owned SDK session, forwards events, and reports provider capability/version metadata', async () => {
    const runtime = new DeepSeekHarnessSdkRuntime(options());
    const notifications: Array<{ method: string; params: unknown }> = [];
    runtime.on('notification', notification => notifications.push(notification));

    const info = await runtime.connect();
    expect(info).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-flash', requestedReasoningEffort: 'high',
      harnessVersion: '0.2.1-fixture', permissionMode: 'danger-full-access',
      selectedApprovalPolicy: 'full-access', workspaceRoot: cwd, writeScope: [cwd], access: 'unrestricted',
      filesystemScope: 'assignment-instruction-only',
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture-0.0.1' },
      capabilities: {
        sessionResume: true, workingDirectory: true, approvalResponse: false,
        steering: false, gracefulSessionCancellation: false, cancellation: 'process-tree-termination',
      },
    });
    const sessionId = await runtime.startSession([{ type: 'text', text: 'Complete this fixture task.' }]);
    expect(sessionId).toBe(runtime.sessionId);
    expect(await runtime.waitSession()).toMatchObject({ sessionId, status: 'idle' });
    expect(await runtime.getWorkingDirectory()).toBe(cwd);
    const nextCwd = path.join(cwd, 'server');
    expect(await runtime.setWorkingDirectory(nextCwd)).toBe(nextCwd);
    await expect(runtime.setWorkingDirectory(path.dirname(cwd))).rejects.toThrow(/cannot move outside this task’s workspace root/i);
    expect(notifications.map(event => event.method)).toEqual(['session.status', 'session.event']);
    await runtime.shutdown();
    expect(runtime.ready).toBe(false);

    const recovered = new DeepSeekHarnessSdkRuntime(options('normal', sessionId));
    expect(await recovered.resumeSession()).toMatchObject({ sessionId, resumed: true });
    await recovered.shutdown();
  });

  it('fails closed for permission combinations the installed SDK cannot honor', () => {
    expect(resolveDeepSeekHarnessPermission({
      approvalPolicy: 'on-request', selectedForTask: true, workspaceRoot: cwd, writeScope: [], requiresFilesystemConfinement: false,
    })).toMatchObject({ permissionMode: 'read-only', access: 'read-only' });
    expect(resolveDeepSeekHarnessPermission({
      approvalPolicy: 'full-access', selectedForTask: true, workspaceRoot: cwd, writeScope: [], requiresFilesystemConfinement: false,
    })).toMatchObject({ permissionMode: 'read-only', access: 'read-only', approvalPolicy: 'full-access' });
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'on-request', selectedForTask: true, workspaceRoot: cwd, writeScope: [cwd], requiresFilesystemConfinement: false,
    })).toThrow(/cannot run this writable task under the selected on-request policy/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'untrusted', selectedForTask: true, workspaceRoot: cwd, writeScope: [cwd], requiresFilesystemConfinement: false,
    })).toThrow(/cannot run this writable task under the selected untrusted policy/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'never', selectedForTask: true, workspaceRoot: cwd, writeScope: [], requiresFilesystemConfinement: false,
    })).toThrow(/no native preset that matches the selected never policy/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'full-access', selectedForTask: true, workspaceRoot: cwd, writeScope: [cwd], requiresFilesystemConfinement: true,
    })).toThrow(/cannot enforce the task’s required filesystem path confinement/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'full-access', selectedForTask: true, workspaceRoot: cwd, writeScope: [], requiresFilesystemConfinement: true,
    })).toThrow(/cannot enforce the task’s required filesystem path confinement/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'full-access', selectedForTask: false, workspaceRoot: cwd, writeScope: [cwd], requiresFilesystemConfinement: false,
    })).toThrow(/will not infer or change the current policy/i);
    expect(() => resolveDeepSeekHarnessPermission({
      approvalPolicy: 'full-access', selectedForTask: true, workspaceRoot: cwd, writeScope: [path.dirname(cwd)], requiresFilesystemConfinement: false,
    })).toThrow(/write scope escaped the task-owned worktree/i);
  });

  it('does not leak or approve an unrouteable SDK approval event', async () => {
    const runtime = new DeepSeekHarnessSdkRuntime(options('approval'));
    let approvalMessage = '';
    runtime.on('approvalRequired', event => { approvalMessage = event.message; });
    await expect(runtime.startSession([{ type: 'text', text: 'This fixture triggers an approval.' }])).rejects.toMatchObject({ code: 'interrupted' });
    expect(approvalMessage).toMatch(/no approval response method/i);
    expect(runtime.ready).toBe(false);
  });

  it('sanitizes auth errors returned by the Harness SDK', async () => {
    const runtime = new DeepSeekHarnessSdkRuntime(options('auth-error'));
    let caught: unknown;
    try { await runtime.connect(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DeepSeekHarnessError);
    expect(caught).toMatchObject({ code: 'authentication', method: 'initialize', rpcCode: -32001 });
    expect((caught as Error).message).toMatch(/sign in through the installed Harness profile/i);
    expect((caught as Error).message).not.toContain('secret credential value');
  });

  it('rejects a working-directory escape returned by the SDK', async () => {
    const runtime = new DeepSeekHarnessSdkRuntime(options('escape-cwd'));
    await expect(runtime.getWorkingDirectory()).rejects.toMatchObject({ code: 'protocol-error' });
    await runtime.shutdown();
  });

  it('rejects steering and approval responses instead of dropping them', async () => {
    const runtime = new DeepSeekHarnessSdkRuntime(options());
    await expect(runtime.steer([{ type: 'text', text: 'changed assignment' }])).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(runtime.respondToApproval({ decision: 'approve' })).rejects.toMatchObject({ code: 'unsupported-capability' });
  });
});
