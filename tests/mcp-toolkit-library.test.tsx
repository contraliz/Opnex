// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillsLibraryPage } from '../src/ui/SkillsLibraryDialog.js';
import type { Settings } from '../src/types.js';

vi.mock('../src/ui/api.js', () => ({
  api: vi.fn(async () => ({ skills: [] })),
  apiPut: vi.fn(async () => ({})),
}));
afterEach(() => cleanup());

describe('Library MCP toolkit', () => {
  it('registers stdio servers, captures role and environment settings, and saves through application settings', async () => {
    const user = userEvent.setup(),
      save = vi.fn(async () => true);
    const settings: Settings = {
      orchestratorModel: 'gpt-6.1-sol',
      orchestratorEffort: 'low',
      approvalPolicy: 'on-request',
      mcpServers: [],
    };
    render(<SkillsLibraryPage active settings={settings} saveMcpServers={save} />);
    await user.click(await screen.findByRole('tab', { name: 'MCP toolkit' }));
    await user.click(screen.getByRole('button', { name: 'Add MCP server' }));
    const name = screen.getByDisplayValue('server-1');
    await user.clear(name);
    await user.type(name, 'project-docs');
    await user.type(screen.getByPlaceholderText('MCP_API_TOKEN'), 'MCP_API_TOKEN');
    await user.click(screen.getByRole('checkbox', { name: 'Router' }));
    await user.click(screen.getByRole('button', { name: 'Save MCP toolkit' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'project-docs',
        envVars: ['MCP_API_TOKEN'],
        codexRoles: expect.arrayContaining(['router', 'worker']),
        deepseekRoles: ['simple', 'worker', 'integrator'],
      }),
    ]);
    expect((await screen.findByRole('status')).textContent).toContain('MCP toolkit saved');
  });

  it('registers Streamable HTTP endpoints with environment-backed headers', async () => {
    const user = userEvent.setup(),
      save = vi.fn(async () => true);
    const settings: Settings = {
      orchestratorModel: 'gpt-6.1-sol',
      orchestratorEffort: 'low',
      approvalPolicy: 'on-request',
      mcpServers: [],
    };
    render(<SkillsLibraryPage active settings={settings} saveMcpServers={save} />);
    await user.click(await screen.findByRole('tab', { name: 'MCP toolkit' }));
    await user.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await user.selectOptions(screen.getByLabelText('Transport'), 'streamable-http');
    await user.type(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
      'https://docs.example.com/mcp'
    );
    await user.click(screen.getByRole('button', { name: 'Add HTTP header' }));
    await user.type(screen.getByLabelText('Header name'), 'Authorization');
    await user.type(screen.getByPlaceholderText('MCP_AUTHORIZATION'), 'MCP_API_TOKEN');
    await user.click(screen.getByRole('button', { name: 'Save MCP toolkit' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({
        transport: 'streamable-http',
        url: 'https://docs.example.com/mcp',
        httpHeaders: [{ name: 'Authorization', envVar: 'MCP_API_TOKEN' }],
        codexRoles: expect.arrayContaining(['worker']),
        deepseekRoles: ['simple', 'worker', 'integrator'],
      }),
    ]);
  });
});
