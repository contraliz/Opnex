import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { markdownLiveDecorations, prepareMarkdownSubmission } from '../src/ui/LiveMarkdownEditor.js';

function ranges(state: EditorState, selection: ReturnType<typeof EditorSelection.cursor>, focused = true) {
  const result: Array<{ from: number; to: number; className: string }> = [];
  markdownLiveDecorations(state, selection, focused).between(0, state.doc.length, (from, to, value) => {
    result.push({ from, to, className: value.spec.class || '' });
  });
  return result;
}

describe('caret-aware Markdown decorations', () => {
  it('preserves the exact nonblank source for one send and rejects only whitespace-only drafts', () => {
    const source = '  **asd**\n\n- item  ';
    expect(prepareMarkdownSubmission(source)).toBe(source);
    expect(prepareMarkdownSubmission(' \n\t ')).toBeNull();
  });

  it('renders bold text and hides delimiters when the caret leaves the source segment', () => {
    const source = 'Before **asd** after';
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: [GFM] })] });
    const outside = ranges(state, EditorSelection.cursor(source.length));
    expect(outside).toContainEqual({ from: 9, to: 12, className: 'cm-live-strong' });
    expect(outside.filter(range => range.className === 'cm-live-mark-hidden')).toEqual([
      { from: 7, to: 9, className: 'cm-live-mark-hidden' },
      { from: 12, to: 14, className: 'cm-live-mark-hidden' },
    ]);
    expect(state.doc.toString()).toBe(source);
  });

  it('reveals exact Markdown delimiters when the caret or selection enters the formatted segment', () => {
    const source = 'Before **asd** after';
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: [GFM] })] });
    expect(ranges(state, EditorSelection.cursor(10)).some(range => range.className === 'cm-live-mark-hidden')).toBe(false);
    expect(ranges(state, EditorSelection.range(9, 12)).some(range => range.className === 'cm-live-mark-hidden')).toBe(false);
    expect(state.doc.toString()).toBe(source);
  });

  it('renders other supported inline and heading syntax without mutating the source', () => {
    const source = '# Title\n\n*emphasis* and `code` and [link](https://example.test)';
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: [GFM] })] });
    const outside = ranges(state, EditorSelection.cursor(source.length), false);
    expect(outside.some(range => range.className === 'cm-live-heading-1')).toBe(true);
    expect(outside.some(range => range.className === 'cm-live-emphasis')).toBe(true);
    expect(outside.some(range => range.className === 'cm-live-code')).toBe(true);
    expect(outside.some(range => range.className === 'cm-live-link')).toBe(true);
    expect(state.doc.toString()).toBe(source);
  });
});
