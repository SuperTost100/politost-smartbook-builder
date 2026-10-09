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

/** The open editor of a block. The text belongs to the page, so a refetch can never reset it. */
export interface BlockEdit {
  text: string;
  baseText: string;
  /** Already saved while the editor stayed open: Save block then only closes it. */
  saved: boolean;
  saving: boolean;
  /** The section changed under the draft: saving waits until the author chooses how to continue. */
  blocked: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

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
  edit?: BlockEdit;
  onSelect: (index: number, note?: string) => void;
  onEdit: (index: number) => void;
  onRegenerate: (index: number) => void;
  onFocusBlock: (index: number) => void;
}

export const BlockView = memo(function BlockView(p: Props) {
  const { block, cites, issues, selected, edit } = p;
  const editing = !!edit;
  const exercises = useMemo(() => (block.kind === 'other' ? exercisesIn(block.compiled ?? block.source) : []), [block]);
  const prepared = useMemo(() => prepareSnippet(block.compiled ?? previewSource(block.source), p.chapterNumber), [block.compiled, block.source, p.chapterNumber]);
  const formulas = useMemo(() => formulaMap(prepared.formulas, p.formulaIndex), [prepared.formulas, p.formulaIndex]);

  const isHeading = block.kind === 'heading';
  const verified = cites.some((c) => c.note.verified);
  const rule = issues > 0 ? 'issue' : cites.length > 0 ? (verified ? 'cited' : 'unverified') : isHeading ? 'plain' : 'uncited';

  const label = `Block ${block.index + 1} of ${p.total}, ${BLOCK_LABEL[block.kind]}. ${cites.length ? `Cites ${cites.length} ${cites.length === 1 ? 'note' : 'notes'}${verified ? '' : ', none located'}.` : isHeading ? '' : 'No evidence cited.'} ${issues ? `${issues} open ${issues === 1 ? 'issue' : 'issues'}.` : ''}`.trim();

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || editing) return;
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
      className={`ms-block ms-block--${rule}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      data-block={block.index}
      tabIndex={p.tabbable ? 0 : -1}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      aria-keyshortcuts="Enter Space"
      onKeyDown={onKey}
      onClick={(e) => { if (editing) return; if ((e.target as HTMLElement).closest('a, .formula-hover-trigger')) return; p.onSelect(block.index); }}
    >
      <span className="ms-rule" aria-hidden="true" />
      {rule === 'issue' && <span className="ms-tick" aria-hidden="true" />}

      {edit ? (
        <BlockEditor block={block} edit={edit} />
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

function BlockEditor({ block, edit }: { block: MappedBlock; edit: BlockEdit }) {
  const { text, saving, blocked } = edit;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const empty = !text.trim();
  const unchanged = text === edit.baseText;
  const whyId = `ms-edit-why-${block.index}`;
  return (
    <div className="ms-edit" onClick={(e) => e.stopPropagation()}>
      <div className="ui-meta">Editing block {block.index + 1} · {BLOCK_LABEL[block.kind]} · source</div>
      <SourceEditor value={text} onChange={edit.onChange} onSave={() => { if (!empty) edit.onSave(); }} onCancel={edit.onCancel} label={`Source of block ${block.index + 1}`} autoFocus minRows={3} />
      <LivePreview source={text} />
      <div className="ms-edit__actions">
        <button type="button" className="ui-btn ui-btn--accent ui-btn--sm" onClick={edit.onSave} disabled={saving || empty || (unchanged && !edit.saved) || blocked} aria-describedby={blocked ? whyId : undefined}>{saving ? <><span className="ui-spinner" />Saving…</> : 'Save block'}</button>
        <button type="button" className="ui-btn ui-btn--sm" onClick={edit.onCancel}>Close</button>
        <span className="ui-muted ms-edit__keys"><kbd className="ui-kbd">Ctrl</kbd> <kbd className="ui-kbd">Enter</kbd> saves and closes, <kbd className="ui-kbd">Esc</kbd> closes. Edits save when you pause.</span>
        <span className="ui-grow" />
        {confirmDelete ? (
          <>
            <span className="ui-muted">Remove this block?</span>
            <button type="button" className="ui-btn ui-btn--danger-solid ui-btn--sm" onClick={edit.onDelete} disabled={saving || blocked}>Remove block</button>
            <button type="button" className="ui-btn ui-btn--sm" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : <button type="button" className="ui-btn ui-btn--ghost ui-btn--danger ui-btn--sm" onClick={() => setConfirmDelete(true)} disabled={blocked}><Icon name="trash" />Delete block</button>}
      </div>
      {blocked && <p id={whyId} className="ui-muted">Saving is paused: the section changed while you were editing. Choose how to continue in the notice above the text.</p>}
    </div>
  );
}
