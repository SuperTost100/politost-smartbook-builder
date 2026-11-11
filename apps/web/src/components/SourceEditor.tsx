import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { useDebounced } from '../lib/hooks';
import { findMathErrors } from '../lib/mathErrors';
import { ContentFlow } from '../reader/ContentFlow';
import { formulaMap, prepareSnippet, previewSource } from '../reader/render';
import './source-editor.css';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  label: string;
  autoFocus?: boolean;
  placeholder?: string;
  minRows?: number;
  /** Code in another language (a drawing's source): plain text with line numbers instead of the Markdown source dialect. */
  code?: boolean;
  /** With `code`: the 1-based line to mark as the one that does not compile. */
  errorLine?: number | null;
}

const errorLineMark = Decoration.line({ class: 'se-error-line' });

/** CodeMirror 6 on the source dialect. Ctrl/Cmd+Enter saves, Esc cancels. Tab moves focus on. */
export function SourceEditor({ value, onChange, onSave, onCancel, label, autoFocus, placeholder, minRows = 4, code, errorLine }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const attrs = useRef(new Compartment());
  const marks = useRef(new Compartment());
  const cb = useRef({ onChange, onSave, onCancel });
  cb.current = { onChange, onSave, onCancel };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        code ? [lineNumbers(), EditorState.tabSize.of(2)] : markdown(),
        code ? [] : EditorView.lineWrapping,
        marks.current.of([]),
        placeholder ? cmPlaceholder(placeholder) : [],
        attrs.current.of(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: code ? 'false' : 'true' })),
        keymap.of([
          { key: 'Mod-Enter', run: () => { cb.current.onSave?.(); return true; } },
          { key: 'Escape', run: () => { if (!cb.current.onCancel) return false; cb.current.onCancel(); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        EditorView.theme({
          '&': { color: 'var(--ink)', backgroundColor: 'var(--surface)', fontSize: '14px', border: '1px solid var(--border)', borderRadius: '8px' },
          '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '1px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', minHeight: `${minRows * 22}px`, maxHeight: '420px' },
          '.cm-content': { padding: '10px 12px', caretColor: 'var(--accent)' },
          '.cm-cursor': { borderLeftColor: 'var(--accent)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--marker) !important' },
          '.cm-placeholder': { color: 'var(--ink-muted)' },
          '.cm-gutters': { backgroundColor: 'var(--code-bg, var(--surface))', color: 'var(--ink-subtle)', border: 'none', borderRadius: '8px 0 0 8px' },
          '.se-error-line': { backgroundColor: 'var(--danger-soft)', boxShadow: 'inset 3px 0 0 var(--danger)' },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (autoFocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // The editor owns its text after mount; props.value only seeds it.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The label can change while the editor stays mounted (the block it edits moved).
  useEffect(() => {
    view.current?.dispatch({ effects: attrs.current.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: code ? 'false' : 'true' })) });
  }, [label, code]);

  // The line that does not compile stays marked until the source is rendered again.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const line = code && errorLine && errorLine >= 1 && errorLine <= v.state.doc.lines ? v.state.doc.line(errorLine) : null;
    v.dispatch({ effects: marks.current.reconfigure(line ? EditorView.decorations.of(Decoration.set([errorLineMark.range(line.from)])) : []) });
  }, [code, errorLine, value]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="se-host" />;
}

/** Live KaTeX preview of source-dialect text, with plain-language formula errors. */
export function LivePreview({ source, label = 'Preview', resolveAsset }: { source: string; label?: string; resolveAsset?: (src: string) => string | undefined }) {
  const text = useDebounced(source, 120);
  const prepared = prepareSnippet(previewSource(text));
  const errors = findMathErrors(text);
  return (
    <div className="se-preview" aria-label={label}>
      <div className="ui-meta se-preview__label">{label}</div>
      {text.trim() ? <ContentFlow content={prepared.content} formulaIndex={formulaMap(prepared.formulas)} resolveAsset={resolveAsset} /> : <p className="ui-muted">Nothing to preview yet.</p>}
      {errors.length > 0 && (
        <ul className="se-errors" role="alert">
          {errors.map((e, i) => <li key={i}><code>{e.tex}</code>: {e.message}</li>)}
        </ul>
      )}
      {/\{\{formula:@|:::formula\{key=/.test(text) && <p className="ui-muted se-note">Formula numbers are assigned when the book is compiled; the numbers here are provisional.</p>}
    </div>
  );
}
