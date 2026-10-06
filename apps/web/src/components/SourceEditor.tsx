import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
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
}

/** CodeMirror 6 on the source dialect. Ctrl/Cmd+Enter saves, Esc cancels. Tab moves focus on. */
export function SourceEditor({ value, onChange, onSave, onCancel, label, autoFocus, placeholder, minRows = 4 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave, onCancel });
  cb.current = { onChange, onSave, onCancel };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown(),
        EditorView.lineWrapping,
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'true' }),
        keymap.of([
          { key: 'Mod-Enter', run: () => { cb.current.onSave?.(); return true; } },
          { key: 'Escape', run: () => { if (!cb.current.onCancel) return false; cb.current.onCancel(); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        EditorView.theme({
          '&': { color: 'var(--text)', backgroundColor: 'var(--surface)', fontSize: '14px', border: '1px solid var(--border)', borderRadius: '8px' },
          '&.cm-focused': { outline: '2px solid var(--primary)', outlineOffset: '1px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', minHeight: `${minRows * 22}px`, maxHeight: '420px' },
          '.cm-content': { padding: '10px 12px', caretColor: 'var(--primary)' },
          '.cm-cursor': { borderLeftColor: 'var(--primary)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--marker) !important' },
          '.cm-placeholder': { color: 'var(--muted)' },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (autoFocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // The editor owns its text after mount; props.value only seeds it.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="se-host" />;
}

/** Live KaTeX preview of source-dialect text, with plain-language formula errors. */
export function LivePreview({ source, label = 'Preview' }: { source: string; label?: string }) {
  const text = useDebounced(source, 120);
  const prepared = prepareSnippet(previewSource(text));
  const errors = findMathErrors(text);
  return (
    <div className="se-preview" aria-label={label}>
      <div className="ui-meta se-preview__label">{label}</div>
      {text.trim() ? <ContentFlow content={prepared.content} formulaIndex={formulaMap(prepared.formulas)} /> : <p className="ui-muted">Nothing to preview yet.</p>}
      {errors.length > 0 && (
        <ul className="se-errors" role="alert">
          {errors.map((e, i) => <li key={i}><code>{e.tex}</code>: {e.message}</li>)}
        </ul>
      )}
      {/\{\{formula:@|:::formula\{key=/.test(text) && <p className="ui-muted se-note">Formula numbers are assigned when the book is compiled; the numbers here are provisional.</p>}
    </div>
  );
}
