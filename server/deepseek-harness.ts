import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ApprovalPolicy } from './contracts.js';

type JsonRecord = Record<string, unknown>;
type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type DeepSeekHarnessPermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type DeepSeekHarnessPermissionRequest = {
  approvalPolicy: ApprovalPolicy;
  /** True only when this exact pass has persisted the selected policy. */
  selectedForTask: boolean;
  /** The task-owned worker/integrator worktree, distinct from the canonical project root. */
  workspaceRoot: string;
  /** The validated assignment write scope after rebasing into the task worktree. */
  writeScope: readonly string[];
  /** True when the task requires OS-enforced path confinement narrower than the DSH workspace preset. */
  requiresFilesystemConfinement: boolean;
};
const deepSeekPermissionGrantBrand: unique symbol = Symbol('DeepSeekHarnessPermissionGrant');
export type DeepSeekHarnessPermissionGrant = {
  readonly [deepSeekPermissionGrantBrand]: true;
  approvalPolicy: ApprovalPolicy;
  workspaceRoot: string;
  writeScope: readonly string[];
  permissionMode: DeepSeekHarnessPermissionMode;
  access: 'read-only' | 'unrestricted';
  filesystemScope: 'assignment-instruction-only' | 'read-only-preset';
};
export type DeepSeekHarnessSdkLaunch = {
  command: string;
  args: readonly string[];
  /** The task-owned DSH SDK profile selected by this launch. Defaults to `sdk`. */
  profileName?: string;
  /** Native MCP servers configured in this profile; names only, never server env values. */
  configuredMcpServers?: readonly string[];
  /** Optional installed Harness application version, distinct from the SDK server version. */
  harnessVersion?: string;
  /** Additional non-secret runtime variables. Credential values should stay in the Harness credential store. */
  env?: NodeJS.ProcessEnv;
};

export type DeepSeekHarnessSdkOptions = {
  launch: DeepSeekHarnessSdkLaunch;
  cwd: string;
  provider: string;
  model: string;
  /** Pass through the native Harness value; this adapter does not translate Codex effort labels. */
  reasoningEffort?: string;
  permission: DeepSeekHarnessPermissionGrant;
  /** Supply the persisted value when resuming a job; otherwise a new task-owned session ID is created. */
  sessionId?: string;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
};

export type DeepSeekHarnessServerInfo = { name: string; version: string };
export type DeepSeekHarnessMcpToolCatalog = {
  status: 'not-configured' | 'pending' | 'ready' | 'missing-tools';
  configuredServerNames: readonly string[];
  availableServerNames: readonly string[];
  missingServerNames: readonly string[];
  toolNames: readonly string[];
  observedAtSequence?: number;
};
export type DeepSeekHarnessRuntimeInfo = {
  provider: string;
  model: string;
  requestedReasoningEffort?: string;
  permissionMode: DeepSeekHarnessPermissionMode;
  selectedApprovalPolicy: ApprovalPolicy;
  workspaceRoot: string;
  writeScope: readonly string[];
  access: 'read-only' | 'unrestricted';
  filesystemScope: 'assignment-instruction-only' | 'read-only-preset';
  sessionId: string;
  profileName: string;
  configuredMcpServers: readonly string[];
  /** Actual public MCP tool names observed in this session's request/header event. */
  mcpToolCatalog: DeepSeekHarnessMcpToolCatalog;
  serverInfo: DeepSeekHarnessServerInfo;
  harnessVersion?: string;
  capabilities: {
    sessionResume: true;
    workingDirectory: true;
    approvalResponse: false;
    steering: false;
    gracefulSessionCancellation: false;
    cancellation: 'process-tree-termination';
  };
};

export type DeepSeekHarnessNotification = { method: string; params: unknown };
export type DeepSeekHarnessCancelResult = { status: 'interrupted'; sessionId: string };
export type DeepSeekHarnessContentBlock = JsonRecord;

export type DeepSeekHarnessErrorCode =
  | 'configuration'
  | 'unsupported-capability'
  | 'spawn-failed'
  | 'protocol-error'
  | 'remote-error'
  | 'authentication'
  | 'timeout'
  | 'interrupted';

/** Safe, actionable failure details. Raw Harness errors and stderr are deliberately not retained. */
export class DeepSeekHarnessError extends Error {
  constructor(
    readonly code: DeepSeekHarnessErrorCode,
    message: string,
    readonly method?: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = 'DeepSeekHarnessError';
  }
}

const supportedSdkMethods = new Set([
  'initialize', 'session/prompt', 'session/resume', 'session/wait',
  'session/working-directory/get', 'session/working-directory/set', 'shutdown',
]);
const MAX_RPC_LINE_BYTES = 64 * 1024 * 1024;
const DSH_HOST_CLI_RELATIVE_PATH = path.join(
  'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
);

function assertProfileName(profileName: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(profileName)) {
    throw new DeepSeekHarnessError('configuration', 'The DeepSeek Harness SDK profile name must be lowercase letters, digits, and hyphens, and begin with a letter.');
  }
}

/** Build the direct, shell-free SDK launch for an installed Windows DSH desktop app. */
export function createWindowsDeepSeekHarnessSdkLaunch(
  installationRoot: string,
  harnessVersion?: string,
  profileName = 'sdk',
): DeepSeekHarnessSdkLaunch {
  assertAbsoluteDirectory(installationRoot, 'DeepSeek Harness installation root');
  assertProfileName(profileName);
  if (process.platform !== 'win32') {
    throw new DeepSeekHarnessError('unsupported-capability', 'Direct desktop-app SDK launching is currently verified only on Windows. Configure the installed DSH SDK executable explicitly on this platform.');
  }
  const root = path.resolve(installationRoot);
  const command = path.join(root, 'DeepSeek Harness.exe');
  const appArchive = path.join(root, 'resources', 'app.asar');
  const cli = path.join(root, DSH_HOST_CLI_RELATIVE_PATH);
  // The CLI entry is inside Electron's ASAR archive and is resolved by Electron's
  // patched module loader, so regular Node fs cannot stat that virtual path.
  if (!existsSync(command) || !existsSync(appArchive)) {
    throw new DeepSeekHarnessError('configuration', 'The selected DeepSeek Harness installation does not contain the verified SDK runtime files. Update the installation path or update DeepSeek Harness.');
  }
  return {
    command,
    args: ['--expose-internals', cli, '--profile', profileName],
    profileName,
    ...(harnessVersion ? { harnessVersion } : {}),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** Find the installed Windows desktop build without reading credential files or values. */
export function discoverWindowsDeepSeekHarnessSdkLaunch(env: NodeJS.ProcessEnv = process.env): DeepSeekHarnessSdkLaunch {
  const configuredRoot = env.DEEPSEEK_HARNESS_INSTALL_ROOT?.trim() || env.DSH_INSTALL_ROOT?.trim();
  if (configuredRoot) return createWindowsDeepSeekHarnessSdkLaunch(configuredRoot);
  if (process.platform !== 'win32') {
    throw new DeepSeekHarnessError('configuration', 'Set DeepSeek Harness install location and SDK launch settings for this platform.');
  }

  const registryRoots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const registryRoot of registryRoots) {
    let output: string;
    try {
      output = execFileSync('reg.exe', ['query', registryRoot, '/s', '/f', 'DeepSeek Harness', '/d'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
      });
    } catch {
      continue;
    }
    const blocks = output.split(/(?=^HKEY_)/m);
    for (const block of blocks) {
      const displayName = block.match(/^\s+DisplayName\s+REG_SZ\s+(.+)$/m)?.[1]?.trim();
      if (!displayName || !/^DeepSeek Harness(?:\s|$)/i.test(displayName)) continue;
      const displayVersion = block.match(/^\s+DisplayVersion\s+REG_SZ\s+(.+)$/m)?.[1]?.trim()
        ?? displayName.match(/^DeepSeek Harness\s+([^\s]+)$/i)?.[1];
      const installLocation = block.match(/^\s+InstallLocation\s+REG_SZ\s+(.+)$/m)?.[1]?.trim();
      const displayIcon = block.match(/^\s+DisplayIcon\s+REG_SZ\s+(.+)$/m)?.[1]?.trim();
      const iconPath = displayIcon?.replace(/^"|"$/g, '').replace(/,\d+$/, '');
      const root = installLocation || (iconPath ? path.dirname(iconPath) : undefined);
      if (!root || !path.isAbsolute(root)) continue;
      try { return createWindowsDeepSeekHarnessSdkLaunch(root, displayVersion); }
      catch { /* continue to another registered build */ }
    }
  }
  throw new DeepSeekHarnessError('configuration', 'DeepSeek Harness SDK was not found. Install the desktop Harness or set DEEPSEEK_HARNESS_INSTALL_ROOT to its installation folder.');
}

/** Resolve a task's already-selected permissions without increasing its effective rights. */
export function resolveDeepSeekHarnessPermission(request: DeepSeekHarnessPermissionRequest): DeepSeekHarnessPermissionGrant {
  if (!request.selectedForTask) {
    throw new DeepSeekHarnessError('configuration', 'The DeepSeek Harness provider requires an approval policy persisted for this task. It will not infer or change the current policy.');
  }
  if (typeof request.requiresFilesystemConfinement !== 'boolean') {
    throw new DeepSeekHarnessError('configuration', 'The task must explicitly state whether it requires OS-enforced filesystem confinement.');
  }
  if (!Array.isArray(request.writeScope) || !['on-request', 'untrusted', 'never', 'full-access'].includes(request.approvalPolicy)) {
    throw new DeepSeekHarnessError('configuration', 'The selected DeepSeek Harness task permissions are malformed.');
  }
  assertAbsoluteDirectory(request.workspaceRoot, 'Task-owned DeepSeek Harness worktree');
  for (const scope of request.writeScope) {
    assertAbsoluteDirectory(scope, 'Validated assignment write scope');
    if (!isPathWithin(request.workspaceRoot, scope)) {
      throw new DeepSeekHarnessError('configuration', 'A validated assignment write scope escaped the task-owned worktree. The DeepSeek Harness worker was not started.');
    }
  }
  if (request.requiresFilesystemConfinement) {
    throw new DeepSeekHarnessError('unsupported-capability', 'The installed DeepSeek Harness SDK cannot enforce the task’s required filesystem path confinement. Choose a provider with that native capability.');
  }
  if (request.writeScope.length === 0 && ['on-request', 'untrusted', 'full-access'].includes(request.approvalPolicy)) {
    return Object.freeze({
      [deepSeekPermissionGrantBrand]: true as const,
      approvalPolicy: request.approvalPolicy,
      workspaceRoot: path.resolve(request.workspaceRoot),
      writeScope: Object.freeze(request.writeScope.map(scope => path.resolve(scope))),
      permissionMode: 'read-only',
      access: 'read-only',
      filesystemScope: 'read-only-preset',
    });
  }
  if (request.approvalPolicy === 'full-access') {
    return Object.freeze({
      [deepSeekPermissionGrantBrand]: true as const,
      approvalPolicy: request.approvalPolicy,
      workspaceRoot: path.resolve(request.workspaceRoot),
      writeScope: Object.freeze(request.writeScope.map(scope => path.resolve(scope))),
      permissionMode: 'danger-full-access',
      access: 'unrestricted',
      filesystemScope: 'assignment-instruction-only',
    });
  }
  const policyMessage = request.approvalPolicy === 'on-request'
    ? 'DeepSeek Harness cannot run this writable task under the selected on-request policy because Opnex cannot answer its SDK approval requests. The task was not started and its permissions were not changed. Use a provider with a Opnex approval route, or explicitly select the existing Full Access policy only when this task permits unrestricted runtime access and does not require enforced filesystem confinement.'
    : request.approvalPolicy === 'untrusted'
      ? 'DeepSeek Harness cannot run this writable task under the selected untrusted policy because the installed SDK has no matching Opnex approval response. The task was not started and its permissions were not changed. Use a provider with a matching policy, or explicitly select the existing Full Access policy only when this task permits unrestricted runtime access and does not require enforced filesystem confinement.'
      : 'DeepSeek Harness has no native preset that matches the selected never policy without changing the task’s effective sandbox. The task was not started and its permissions were not changed. Use a provider with a lossless policy mapping.';
  throw new DeepSeekHarnessError(
    'unsupported-capability',
    policyMessage,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeMcpToolCatalog(
  configuredServerNames: readonly string[],
  discoveredToolNames: readonly string[] = [],
  observedAtSequence?: number,
  observed = false,
): DeepSeekHarnessMcpToolCatalog {
  const servers = [...new Set(configuredServerNames)].sort();
  const prefixes = new Map(servers.map(serverName => [serverName, `mcp__${serverName}__`]));
  const tools = [...new Set(discoveredToolNames)]
    .filter(name => [...prefixes.values()].some(prefix => name.startsWith(prefix)))
    .sort();
  const available = servers.filter(serverName => tools.some(name => name.startsWith(prefixes.get(serverName)!)));
  const missing = observed ? servers.filter(serverName => !available.includes(serverName)) : [];
  const status = servers.length === 0
    ? 'not-configured'
    : !observed
      ? 'pending'
      : missing.length === 0
        ? 'ready'
        : 'missing-tools';
  return Object.freeze({
    status,
    configuredServerNames: Object.freeze(servers),
    availableServerNames: Object.freeze(available),
    missingServerNames: Object.freeze(missing),
    toolNames: Object.freeze(tools),
    ...(observedAtSequence !== undefined ? { observedAtSequence } : {}),
  });
}

function assertAbsoluteDirectory(directory: string, label: string) {
  if (!directory || !path.isAbsolute(directory)) {
    throw new DeepSeekHarnessError('configuration', `${label} must be an absolute path.`);
  }
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function runtimeEnvironment(
  inherited: NodeJS.ProcessEnv,
  launch: DeepSeekHarnessSdkLaunch,
  permission: DeepSeekHarnessPermissionGrant,
) {
  // Do not pass unrelated application secrets to the worker process or its tools.
  // Harness authentication is resolved by the installed Harness profile/credential store.
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA',
    'NO_PROXY', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'DSH_HOME',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  // The DSH SDK reads its own profile state. Keep explicit runtime configuration
  // separate from inherited secrets and then set the selected native preset.
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH/.test(normalized)) {
      throw new DeepSeekHarnessError('configuration', `The DeepSeek Harness launch config contains a credential-like environment variable (${key}); use the Harness credential store.`);
    }
    env[key] = value;
  }
  env.DSH_PERMISSION_MODE = permission.permissionMode;
  return env;
}

function remoteError(method: string, error: NonNullable<JsonRpcMessage['error']>) {
  const raw = (error.message ?? '').toLowerCase();
  const code = typeof error.code === 'number' ? error.code : undefined;
  if (/auth|credential|api.?key|unauthor|sign.?in|login/.test(raw)) {
    return new DeepSeekHarnessError(
      'authentication',
      'DeepSeek Harness authentication is unavailable. Sign in through the installed Harness profile, then retry.',
      method,
      code,
    );
  }
  if (/reasoning.?effort|unsupported.*(model|provider|effort)|unknown.*(model|provider)/.test(raw)) {
    return new DeepSeekHarnessError(
      'configuration',
      `The installed DeepSeek Harness does not accept the selected provider, model, or native reasoning effort for ${method}.`,
      method,
      code,
    );
  }
  return new DeepSeekHarnessError(
    'remote-error',
    `The installed DeepSeek Harness request ${method} failed (code ${code ?? 'unknown'}). Check Harness status and retry.`,
    method,
    code,
  );
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      let killer: ChildProcess | undefined;
      try {
        killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
      } catch {
        child.kill();
        resolve();
        return;
      }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
    await Promise.race([
      new Promise<void>(resolve => child.once('close', () => resolve())),
      delay(2000),
    ]);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { return; } }
  await Promise.race([
    new Promise<void>(resolve => child.once('close', () => resolve())),
    delay(1000),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  }
}

/**
 * One task-owned process and one persisted session against the installed DSH SDK
 * JSON-RPC profile. It deliberately does not implement Opnex lifecycle,
 * approval routing, assignment validation, or filesystem confinement.
 */
export class DeepSeekHarnessSdkRuntime extends EventEmitter {
  readonly sessionId: string;
  private child?: ChildProcessWithoutNullStreams;
  private connecting?: Promise<DeepSeekHarnessRuntimeInfo>;
  private requestId = 0;
  private buffer = '';
  private readonly pending = new Map<number, {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private _ready = false;
  private _runtimeInfo?: DeepSeekHarnessRuntimeInfo;
  private _mcpToolCatalog: DeepSeekHarnessMcpToolCatalog;
  private expectedExit = false;
  private cancelled = false;

  constructor(private readonly options: DeepSeekHarnessSdkOptions) {
    super();
    assertAbsoluteDirectory(options.cwd, 'DeepSeek Harness working directory');
    if (!options.launch.command.trim()) throw new DeepSeekHarnessError('configuration', 'A local DeepSeek Harness SDK executable is required.');
    if (path.resolve(options.cwd) !== options.permission.workspaceRoot) {
      throw new DeepSeekHarnessError('configuration', 'DeepSeek Harness cwd must match the task-owned worktree validated with its assignment scope.');
    }
    if (options.permission[deepSeekPermissionGrantBrand] !== true) {
      throw new DeepSeekHarnessError('configuration', 'DeepSeek Harness permission grants must come from the fail-closed task-policy resolver.');
    }
    const profileName = options.launch.profileName ?? 'sdk';
    assertProfileName(profileName);
    const profileIndex = options.launch.args.indexOf('--profile');
    if (profileIndex < 0 || options.launch.args[profileIndex + 1] !== profileName) {
      throw new DeepSeekHarnessError('configuration', 'The local DeepSeek Harness must be started with the selected SDK JSON-RPC profile.');
    }
    if (!options.provider.trim() || !options.model.trim()) {
      throw new DeepSeekHarnessError('configuration', 'Select a DeepSeek Harness provider and model before starting a worker.');
    }
    this._mcpToolCatalog = makeMcpToolCatalog(options.launch.configuredMcpServers ?? []);
    this.sessionId = options.sessionId?.trim() || `pseudoharness-${randomUUID()}`;
    if (this.sessionId.length > 200 || /[\r\n]/.test(this.sessionId)) {
      throw new DeepSeekHarnessError('configuration', 'The persisted DeepSeek Harness session ID is invalid.');
    }
  }

  get ready() { return this._ready; }
  get runtimeInfo() { return this._runtimeInfo; }
  get mcpToolCatalog() { return this._mcpToolCatalog; }

  async connect(): Promise<DeepSeekHarnessRuntimeInfo> {
    if (this.child && this._ready && this._runtimeInfo) return this._runtimeInfo;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce();
    try { return await this.connecting; }
    catch (error) {
      const child = this.child;
      if (child) await terminateProcessTree(child);
      this.reset(child, 'The DeepSeek Harness SDK connection failed.');
      throw error;
    } finally { this.connecting = undefined; }
  }

  private async connectOnce(): Promise<DeepSeekHarnessRuntimeInfo> {
    this.expectedExit = false;
    this.cancelled = false;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(this.options.launch.command, [...this.options.launch.args], {
        cwd: this.options.cwd,
        env: runtimeEnvironment(process.env, this.options.launch, this.options.permission),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      throw new DeepSeekHarnessError('spawn-failed', 'Could not start the configured local DeepSeek Harness SDK. Check its installation path.');
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consume(String(chunk), child));
    // Drain stderr so the child cannot block; do not forward raw diagnostics that
    // may contain provider or credential details.
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (this.child !== child) return;
      this.reset(child, 'The DeepSeek Harness SDK process could not be started.');
      this.emit('disconnected', new DeepSeekHarnessError('spawn-failed', 'The DeepSeek Harness SDK process could not be started.'));
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const wasExpected = this.expectedExit || this.cancelled;
      const reason = wasExpected
        ? new DeepSeekHarnessError('interrupted', 'The DeepSeek Harness worker session was interrupted.', undefined)
        : new DeepSeekHarnessError('interrupted', `The DeepSeek Harness SDK process exited unexpectedly (${code ?? signal ?? 'unknown'}).`);
      this.reset(child, reason.message);
      if (!wasExpected) this.emit('disconnected', reason);
    });

    const initialized = await this.request('initialize', {
      cwd: this.options.cwd,
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
    }, 30000);
    if (!isRecord(initialized) || !isRecord(initialized.serverInfo)
      || typeof initialized.serverInfo.name !== 'string' || typeof initialized.serverInfo.version !== 'string') {
      throw new DeepSeekHarnessError('protocol-error', 'The local DeepSeek Harness returned an invalid SDK server identity.', 'initialize');
    }
    const serverInfo = { name: initialized.serverInfo.name, version: initialized.serverInfo.version };
    if (serverInfo.name !== 'deepseek-harness-sdk-runtime') {
      throw new DeepSeekHarnessError('protocol-error', 'The configured local process is not the expected DeepSeek Harness SDK runtime.', 'initialize');
    }
    const info: DeepSeekHarnessRuntimeInfo = {
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.reasoningEffort ? { requestedReasoningEffort: this.options.reasoningEffort } : {}),
      permissionMode: this.options.permission.permissionMode,
      selectedApprovalPolicy: this.options.permission.approvalPolicy,
      workspaceRoot: this.options.permission.workspaceRoot,
      writeScope: this.options.permission.writeScope,
      access: this.options.permission.access,
      filesystemScope: this.options.permission.filesystemScope,
      sessionId: this.sessionId,
      profileName: this.options.launch.profileName ?? 'sdk',
      configuredMcpServers: Object.freeze([...(this.options.launch.configuredMcpServers ?? [])]),
      mcpToolCatalog: this._mcpToolCatalog,
      serverInfo,
      ...(this.options.launch.harnessVersion ? { harnessVersion: this.options.launch.harnessVersion } : {}),
      capabilities: {
        sessionResume: true,
        workingDirectory: true,
        approvalResponse: false,
        steering: false,
        gracefulSessionCancellation: false,
        cancellation: 'process-tree-termination',
      },
    };
    this._runtimeInfo = info;
    this._ready = true;
    this.cancelled = false;
    this.emit('connected', info);
    return info;
  }

  private consume(chunk: string, child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RPC_LINE_BYTES && !this.buffer.includes('\n')) {
      this.failProtocol(child, 'The DeepSeek Harness SDK emitted an oversized JSON-RPC message.');
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
        this.failProtocol(child, 'The DeepSeek Harness SDK emitted an oversized JSON-RPC message.');
        return;
      }
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; }
      catch {
        this.emit('protocolError', new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness SDK emitted a non-JSON line.'));
        continue;
      }
      if (!isRecord(message)) {
        this.emit('protocolError', new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness SDK emitted an invalid JSON-RPC message.'));
        continue;
      }
      if (typeof message.method === 'string' && message.id !== undefined) {
        // The installed SDK currently sends no client-directed calls. Reject unknown
        // requests instead of leaving an approval or capability request unresolved.
        this.respondServerError(message.id, -32601, 'Opnex does not implement this DeepSeek Harness SDK request.');
        this.emit('unsupportedServerRequest', { method: message.method });
        continue;
      }
      if (typeof message.method === 'string') {
        const notification: DeepSeekHarnessNotification = { method: message.method, params: message.params };
        if (message.method === 'session.event') this.observeMcpToolCatalog(message.params);
        this.emit('notification', notification);
        if (message.method === 'session.event' && this.approvalEvent(message.params)) {
          this.emit('approvalRequired', {
            sessionId: this.sessionId,
            message: 'DeepSeek Harness requested an approval, but its SDK has no approval response method. The worker cannot continue under this policy.',
          });
          // Fail closed. Do not leave the worker waiting for an approval in a UI
          // Opnex cannot answer, and never treat an approval as granted.
          void this.cancel();
        }
        continue;
      }
      if (message.id !== undefined && (typeof message.id === 'number' || typeof message.id === 'string')) {
        const request = this.pending.get(Number(message.id));
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(Number(message.id));
        if (message.error) request.reject(remoteError(request.method, message.error));
        else request.resolve(message.result);
      }
    }
  }

  private approvalEvent(params: unknown) {
    if (!isRecord(params) || !isRecord(params.event)) return false;
    const type = typeof params.event.type === 'string' ? params.event.type.toLowerCase() : '';
    // DSH emits `approval/policy` as ordinary policy metadata; only an actual
    // request/pending/required event blocks execution and lacks a reply method.
    return /approval|permission|elicitation/.test(type) && /request|pending|required/.test(type);
  }

  private observeMcpToolCatalog(params: unknown) {
    if (!isRecord(params) || params.sessionId !== this.sessionId || !isRecord(params.event)) return;
    const event = params.event;
    if (event.type !== 'request/header' || !isRecord(event.data) || !isRecord(event.data.header)) return;
    const tools = event.data.header.tools;
    if (!Array.isArray(tools)) return;
    const toolNames = tools.flatMap(tool => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []);
    this._mcpToolCatalog = makeMcpToolCatalog(
      this.options.launch.configuredMcpServers ?? [],
      toolNames,
      Number.isSafeInteger(event.seq) ? Number(event.seq) : undefined,
      true,
    );
    if (this._runtimeInfo) this._runtimeInfo = { ...this._runtimeInfo, mcpToolCatalog: this._mcpToolCatalog };
    this.emit('mcpToolCatalog', this._mcpToolCatalog);
  }

  private failProtocol(child: ChildProcessWithoutNullStreams, message: string) {
    const error = new DeepSeekHarnessError('protocol-error', message);
    this.reset(child, message);
    this.emit('disconnected', error);
    void terminateProcessTree(child);
  }

  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 10 * 60 * 1000): Promise<unknown> {
    if (!supportedSdkMethods.has(method)) {
      return Promise.reject(new DeepSeekHarnessError('unsupported-capability', `The installed DeepSeek Harness SDK method ${method} is not supported.`, method));
    }
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new DeepSeekHarnessError('interrupted', 'The DeepSeek Harness SDK process is not connected.', method));
    }
    const id = ++this.requestId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeepSeekHarnessError('timeout', `The DeepSeek Harness SDK request ${method} timed out.`, method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(payload, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new DeepSeekHarnessError('interrupted', `The DeepSeek Harness SDK request ${method} could not be sent.`, method));
      });
    });
  }

  private respondServerError(id: string | number, code: number, message: string) {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message }})}\n`); } catch { /* process is closing */ }
  }

  /** Submit a text or other explicitly supported SDK content turn to this role's session. */
  async prompt(contentBlocks: readonly DeepSeekHarnessContentBlock[]) {
    await this.connect();
    await this.request('session/prompt', { sessionId: this.sessionId, contentBlocks }, this.options.requestTimeoutMs ?? 10 * 60 * 1000);
    return this.sessionId;
  }

  /** Create the persisted SDK session and submit its first assignment turn. */
  async startSession(contentBlocks: readonly DeepSeekHarnessContentBlock[]) {
    return this.prompt(contentBlocks);
  }

  /** Resume the exact persisted DSH session after an application restart. */
  async resumeSession(sessionId = this.sessionId) {
    await this.connect();
    if (sessionId !== this.sessionId) throw new DeepSeekHarnessError('configuration', 'The requested resume session does not match this task-owned runtime session.');
    return this.request('session/resume', { sessionId });
  }

  async waitSession(sessionId = this.sessionId, timeoutMs = this.options.requestTimeoutMs ?? 10 * 60 * 1000) {
    await this.connect();
    if (sessionId !== this.sessionId) throw new DeepSeekHarnessError('configuration', 'The requested wait session does not match this task-owned runtime session.');
    return this.request('session/wait', { sessionId }, timeoutMs);
  }

  async getWorkingDirectory(sessionId = this.sessionId): Promise<string> {
    await this.connect();
    if (sessionId !== this.sessionId) throw new DeepSeekHarnessError('configuration', 'The requested session does not match this task-owned runtime session.');
    const result = await this.request('session/working-directory/get', { sessionId });
    if (!isRecord(result) || typeof result.cwd !== 'string' || !path.isAbsolute(result.cwd)) {
      throw new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness returned an invalid working directory.', 'session/working-directory/get');
    }
    if (!isPathWithin(this.options.cwd, result.cwd)) {
      throw new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness working directory escaped this task’s workspace root.', 'session/working-directory/get');
    }
    return result.cwd;
  }

  async setWorkingDirectory(cwd: string, sessionId = this.sessionId): Promise<string> {
    assertAbsoluteDirectory(cwd, 'DeepSeek Harness working directory');
    if (!isPathWithin(this.options.cwd, cwd)) {
      throw new DeepSeekHarnessError('configuration', 'The DeepSeek Harness working directory cannot move outside this task’s workspace root.');
    }
    await this.connect();
    if (sessionId !== this.sessionId) throw new DeepSeekHarnessError('configuration', 'The requested session does not match this task-owned runtime session.');
    const result = await this.request('session/working-directory/set', { sessionId, cwd: path.resolve(cwd) });
    if (!isRecord(result) || typeof result.cwd !== 'string' || !path.isAbsolute(result.cwd)) {
      throw new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness returned an invalid working directory.', 'session/working-directory/set');
    }
    if (!isPathWithin(this.options.cwd, result.cwd)) {
      throw new DeepSeekHarnessError('protocol-error', 'The DeepSeek Harness returned a working directory outside this task’s workspace root.', 'session/working-directory/set');
    }
    return result.cwd;
  }

  /** The SDK has no steering request; reject instead of dropping a user's new input. */
  async steer(_contentBlocks: readonly DeepSeekHarnessContentBlock[]): Promise<never> {
    throw new DeepSeekHarnessError('unsupported-capability', 'This DeepSeek Harness SDK cannot steer an active worker session. Cancel and create a new task with the updated assignment.');
  }

  /** The SDK has no approval response; reject instead of treating a request as approved. */
  async respondToApproval(_decision: unknown): Promise<never> {
    throw new DeepSeekHarnessError('unsupported-capability', 'This DeepSeek Harness SDK cannot respond to approval requests. The task must use a supported selected permission policy.');
  }

  /** Terminate the full SDK process tree, preserving DSH session state and marking the turn interrupted. */
  async cancel(): Promise<DeepSeekHarnessCancelResult> {
    this.cancelled = true;
    this.expectedExit = true;
    const child = this.child;
    if (child) {
      await terminateProcessTree(child);
      this.reset(child, 'The DeepSeek Harness worker session was interrupted by cancellation.');
    }
    this.emit('interrupted', { sessionId: this.sessionId });
    return { status: 'interrupted', sessionId: this.sessionId };
  }

  /** Graceful close after completion; cancellation uses cancel() instead. */
  async shutdown() {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    try { await this.request('shutdown', {}, 5000); } catch { /* process-tree cleanup follows */ }
    child.stdin.end();
    await Promise.race([
      new Promise<void>(resolve => child.once('close', () => resolve())),
      delay(2000),
    ]);
    if (child.exitCode === null) await terminateProcessTree(child);
    this.reset(child, 'The DeepSeek Harness SDK process was shut down.');
  }

  private reset(child: ChildProcessWithoutNullStreams | undefined, reason: string) {
    if (child && this.child !== child) return;
    this._ready = false;
    if (!child || this.child === child) this.child = undefined;
    this.buffer = '';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new DeepSeekHarnessError('interrupted', reason, request.method));
    }
    this.pending.clear();
  }
}
