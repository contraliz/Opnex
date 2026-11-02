// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModelPicker from '../src/ui/ModelPicker.js';

const heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (heightDescriptor) Object.defineProperty(window, 'innerHeight', heightDescriptor);
});

function rect(top: number, bottom: number, height: number) {
  return {
    x: 0,
    y: top,
    width: 340,
    height,
    top,
    right: 340,
    bottom,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

it('flips the model menu below its button when the viewport has more room below', () => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 620 });
  let triggerTop = 80;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('execution-model-trigger'))
      return rect(triggerTop, triggerTop + 39, 39);
    if (this.classList.contains('execution-model-menu')) return rect(-190, 70, 260);
    return rect(0, 0, 0);
  });
  const choices = [
    {
      providerKey: 'codex',
      provider: 'Codex · OpenAI',
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      efforts: ['low'],
      available: true,
    },
  ];
  render(
    <ModelPicker
      label='Orchestrator model'
      providerKey='codex'
      model='gpt-6.1-terra'
      effort='low'
      choices={choices}
      disabled={false}
      onChange={() => {}}
    />
  );
  const trigger = screen.getByRole('button', { name: 'Orchestrator model' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Orchestrator model' })).toBeTruthy();
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  fireEvent.click(trigger);
  triggerTop = 420;
  fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('false');
});

it('moves up to the last option when keyboard navigation starts in the search field', async () => {
  const choices = [
    {
      providerKey: 'codex',
      provider: 'Codex · OpenAI',
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      efforts: ['low'],
      available: true,
    },
    {
      providerKey: 'codex',
      provider: 'Codex · OpenAI',
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      efforts: ['low'],
      available: true,
    },
  ];
  render(
    <ModelPicker
      label='Orchestrator model'
      providerKey='codex'
      model='gpt-6.1-terra'
      effort='low'
      choices={choices}
      disabled={false}
      onChange={() => {}}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Orchestrator model' }));
  const search = await screen.findByRole('textbox', { name: 'Search orchestrator model' });
  fireEvent.keyDown(search, { key: 'ArrowUp' });

  const options = screen.getAllByRole('option');
  expect(document.activeElement).toBe(options[options.length - 1]);
});

it('keeps a below-open menu anchored through its close animation', () => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 620 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('execution-model-trigger')) return rect(80, 119, 39);
    if (this.classList.contains('execution-model-menu')) return rect(-190, 70, 260);
    return rect(0, 0, 0);
  });
  const choices = [
    {
      providerKey: 'codex',
      provider: 'Codex · OpenAI',
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      efforts: ['low'],
      available: true,
    },
  ];
  render(
    <ModelPicker
      label='Orchestrator model'
      providerKey='codex'
      model='gpt-6.1-terra'
      effort='low'
      choices={choices}
      disabled={false}
      onChange={() => {}}
    />
  );
  const trigger = screen.getByRole('button', { name: 'Orchestrator model' });
  fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  act(() => {
    vi.advanceTimersByTime(110);
  });
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('false');
});

it('groups models by provider and picks a reasoning level from the side panel', () => {
  const onChange = vi.fn();
  const choices = [
    {
      providerKey: 'codex',
      provider: 'Codex · OpenAI',
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      efforts: ['low', 'high'],
      available: true,
    },
    {
      providerKey: 'deepseek',
      provider: 'DeepSeek Harness · OpenCode Go',
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      efforts: ['max'],
      available: true,
    },
  ];
  render(
    <ModelPicker
      label='Orchestrator model'
      providerKey='codex'
      model='gpt-6.1-terra'
      effort='low'
      choices={choices}
      disabled={false}
      onChange={onChange}
    />
  );
  const trigger = screen.getByRole('button', { name: 'Orchestrator model' });
  expect(trigger.textContent).toContain('GPT-6.1 Terra');
  expect(trigger.textContent).toContain('Low');
  fireEvent.click(trigger);
  const menu = screen.getByRole('dialog', { name: 'Orchestrator model' });
  expect(within(menu).getByRole('group', { name: 'Codex · OpenAI' })).toBeTruthy();
  expect(within(menu).getByRole('group', { name: 'DeepSeek Harness · OpenCode Go' })).toBeTruthy();
  const panel = within(menu).getByRole('radiogroup', {
    name: 'Reasoning effort for GPT-6.1 Terra',
  });
  expect(within(panel).getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe(
    'true'
  );
  fireEvent.mouseEnter(within(menu).getByRole('option', { name: /DeepSeek V4.1 Flash/ }));
  const nextPanel = within(menu).getByRole('radiogroup', {
    name: 'Reasoning effort for DeepSeek V4.1 Flash',
  });
  fireEvent.click(within(nextPanel).getByRole('radio', { name: 'Max' }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ providerKey: 'deepseek', id: 'deepseek-v4.1-flash' }),
    'max'
  );
});
