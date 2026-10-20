import { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Range, type SelectionRange } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet } from '@codemirror/view';
import { placeholder } from '@codemirror/view';

const hiddenMarker = Decoration.mark({ class: 'cm-live-mark-hidden' });
const strongMark = Decoration.mark({ class: 'cm-live-strong' });
const emphasisMark = Decoration.mark({ class: 'cm-live-emphasis' });
const codeMark = Decoration.mark({ class: 'cm-live-code' });
const linkMark = Decoration.mark({ class: 'cm-live-link' });
const headingMarks = [1, 2, 3, 4, 5, 6].map(level => Decoration.mark({ class: `cm-live-heading-${level}` }));

export function prepareMarkdownSubmission(source: string): string | null {
  return source.trim() ? source : null;
}

export function markdownLiveDecorations(state: EditorState, selection: SelectionRange, focused: boolean): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const add = (decoration: Decoration, from: number, to: number) => {
    if (from < to) decorations.push(decoration.range(from, to));
  };
  const markersOf = (node: ReturnType<typeof syntaxTree>['topNode'], name: string) => {
    const found: Array<{ from: number; to: number }> = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === name) found.push({ from: child.from, to: child.to });
    }
    return found;
  };
  const reveal = (from: number, to: number) => {
    if (!focused) return false;
    if (!selection.empty) return selection.from < to && selection.to > from;
    return selection.head >= from && selection.head < to;
  };

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      const name = node.name;
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode') {
        const markers = markersOf(node, name === 'InlineCode' ? 'CodeMark' : 'EmphasisMark');
        if (markers.length >= 2) {
          const bodyFrom = markers[0].to;
          const bodyTo = markers[markers.length - 1].from;
          if (!reveal(node.from, node.to)) {
            add(name === 'StrongEmphasis' ? strongMark : name === 'Emphasis' ? emphasisMark : codeMark, bodyFrom, bodyTo);
            for (const marker of markers) add(hiddenMarker, marker.from, marker.to);
          }
        }
      } else if (name === 'Link') {
        const marks = markersOf(node, 'LinkMark');
        if (marks.length >= 2 && !reveal(node.from, node.to)) {
          add(linkMark, marks[0].to, marks[1].from);
          add(hiddenMarker, node.from, marks[0].to);
          add(hiddenMarker, marks[1].from, node.to);
          return false;
        }
      } else if (/^ATXHeading[1-6]$/.test(name)) {
        const header = markersOf(node, 'HeaderMark')[0];
        const level = Number(name.slice(-1));
        if (header && !reveal(node.from, node.to)) {
          add(headingMarks[level - 1], header.to, node.to);
          add(hiddenMarker, header.from, header.to);
          return false;
        }
      }
      return undefined;
    },
  });
  return Decoration.set(decorations, true);
}

function buildLiveDecorations(view: EditorView): DecorationSet {
  return markdownLiveDecorations(view.state, view.state.selection.main, view.hasFocus);
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildLiveDecorations(view); }
  update(update: import('@codemirror/view').ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = buildLiveDecorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });

const editorTheme = EditorView.theme({
  '&': { height: '100%', minHeight: '55px', backgroundColor: 'transparent', color: '#eeeeee', fontSize: '14px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.55' },
  '.cm-content': { minHeight: '55px', padding: '6px 7px', caretColor: '#c1b6ff' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#c1b6ff' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#514778 !important' },
  '&.cm-focused': { outline: 'none' },
});
const placeholderConfig = new Compartment();

type Props = {
  value: string;
  onChange: (value: string) => void;
  submit: () => void;
  disabled: boolean;
  hint: string;
  inputRef: { current: HTMLElement | null };
};

export function LiveMarkdownEditor({ value, onChange, submit, disabled, hint, inputRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, submit, disabled });
  latest.current = { onChange, submit, disabled };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ extensions: [GFM] }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.editable.of(true),
          placeholderConfig.of(placeholder(hint)),
          EditorView.contentAttributes.of({ role: 'textbox', 'aria-label': 'Task message', 'aria-multiline': 'true', spellcheck: 'false' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            keydown(event, current) {
              if (event.key !== 'Enter' || event.shiftKey) return false;
              if (event.isComposing || current.composing || event.keyCode === 229) return false;
              event.preventDefault();
              if (!latest.current.disabled) latest.current.submit();
              return true;
            },
          }),
          livePreview,
          editorTheme,
        ],
      }),
    });
    viewRef.current = view;
    inputRef.current = view.contentDOM;
    return () => {
      if (inputRef.current === view.contentDOM) inputRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: placeholderConfig.reconfigure(placeholder(hint)) });
  }, [hint]);

  return <div className="live-markdown-editor" ref={host} data-placeholder={hint} />;
}
