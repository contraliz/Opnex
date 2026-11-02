import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../server/contracts.js';
import {
  codexMcpServerConfigs,
  deepSeekMcpServerConfigs,
  mcpServerRegistrationsSchema,
  registrationAllowsMcpTool,
  type McpServerRegistration,
} from '../server/mcp-registration.js';

const registration: McpServerRegistration = {
  name: 'project-tools',
  command: 'node',
  args: ['server.js', '--stdio'],
  cwd: 'D:/mcp/project-tools',
  envVars: ['MCP_API_TOKEN'],
  codexRoles: ['worker', 'qa'],
  deepseekRoles: ['worker'],
};

describe('Opnex MCP registrations', () => {
  it('keeps Codex secrets as environment-name allowlists and attaches role-scoped stdio config', () => {
    const configs = codexMcpServerConfigs([registration], 'worker', 'D:/workspace', [], {
      MCP_API_TOKEN: 'secret-value',
    });
    expect(configs).toEqual({
      'opnex_project-tools': {
        command: 'node',
        args: ['server.js', '--stdio'],
        cwd: 'D:/mcp/project-tools',
        env_vars: ['MCP_API_TOKEN'],
        default_tools_approval_mode: 'auto',
        enabled: true,
      },
    });
    expect(JSON.stringify(configs)).not.toContain('secret-value');
    expect(
      codexMcpServerConfigs([registration], 'router', 'D:/workspace', [], {
        MCP_API_TOKEN: 'secret-value',
      })
    ).toEqual({});
  });

  it('resolves DeepSeek environment values only into its ephemeral launch config', () => {
    expect(
      deepSeekMcpServerConfigs([registration], 'worker', 'D:/workspace', {
        MCP_API_TOKEN: 'secret-value',
      })
    ).toEqual([
      {
        serverName: 'opnex_project-tools',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--stdio'],
        cwd: 'D:/mcp/project-tools',
        env: { MCP_API_TOKEN: 'secret-value' },
      },
    ]);
  });

  it('registers Streamable HTTP endpoints with environment-backed headers for both providers', () => {
    const httpRegistration: McpServerRegistration = {
      ...registration,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      envVars: [],
      deepseekRoles: ['simple', 'worker', 'integrator'],
      httpHeaders: [{ name: 'Authorization', envVar: 'MCP_API_TOKEN' }],
    };
    const environment = { MCP_API_TOKEN: 'Bearer secret-value' };
    const codex = codexMcpServerConfigs(
      [httpRegistration],
      'worker',
      'D:/workspace',
      [],
      environment
    );
    expect(codex).toEqual({
      'opnex_project-tools': {
        url: 'https://mcp.example.com/mcp',
        env_http_headers: { Authorization: 'MCP_API_TOKEN' },
        default_tools_approval_mode: 'auto',
        enabled: true,
      },
    });
    expect(JSON.stringify(codex)).not.toContain('secret-value');
    for (const role of ['simple', 'worker', 'integrator'] as const)
      expect(
        deepSeekMcpServerConfigs([httpRegistration], role, 'D:/workspace', environment)
      ).toEqual([
        {
          serverName: 'opnex_project-tools',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer secret-value' },
        },
      ]);
    expect(() =>
      codexMcpServerConfigs([httpRegistration], 'worker', 'D:/workspace', [], {})
    ).toThrow('MCP_API_TOKEN');
    expect(() =>
      deepSeekMcpServerConfigs([httpRegistration], 'worker', 'D:/workspace', {})
    ).toThrow('no agent was started');
    expect(() =>
      codexMcpServerConfigs([httpRegistration], 'worker', 'D:/workspace', [], {
        MCP_API_TOKEN: 'Bearer secret\r\nX-Injected: yes',
      })
    ).toThrow('invalid HTTP header value');
  });

  it('fails closed when an enabled server references a missing environment variable', () => {
    expect(() => codexMcpServerConfigs([registration], 'worker', 'D:/workspace', [], {})).toThrow(
      'MCP_API_TOKEN'
    );
    expect(() => deepSeekMcpServerConfigs([registration], 'worker', 'D:/workspace', {})).toThrow(
      'no agent was started'
    );
  });

  it('rejects unsafe names, duplicate role entries, and duplicate server registrations', () => {
    expect(
      mcpServerRegistrationsSchema.safeParse([{ ...registration, name: 'bad.name' }]).success
    ).toBe(false);
    expect(
      mcpServerRegistrationsSchema.safeParse([
        { ...registration, codexRoles: ['worker', 'worker'] },
      ]).success
    ).toBe(false);
    expect(mcpServerRegistrationsSchema.safeParse([registration, registration]).success).toBe(
      false
    );
    expect(
      mcpServerRegistrationsSchema.safeParse([
        { ...registration, transport: 'streamable-http', url: 'http://mcp.example.com/mcp' },
      ]).success
    ).toBe(false);
    expect(
      mcpServerRegistrationsSchema.safeParse([
        {
          ...registration,
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp?token=secret',
        },
      ]).success
    ).toBe(false);
    expect(
      mcpServerRegistrationsSchema.safeParse([
        {
          ...registration,
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          httpHeaders: [{ name: 'Authorization', envVar: 'bad-name' }],
        },
      ]).success
    ).toBe(false);
    expect(
      mcpServerRegistrationsSchema.safeParse([
        { ...registration, transport: 'streamable-http', url: 'http://localhost:3000/mcp' },
      ]).success
    ).toBe(true);
  });

  it('accepts absolute paths from either platform without importing Node path code into the UI', () => {
    expect(
      mcpServerRegistrationsSchema.safeParse([{ ...registration, cwd: '/opt/mcp/project-tools' }])
        .success
    ).toBe(true);
    expect(
      mcpServerRegistrationsSchema.safeParse([{ ...registration, cwd: 'D:\\mcp\\project-tools' }])
        .success
    ).toBe(true);
    expect(
      mcpServerRegistrationsSchema.safeParse([
        { ...registration, cwd: 'D:relative\\project-tools' },
      ]).success
    ).toBe(false);
    expect(
      mcpServerRegistrationsSchema.safeParse([{ ...registration, cwd: 'mcp/project-tools' }])
        .success
    ).toBe(false);
  });

  it('uses Opnex role selections to authorize only the matching registered MCP server', () => {
    expect(registrationAllowsMcpTool([registration], 'codex', 'qa', 'opnex_project-tools')).toBe(
      true
    );
    expect(
      registrationAllowsMcpTool([registration], 'codex', 'router', 'opnex_project-tools')
    ).toBe(false);
    expect(
      registrationAllowsMcpTool([registration], 'deepseek', 'worker', 'opnex_project-tools')
    ).toBe(true);
    expect(registrationAllowsMcpTool([registration], 'codex', 'worker', 'github')).toBe(false);
  });

  it('stores the registrations in validated application settings and defaults old settings to none', () => {
    const base = { orchestratorModel: 'gpt-6.1-sol', orchestratorEffort: 'low' };
    expect(settingsSchema.parse(base).mcpServers).toEqual([]);
    expect(settingsSchema.parse({ ...base, mcpServers: [registration] }).mcpServers).toEqual([
      registration,
    ]);
    expect(
      settingsSchema.safeParse({
        ...base,
        mcpServers: [{ ...registration, envVars: ['literal-secret'] }],
      }).success
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        ...base,
        mcpServers: [{ ...registration, envVars: ['MCP-API-TOKEN'] }],
      }).success
    ).toBe(false);
  });
});
