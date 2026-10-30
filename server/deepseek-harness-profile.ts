import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeepSeekHarnessError, type DeepSeekHarnessSdkLaunch } from './deepseek-harness.js';

const PROFILE_TEMPLATE = 'sdk';
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const PI_AI_PLUGIN_ID = 'llm-pi-ai';
const VERIFIED_PROVIDER_ROUTE = 'opencode-go';
const ALLOWED_MCP_SERVER_NAMES = new Set(['pseudoharness_skills','pseudoharness_workspace']);
const MAX_SERVER_CONFIG_BYTES = 16 * 1024;

export type DeepSeekHarnessMcpServerConfig = {
  serverName: 'pseudoharness_skills'|'pseudoharness_workspace';
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
};

export type DeepSeekHarnessTaskProfileOptions = {
  /** A new task/role-owned home, separate from the user's ordinary DSH home. */
  dshHome: string;
  /** The existing DSH credential file path. Its contents are never opened here. */
  credentialStorePath: string;
  /** A provider route verified in the installed profile and catalog. */
  provider: string;
  /** A task/role-owned profile identity, for example `pseudoharness-<id>-worker`. */
  profileName: string;
  launch: DeepSeekHarnessSdkLaunch;
  /** Only Opnex-owned scoped stdio gateways are admitted. */
  mcpServers: readonly DeepSeekHarnessMcpServerConfig[];
  spawnProcess?: typeof spawn;
};

export type PreparedDeepSeekHarnessTaskProfile = {
  profileName: string;
  dshHome: string;
  agentsHome: string;
  profileDirectory: string;
  patchPath: string;
  configuredMcpServers: readonly DeepSeekHarnessMcpServerConfig['serverName'][];
  /** Ephemeral child-process values; do not persist, log, or include in receipts. */
  launchEnvironment: NodeJS.ProcessEnv;
};

/* Build the final runtime launch from a prepared task-owned profile. */
export function applyDeepSeekHarnessTaskProfileLaunch(
  template: DeepSeekHarnessSdkLaunch,
  profile: Pick<PreparedDeepSeekHarnessTaskProfile, 'profileName' | 'launchEnvironment' | 'configuredMcpServers'>,
): DeepSeekHarnessSdkLaunch {
  const profileIndex = template.args.indexOf('--profile');
  if ((template.profileName ?? PROFILE_TEMPLATE) !== PROFILE_TEMPLATE
    || profileIndex < 0 || template.args[profileIndex + 1] !== PROFILE_TEMPLATE) {
    throw new DeepSeekHarnessError('configuration', 'Task profiles must be applied to the installed default SDK launch.');
  }
  const args = [...template.args];
  args[profileIndex + 1] = profile.profileName;
  return {
    ...template,
    args,
    profileName: profile.profileName,
    configuredMcpServers: Object.freeze([...profile.configuredMcpServers]),
    env: { ...template.env, ...profile.launchEnvironment },
  };
}

/** The DSH default credential file, resolved by documented home precedence without reading it. */
export function resolveDeepSeekHarnessCredentialStorePath(options: {
  configuredHome?: string;
  userHome?: string;
} = {}) {
  const configuredHome = options.configuredHome?.trim() || process.env.DSH_HOME?.trim();
  const home = configuredHome || path.join(options.userHome ?? os.homedir(), '.dsh');
  if (!path.isAbsolute(home)) {
    throw new DeepSeekHarnessError('configuration', 'The existing DeepSeek Harness home must resolve to an absolute path before its credential file can be referenced.');
  }
  return path.join(path.resolve(home), '.credentials.yaml');
}

/**
 * Prepare an isolated, task-owned DSH SDK profile and its scoped stdio MCP gateways.
 * The profile stores only the existing credential file's path. MCP server configs,
 * including their explicit env maps, are passed through private launch environment
 * variables and resolved by trusted static `!!js` expressions at SDK startup.
 */
export async function prepareDeepSeekHarnessTaskProfile(
  options: DeepSeekHarnessTaskProfileOptions,
): Promise<PreparedDeepSeekHarnessTaskProfile> {
  const dshHome = path.resolve(options.dshHome);
  const credentialStorePath = path.resolve(options.credentialStorePath);
  const profileName = options.profileName;
  if (!path.isAbsolute(options.dshHome) || !path.isAbsolute(options.credentialStorePath)) {
    throw new DeepSeekHarnessError('configuration', 'The task-owned DSH home and existing credential-store path must be absolute paths.');
  }
  if (!/^pseudoharness-[a-z0-9-]{1,54}$/.test(profileName)) {
    throw new DeepSeekHarnessError('configuration', 'The isolated DSH profile must have a unique pseudoharness- task/role name.');
  }
  if (options.provider !== VERIFIED_PROVIDER_ROUTE) {
    throw new DeepSeekHarnessError('unsupported-capability', 'Only the verified OpenCode Go provider route is currently enabled for recruited DeepSeek Harness workers. No provider fallback was started.');
  }
  if (path.basename(credentialStorePath).toLowerCase() !== '.credentials.yaml'
    || isPathWithin(dshHome, credentialStorePath)) {
    throw new DeepSeekHarnessError('configuration', 'The task profile must reference the existing DSH credential file by path outside its isolated task home; it will not copy credentials into the profile.');
  }
  if (!existsSync(credentialStorePath)) {
    throw new DeepSeekHarnessError('authentication', 'The existing DeepSeek Harness credential store was not found at its configured path. Sign in through the installed Harness profile, then retry.');
  }
  const profileNameInLaunch = options.launch.profileName ?? PROFILE_TEMPLATE;
  if (profileNameInLaunch !== PROFILE_TEMPLATE) {
    throw new DeepSeekHarnessError('configuration', 'Create task-specific profiles from the installed default SDK profile, not from another custom profile.');
  }
  const profileFlag = options.launch.args.indexOf('--profile');
  if (profileFlag < 0 || options.launch.args[profileFlag + 1] !== PROFILE_TEMPLATE) {
    throw new DeepSeekHarnessError('configuration', 'The selected local Harness launch does not identify the installed SDK profile entry point.');
  }

  const servers = validateMcpServers(options.mcpServers);
  const agentsHome = path.join(dshHome, 'pseudoharness-agents');
  const profileDirectory = path.join(dshHome, 'profiles', profileName);
  const patchPath = path.join(profileDirectory, 'cordis.patch.yml');
  const patch = renderProfilePatch(credentialStorePath, servers, options.provider);
  const launchEnvironment: NodeJS.ProcessEnv = {
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
  };

  for (const server of servers) {
    const config = {
      serverName: server.serverName,
      transport: 'stdio',
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      env: { ...server.env },
      failOnStartupError: true,
    };
    const variable = environmentNameFor(server.serverName);
    const serialized = JSON.stringify(config);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SERVER_CONFIG_BYTES) {
      throw new DeepSeekHarnessError('configuration', `The ${server.serverName} MCP gateway configuration exceeds the safe per-process limit.`);
    }
    launchEnvironment[variable] = serialized;
    launchEnvironment[opnexEnvironmentNameFor(server.serverName)] = serialized;
  }

  mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  mkdirSync(agentsHome, { recursive: true, mode: 0o700 });
  if (readdirSync(agentsHome).length > 0) {
    throw new DeepSeekHarnessError('configuration', 'The task-owned DeepSeek Harness instructions directory is not empty. Use a fresh isolated DSH home; global agent instructions and skills will not be imported.');
  }
  for (const homeConfig of ['.env', 'cordis.patch.yml']) {
    if (existsSync(path.join(dshHome, homeConfig))) {
      throw new DeepSeekHarnessError('configuration', 'The task-owned DSH home contains a home-level environment or configuration patch. Remove it from this new isolated task home or choose a fresh path.');
    }
  }

  if (existsSync(profileDirectory)) {
    assertReusableProfile(profileDirectory, patch);
  } else {
    await createFromSdkTemplate(options, dshHome, agentsHome, profileName);
    if (!existsSync(profileDirectory)) {
      throw new DeepSeekHarnessError('configuration', 'The installed DeepSeek Harness did not create the requested task-owned SDK profile. The worker was not started.');
    }
    const defaultPatch = readFileSync(patchPath, 'utf8');
    if (!/^\s*(?:#.*\r?\n)*\[\s*\]\s*$/.test(defaultPatch)) {
      throw new DeepSeekHarnessError('configuration', 'The newly created DeepSeek Harness task profile was not empty. The worker was not started and profile contents were preserved.');
    }
    writeFileSync(patchPath, patch, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    profileName,
    dshHome,
    agentsHome,
    profileDirectory,
    patchPath,
    configuredMcpServers: servers.map(server => server.serverName),
    launchEnvironment,
  };
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateMcpServers(servers: readonly DeepSeekHarnessMcpServerConfig[]) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new DeepSeekHarnessError('configuration', 'At least one scoped Opnex MCP gateway must be configured for this DSH profile.');
  }
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server || !ALLOWED_MCP_SERVER_NAMES.has(server.serverName)) {
      throw new DeepSeekHarnessError('configuration', 'Only the task-scoped Opnex Skills and workspace Git MCP gateways can be registered in this task profile.');
    }
    if (seen.has(server.serverName)) {
      throw new DeepSeekHarnessError('configuration', `The ${server.serverName} MCP gateway is listed more than once.`);
    }
    seen.add(server.serverName);
    if (!server.command.trim() || !path.isAbsolute(server.cwd)) {
      throw new DeepSeekHarnessError('configuration', `The ${server.serverName} MCP gateway needs a command and an absolute working directory.`);
    }
    if (!Array.isArray(server.args) || !server.args.every((arg: string) => typeof arg === 'string')) {
      throw new DeepSeekHarnessError('configuration', `The ${server.serverName} MCP gateway arguments must be strings.`);
    }
    const env = server.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.entries(env).some(([key, value]) => !key.trim() || typeof value !== 'string')) {
      throw new DeepSeekHarnessError('configuration', `The ${server.serverName} MCP gateway environment must contain named string values.`);
    }
  }
  return [...servers];
}

function environmentNameFor(serverName: string) {
  const suffix = createHash('sha256').update(serverName).digest('hex').slice(0, 16).toUpperCase();
  return `PSEUDOHARNESS_DSH_MCP_CONFIG_${suffix}`;
}

function opnexEnvironmentNameFor(serverName: string) {
  return environmentNameFor(serverName).replace(/^PSEUDOHARNESS_/, 'OPNEX_');
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function renderProfilePatch(credentialStorePath: string, servers: readonly DeepSeekHarnessMcpServerConfig[], provider: string) {
  const rows = [
    '- id: credentials',
    '  config:',
    `    path: ${yamlString(credentialStorePath)}`,
    '    watch: true',
    `- id: ${PI_AI_PLUGIN_ID}`,
    '  config:',
    '    providers:',
    `      ${yamlString(provider)}: {}`,
    '- insert:',
  ];
  for (const server of servers) {
    const variable = environmentNameFor(server.serverName);
    rows.push(
      `    - id: pseudoharness-mcp-${server.serverName}`,
      `      name: ${yamlString(MCP_CLIENT_PACKAGE)}`,
      `      config: !!js ${yamlString(`JSON.parse(process.env.${variable})`)}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

function assertReusableProfile(profileDirectory: string, expectedPatch: string) {
  const patchPath = path.join(profileDirectory, 'cordis.patch.yml');
  const packagePath = path.join(profileDirectory, 'package.json');
  if (!existsSync(patchPath) || !existsSync(packagePath)) {
    throw new DeepSeekHarnessError('configuration', 'The existing task profile is incomplete. It was preserved; use a fresh task-owned DSH home or restore the saved profile files.');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); }
  catch {
    throw new DeepSeekHarnessError('configuration', 'The existing task profile manifest is invalid. It was preserved; use a fresh task-owned DSH home.');
  }
  const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.length !== 2
    || bundles[0] !== '@deepseek-ai/dsh-base' || bundles[1] !== '@deepseek-ai/dsh-sdk-app') {
    throw new DeepSeekHarnessError('configuration', 'The existing task profile does not match the verified SDK template. It was preserved; use a fresh task-owned DSH home.');
  }
  if (readFileSync(patchPath, 'utf8') !== expectedPatch) {
    throw new DeepSeekHarnessError('configuration', 'The existing task profile differs from its saved scoped MCP configuration. It was preserved; use a fresh task-owned DSH home.');
  }
}

async function createFromSdkTemplate(
  options: DeepSeekHarnessTaskProfileOptions,
  dshHome: string,
  agentsHome: string,
  profileName: string,
) {
  const profileFlag = options.launch.args.indexOf('--profile');
  const entryArgs = options.launch.args.slice(0, profileFlag);
  const args = [
    ...entryArgs,
    '--profile', profileName,
    '--from-default-profile', PROFILE_TEMPLATE,
    '--help',
  ];
  const env: NodeJS.ProcessEnv = {};
  const inheritedAllowList = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'OS',
    'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROGRAMW6432', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'TZ',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && inheritedAllowList.has(key.toUpperCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.launch.env ?? {})) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE ??= '1';
  env.HOME = dshHome;
  env.DSH_HOME = dshHome;
  env.DSH_AGENTS_HOME = agentsHome;
  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnProcess(options.launch.command, args, {
      cwd: dshHome,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    throw new DeepSeekHarnessError('configuration', 'Could not initialize the isolated DeepSeek Harness SDK profile. Check the installed SDK path and version.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new DeepSeekHarnessError('timeout', 'The isolated DeepSeek Harness SDK profile did not initialize within 30 seconds.'));
    }, 30000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new DeepSeekHarnessError('configuration', 'Could not initialize the isolated DeepSeek Harness SDK profile. Check the installed SDK path and version.'));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new DeepSeekHarnessError('configuration', 'The installed DeepSeek Harness could not create an isolated SDK profile from its SDK template.'));
    });
  });
}
