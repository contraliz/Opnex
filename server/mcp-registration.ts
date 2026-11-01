import { z } from 'zod';

export const codexMcpRoles = ['router','direct','simple','orchestrator','worker','integrator','qa'] as const;
export const deepSeekMcpRoles = ['simple','worker','integrator'] as const;
export type CodexMcpRole = typeof codexMcpRoles[number];
export type DeepSeekMcpRole = typeof deepSeekMcpRoles[number];

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const unique = <T extends string>(values: T[]) => new Set(values).size === values.length;
const headerName = z.string().trim().regex(/^[A-Za-z0-9-]{1,128}$/);
const isAbsolutePath = (value:string) => value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);

export function isSafeMcpHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isSafeMcpHttpHeaderValue(value: string): boolean {
  if(value.length>8192)return false;
  for(let index=0;index<value.length;index++){
    const code=value.charCodeAt(index);
    if(code<=8||code>=10&&code<=31||code===127)return false;
  }
  return true;
}

export const mcpServerRegistrationSchema = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  transport: z.enum(['stdio','streamable-http']).optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  args: z.array(z.string().max(2048)).max(64).default([]),
  cwd: z.string().trim().max(1024).optional().refine(value => !value || isAbsolutePath(value), 'Working directory must be an absolute path.'),
  envVars: z.array(envName).max(32).refine(unique, 'Environment variable names must be unique.'),
  url: z.string().trim().max(2048).optional(),
  httpHeaders: z.array(z.object({name:headerName,envVar:envName}).strict()).max(32).optional()
    .refine(rows => !rows || unique(rows.map(row => row.name.toLowerCase())), 'HTTP header names must be unique.'),
  codexRoles: z.array(z.enum(codexMcpRoles)).max(codexMcpRoles.length).refine(unique, 'Codex roles must be unique.'),
  deepseekRoles: z.array(z.enum(deepSeekMcpRoles)).max(deepSeekMcpRoles.length).refine(unique, 'DeepSeek roles must be unique.'),
}).strict().superRefine((registration,context)=>{
  const transport=registration.transport||'stdio';
  if(transport==='stdio'&&!registration.command)context.addIssue({code:z.ZodIssueCode.custom,path:['command'],message:'A command is required for stdio MCP servers.'});
  if(transport==='streamable-http'&&!isSafeMcpHttpUrl(registration.url))context.addIssue({code:z.ZodIssueCode.custom,path:['url'],message:'Use an HTTPS URL, or HTTP on localhost only; credentials, query values, and fragments are not allowed in the URL.'});
});

export type McpServerRegistration = z.infer<typeof mcpServerRegistrationSchema>;

export const mcpServerRegistrationsSchema = z.array(mcpServerRegistrationSchema).max(20)
  .refine(rows => unique(rows.map(row => row.name)), 'MCP server names must be unique.');

export function opnexMcpServerName(registration: Pick<McpServerRegistration, 'name'>): `opnex_${string}` {
  return `opnex_${registration.name}`;
}

export function selectedMcpServerNames(registrations: readonly McpServerRegistration[], provider: 'codex' | 'deepseek', role: string) {
  return matchingRegistrations(registrations, role, provider).map(opnexMcpServerName);
}

function assertEnvironmentReferences(registration: McpServerRegistration, environment: NodeJS.ProcessEnv) {
  const variables = registration.transport === 'streamable-http'
    ? (registration.httpHeaders||[]).map(header=>header.envVar)
    : registration.envVars;
  const missing = [...new Set(variables)].filter(variable => environment[variable] === undefined);
  if (missing.length) {
    throw new Error(`MCP server "${registration.name}" requires environment variable${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. Set them before starting Opnex; no agent was started.`);
  }
  if(registration.transport==='streamable-http')for(const header of registration.httpHeaders||[]){
    const value=environment[header.envVar]!;
    if(!isSafeMcpHttpHeaderValue(value))throw new Error(`MCP server "${registration.name}" uses environment variable ${header.envVar} with an invalid HTTP header value. No agent was started.`);
  }
}

function matchingRegistrations(registrations: readonly McpServerRegistration[], role: string, provider: 'codex' | 'deepseek') {
  return registrations.filter(registration => provider === 'codex'
    ? registration.codexRoles.includes(role as CodexMcpRole)
    : registration.deepseekRoles.includes(role as DeepSeekMcpRole));
}

export function codexMcpServerConfigs(
  registrations: readonly McpServerRegistration[],
  role: CodexMcpRole,
  workspaceRoot: string,
  inheritedNames: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configs: Record<string, Record<string, unknown>> = {};
  const reserved = new Set(inheritedNames);
  for (const registration of matchingRegistrations(registrations, role, 'codex')) {
    const serverName = opnexMcpServerName(registration);
    if (reserved.has(serverName)) throw new Error(`MCP server name "${serverName}" is already used by the Codex profile. Rename the Opnex registration before starting this role.`);
    assertEnvironmentReferences(registration, environment);
    const transport=registration.transport||'stdio';
    const serverConfig=transport==='streamable-http'
      ? {
        url:registration.url,
        ...((registration.httpHeaders||[]).length?{env_http_headers:Object.fromEntries((registration.httpHeaders||[]).map(header=>[header.name,header.envVar]))}:{}),
      }
      : {
        command: registration.command,
        args: [...registration.args],
        cwd: registration.cwd || workspaceRoot,
        ...(registration.envVars.length ? { env_vars: [...registration.envVars] } : {}),
      };
    configs[serverName] = {
      ...serverConfig,
      default_tools_approval_mode: 'auto',
      enabled: true,
    };
  }
  return configs;
}

export function deepSeekMcpServerConfigs(
  registrations: readonly McpServerRegistration[],
  role: DeepSeekMcpRole,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return matchingRegistrations(registrations, role, 'deepseek').map(registration => {
    assertEnvironmentReferences(registration, environment);
    const serverName=opnexMcpServerName(registration);
    if(registration.transport==='streamable-http'){
      const headers=Object.fromEntries((registration.httpHeaders||[]).map(header=>[header.name,environment[header.envVar]!]));
      return {serverName,transport:'streamable-http' as const,url:registration.url!,...(Object.keys(headers).length?{headers}:{})};
    }
    const env: Record<string, string> = {};
    for (const variable of registration.envVars) env[variable] = environment[variable]!;
    return {
      serverName,
      transport:'stdio' as const,
      command: registration.command!,
      args: [...registration.args],
      cwd: registration.cwd || workspaceRoot,
      ...(Object.keys(env).length ? { env } : {}),
    };
  });
}

export function registrationAllowsMcpTool(
  registrations: readonly McpServerRegistration[] | undefined,
  provider: 'codex' | 'deepseek',
  role: string,
  serverName: unknown,
) {
  if (typeof serverName !== 'string') return false;
  return matchingRegistrations(registrations || [], role, provider).some(registration => opnexMcpServerName(registration) === serverName);
}
