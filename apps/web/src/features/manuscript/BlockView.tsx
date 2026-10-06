import { memo, useMemo, useState } from 'react';
import type { FormulaRef } from '@politost/content-core';
import type { EvidenceNote } from '@smartbuilder/domain';
import { SourceEditor, LivePreview } from '../../components/SourceEditor';
import { ContentFlow } from '../../reader/ContentFlow';
import { ExerciseCard } from '../../reader/ExerciseCard';
import { exercisesIn, formulaMap, prepareSnippet, previewSource } from '../../reader/render';
import { BLOCK_LABEL, type MappedBlock } from '../../lib/blocks';
import { CiteMark } from '../../components/CiteMark';
import { Icon } from '../../components/Icon';

export interface Cite { n: number; note: EvidenceNote }

interface Props {
  block: MappedBlock;
  total: number;
  chapterNumber: number;
  formulaIndex: Map<string, FormulaRef>;
  resolveAsset?: (src: string) => string | undefined;
  cites: Cite[];
  issues: number;
  selected: boolean;
  tabbable: boolean;
  editing: boolean;
  saving: boolean;
  onSelect: (index: number, note?: string) => void;
  onEdit: (index: number) => void;
  onRegenerate: (index: number) => void;
  onSave: (index: number, text: string) => void;
  onDelete: (index: number) => void;
  onCancel: () => void;
  onFocusBlock: (index: number) => void;
}

export const BlockView = memo(function BlockView(p: Props) {
  const { block, cites, issues, selected } = p;
  const exercises = useMemo(() => (block.kind === 'other' ? exercisesIn(block.compiled ?? block.source) : []), [block]);
  const prepared = useMemo(() => prepareSnippet(block.compiled ?? previewSource(block.source), p.chapterNumber), [block.compiled, block.source, p.chapterNumber]);
  const formulas = useMemo(() => formulaMap(prepared.formulas, p.formulaIndex), [prepared.formulas, p.formulaIndex]);

  const isHeading = block.kind === 'heading';
  const verified = cites.some((c) => c.note.verified);
  const rule = issues > 0 ? 'issue' : cites.length > 0 ? (verified ? 'cited' : 'unverified') : isHeading ? 'plain' : 'uncited';

  const label = `Block ${block.index + 1} of ${p.total}, ${BLOCK_LABEL[block.kind]}. ${cites.length ? `Cites ${cites.length} ${cites.length === 1 ? 'note' : 'notes'}${verified ? '' : ', none located'}.` : isHeading ? '' : 'No evidence cited.'} ${issues ? `${issues} open ${issues === 1 ? 'issue' : 'issues'}.` : ''}`.trim();

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || p.editing) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); p.onFocusBlock(block.index + 1); break;
      case 'ArrowUp': e.preventDefault(); p.onFocusBlock(block.index - 1); break;
      case 'Home': e.preventDefault(); p.onFocusBlock(0); break;
      case 'End': e.preventDefault(); p.onFocusBlock(p.total - 1); break;
      case 'Enter': e.preventDefault(); p.onEdit(block.index); break;
      case ' ': e.preventDefault(); p.onSelect(block.index); break;
    }
  };

  return (
    <div
      role="listitem"
      className={`ms-block ms-block--${rule}${selected ? ' is-selected' : ''}${p.editing ? ' is-editing' : ''}`}
      data-block={block.index}
      tabIndex={p.tabbable ? 0 : -1}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      aria-keyshortcuts="Enter Space"
      onKeyDown={onKey}
      onClick={(e) => { if (p.editing) return; if ((e.target as HTMLElement).closest('a, .formula-hover-trigger')) return; p.onSelect(block.index); }}
    >
      <span className="ms-rule" aria-hidden="true" />
      {rule === 'issue' && <span className="ms-tick" aria-hidden="true" />}

      {p.editing ? (
        <BlockEditor block={block} saving={p.saving} onSave={(t) => p.onSave(block.index, t)} onCancel={p.onCancel} onDelete={() => p.onDelete(block.index)} />
      ) : (
        <>
          <div className="ms-content">
            {exercises.length > 0 ? exercises.map((ex, i) => <ExerciseCard key={i} ex={ex} resolveAsset={p.resolveAsset} />) : block.kind === 'other' && !prepared.content.trim() ? <pre className="ui-pre">{block.source}</pre> : <ContentFlow content={prepared.content} formulaIndex={formulas} resolveAsset={p.resolveAsset} />}
          </div>
          {cites.length > 0 && (
            <div className="ms-chips">
              {cites.map((c) => (
                <button key={c.note.id} type="button" className={`ms-chip${c.note.verified ? '' : ' is-unverified'}`} aria-label={`Evidence note ${c.n}, ${c.note.verified ? 'verified' : 'not located'}`} onClick={(e) => { e.stopPropagation(); p.onSelect(block.index, c.note.id); }}>
                  <CiteMark n={c.n} />
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div className="ms-actions" role="group" aria-label={`Actions for block ${block.index + 1}`}>
              <button type="button" className="ui-btn ui-btn--sm" onClick={(e) => { e.stopPropagation(); p.onEdit(block.index); }}><Icon name="edit" />Edit</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={(e) => { e.stopPropagation(); p.onRegenerate(block.index); }}><Icon name="sparkle" />Regenerate selection</button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

function BlockEditor({ block, saving, onSave, onCancel, onDelete }: { block: MappedBlock; saving: boolean; onSave: (t: string) => void; onCancel: () => void; onDelete: () => void }) {
  const [text, setText] = useState(block.source);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const empty = !text.trim();
  const unchanged = text === block.source;
  return (
    <div className="ms-edit" onClick={(e) => e.stopPropagation()}>
      <div className="ui-meta">Editing block {block.index + 1} · {BLOCK_LABEL[block.kind]} · source</div>
      <SourceEditor value={text} onChange={setText} onSave={() => { if (!empty) onSave(text); }} onCancel={onCancel} label={`Source of block ${block.index + 1}`} autoFocus minRows={3} />
      <LivePreview source={text} />
      <div className="ms-edit__actions">
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => onSave(text)} disabled={saving || empty || unchanged}>{saving ? <><span className="ui-spinner" />Saving…</> : 'Save block'}</button>
        <button type="button" className="ui-btn ui-btn--sm" onClick={onCancel}>Cancel</button>
        <span className="ui-muted ms-edit__keys"><kbd className="ui-kbd">Ctrl</kbd> <kbd className="ui-kbd">Enter</kbd> saves, <kbd className="ui-kbd">Esc</kbd> cancels</span>
        <span className="ui-grow" />
        {confirmDelete ? (
          <>
            <span className="ui-muted">Remove this block?</span>
            <button type="button" className="ui-btn ui-btn--danger-solid ui-btn--sm" onClick={onDelete} disabled={saving}>Remove block</button>
            <button type="button" className="ui-btn ui-btn--sm" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : <button type="button" className="ui-btn ui-btn--ghost ui-btn--danger ui-btn--sm" onClick={() => setConfirmDelete(true)}><Icon name="trash" />Delete block</button>}
      </div>
    </div>
  );
}
