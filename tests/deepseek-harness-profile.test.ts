import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDeepSeekHarnessTaskProfileLaunch,
  prepareDeepSeekHarnessTaskProfile,
  resolveDeepSeekHarnessCredentialStorePath,
  type DeepSeekHarnessMcpServerConfig,
} from '../server/deepseek-harness-profile.js';
import type { DeepSeekHarnessSdkLaunch } from '../server/deepseek-harness.js';

const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pseudoharness-dsh-profile-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === path.resolve(os.tmpdir())) rmSync(resolved, { recursive: true, force: true });
  }
});

function launch(profileName = 'sdk'): DeepSeekHarnessSdkLaunch {
  return {
    command: 'D:\\Program Files\\deepseekharness\\DeepSeek Harness.exe',
    args: ['--expose-internals', 'D:\\Program Files\\deepseekharness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js', '--profile', profileName],
    profileName,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function fakeDshProfileBootstrap() {
  const process = vi.fn((_command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const profileName = args[args.indexOf('--profile') + 1];
    const home = options.env?.DSH_HOME;
    if (!home || !profileName) throw new Error('profile bootstrap args missing');
    const profileDirectory = path.join(home, 'profiles', profileName);
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(path.join(profileDirectory, 'package.json'), JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }));
    writeFileSync(path.join(profileDirectory, 'cordis.patch.yml'), '# generated empty task profile\n[]\n');
    writeFileSync(path.join(profileDirectory, 'cordis.yml'), '[]\n');
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => true);
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  });
  return {
    spawnProcess: process as unknown as typeof import('node:child_process').spawn,
    mock: process,
  };
}

function server(serverName: DeepSeekHarnessMcpServerConfig['serverName'], env: Record<string, string> = {}): DeepSeekHarnessMcpServerConfig {
  return {
    serverName,
    command: process.execPath,
    args: ['--import', 'tsx', path.join(process.cwd(), 'server', 'gateway.ts')],
    cwd: process.cwd(),
    env,
  };
}

describe('DeepSeek Harness isolated SDK profiles', () => {
  it('resolves the documented credential file by path without reading it', () => {
    const home = path.join(os.tmpdir(), 'User');
    expect(resolveDeepSeekHarnessCredentialStorePath({ configuredHome: path.join(home, '.dsh') }))
      .toBe(path.join(home, '.dsh', '.credentials.yaml'));
    expect(resolveDeepSeekHarnessCredentialStorePath({ userHome: home }))
      .toBe(path.join(home, '.dsh', '.credentials.yaml'));
  });

  it('creates a task profile with private per-gateway config outside the saved profile patch', async () => {
    const root = tempRoot();
    const dshHome = path.join(root, 'isolated-home');
    const credentialStorePath = path.join(root, 'user-dsh', '.credentials.yaml');
    mkdirSync(path.dirname(credentialStorePath), { recursive: true });
    writeFileSync(credentialStorePath, 'SYNTHETIC_CREDENTIAL_SENTINEL');
    const bootstrap = fakeDshProfileBootstrap();
    const mcpServers = [
      server('agentmem', { PSEUDOHARNESS_AGENTMEM_CONFIG_ENV: 'SYNTHETIC_GATEWAY_ENV_SENTINEL' }),
      server('pseudoharness_skills', { PSEUDOHARNESS_SKILLS_TASK_ID: 'test-task' }),
    ];

    const profile = await prepareDeepSeekHarnessTaskProfile({
      dshHome,
      credentialStorePath,
      provider: 'opencode-go',
      profileName: 'pseudoharness-test-worker',
      launch: launch(),
      mcpServers,
      spawnProcess: bootstrap.spawnProcess,
    });

    const taskLaunch = applyDeepSeekHarnessTaskProfileLaunch(launch(), profile);
    expect(taskLaunch.profileName).toBe(profile.profileName);
    expect(taskLaunch.args[taskLaunch.args.indexOf('--profile') + 1]).toBe(profile.profileName);
    expect(taskLaunch.configuredMcpServers).toEqual(['agentmem', 'pseudoharness_skills']);
    expect(taskLaunch.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome });

    const patch = readFileSync(profile.patchPath, 'utf8');
    expect(profile.profileName).toBe('pseudoharness-test-worker');
    expect(profile.configuredMcpServers).toEqual(['agentmem', 'pseudoharness_skills']);
    expect(profile.launchEnvironment.DSH_HOME).toBe(dshHome);
    expect(profile.launchEnvironment.DSH_AGENTS_HOME).toBe(path.join(dshHome, 'pseudoharness-agents'));
    expect(patch).toContain('path:');
    expect(patch).toContain('id: llm-pi-ai');
    expect(patch).toContain('"opencode-go": {}');
    expect(patch).toContain("name: \"@deepseek-ai/dsh-mcp-client\"");
    expect(patch).toContain('!!js');
    expect(patch).not.toContain('SYNTHETIC_CREDENTIAL_SENTINEL');
    expect(patch).not.toContain('SYNTHETIC_GATEWAY_ENV_SENTINEL');
    expect(patch).not.toContain('D:\\programming\\pseudoharness\\server\\gateway.ts');
    const envName = `PSEUDOHARNESS_DSH_MCP_CONFIG_${createHash('sha256').update('agentmem').digest('hex').slice(0, 16).toUpperCase()}`;
    const runtimeConfig = JSON.parse(profile.launchEnvironment[envName] ?? '{}');
    expect(profile.launchEnvironment[envName.replace(/^PSEUDOHARNESS_/, 'OPNEX_')]).toBe(profile.launchEnvironment[envName]);
    expect(runtimeConfig).toMatchObject({
      serverName: 'agentmem',
      transport: 'stdio',
      failOnStartupError: true,
      env: { PSEUDOHARNESS_AGENTMEM_CONFIG_ENV: 'SYNTHETIC_GATEWAY_ENV_SENTINEL' },
    });
    expect(() => applyDeepSeekHarnessTaskProfileLaunch(launch('custom'), profile))
      .toThrow('Task profiles must be applied to the installed default SDK launch.');
    expect(bootstrap.mock).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      '--profile', 'pseudoharness-test-worker', '--from-default-profile', 'sdk', '--help',
    ]));
  });

  it('reuses an identical saved task profile and refuses to overwrite a changed one', async () => {
    const root = tempRoot();
    const dshHome = path.join(root, 'isolated-home');
    const credentialStorePath = path.join(root, 'user-dsh', '.credentials.yaml');
    mkdirSync(path.dirname(credentialStorePath), { recursive: true });
    writeFileSync(credentialStorePath, 'SYNTHETIC_ONLY');
    const bootstrap = fakeDshProfileBootstrap();
    const options = {
      dshHome,
      credentialStorePath,
      provider: 'opencode-go',
      profileName: 'pseudoharness-test-integrator',
      launch: launch(),
      mcpServers: [server('pseudoharness_skills', { PSEUDOHARNESS_SKILLS_TASK_ID: 'test-task' })],
      spawnProcess: bootstrap.spawnProcess,
    } as const;
    const first = await prepareDeepSeekHarnessTaskProfile(options);
    await prepareDeepSeekHarnessTaskProfile(options);
    expect(bootstrap.mock).toHaveBeenCalledTimes(1);
    const original = readFileSync(first.patchPath, 'utf8');
    writeFileSync(first.patchPath, `${original}# changed\n`);
    await expect(prepareDeepSeekHarnessTaskProfile(options)).rejects.toThrow('differs from its saved scoped MCP configuration');
    expect(readFileSync(first.patchPath, 'utf8')).toBe(`${original}# changed\n`);
  });

  it('rejects global instructions, user home config, unknown gateways, and a copied credential path', async () => {
    const root = tempRoot();
    const dshHome = path.join(root, 'isolated-home');
    const credentialStorePath = path.join(root, 'user-dsh', '.credentials.yaml');
    mkdirSync(dshHome, { recursive: true });
    mkdirSync(path.dirname(credentialStorePath), { recursive: true });
    writeFileSync(credentialStorePath, 'SYNTHETIC_ONLY');
    const base = {
      dshHome,
      credentialStorePath,
      provider: 'opencode-go',
      profileName: 'pseudoharness-test-blocked',
      launch: launch(),
      spawnProcess: fakeDshProfileBootstrap().spawnProcess,
    } as const;

    mkdirSync(path.join(dshHome, 'pseudoharness-agents'), { recursive: true });
    writeFileSync(path.join(dshHome, 'pseudoharness-agents', 'AGENTS.md'), 'not read');
    await expect(prepareDeepSeekHarnessTaskProfile({ ...base, mcpServers: [server('pseudoharness_skills')] }))
      .rejects.toThrow('instructions directory is not empty');
    rmSync(path.join(dshHome, 'pseudoharness-agents'), { recursive: true, force: true });

    writeFileSync(path.join(dshHome, '.env'), 'not read');
    await expect(prepareDeepSeekHarnessTaskProfile({ ...base, mcpServers: [server('pseudoharness_skills')] }))
      .rejects.toThrow('home contains a home-level environment');
    rmSync(path.join(dshHome, '.env'), { force: true });

    await expect(prepareDeepSeekHarnessTaskProfile({
      ...base,
      credentialStorePath: path.join(dshHome, '.credentials.yaml'),
      mcpServers: [server('pseudoharness_skills')],
    })).rejects.toThrow('outside its isolated task home');
    await expect(prepareDeepSeekHarnessTaskProfile({
      ...base,
      mcpServers: [{ ...server('agentmem'), serverName: 'external' as 'agentmem' }],
    })).rejects.toThrow('Only the existing scoped AgentMem and Opnex Skills');
    await expect(prepareDeepSeekHarnessTaskProfile({ ...base, mcpServers: [] })).rejects.toThrow('At least one scoped');
    await expect(prepareDeepSeekHarnessTaskProfile({ ...base, provider: 'deepseek-official', mcpServers: [server('pseudoharness_skills')] }))
      .rejects.toThrow('Only the verified OpenCode Go provider route');
  });
});
