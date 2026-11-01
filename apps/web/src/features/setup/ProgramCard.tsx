import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExamFormat, ProgramItem } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useProgram, useProject, useRun } from '../../lib/queries';
import { newId, plural, runCounts, slugify, timeAgo } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';

/** An item in the editor. New rows have no key until they are saved. */
type Row = ProgramItem & { rid: string };

const DEFAULT_EXAM: ExamFormat = { written: true, oral: false, proofs: 'some', summary: '' };
const PROOFS: { value: ExamFormat['proofs']; label: string }[] = [
  { value: 'required', label: 'Proofs are asked' },
  { value: 'some', label: 'Only the listed ones' },
  { value: 'none', label: 'No proofs' },
];

const toRows = (items: ProgramItem[]): Row[] => items.map((i) => ({ ...i, rid: i.key }));

const cleanProofs = (proofs: string[]) => proofs.map((l) => l.trim()).filter(Boolean);

/**
 * The items as the service stores them: existing keys are kept, new rows get a kebab-case key from the title that no other
 * row uses and no saved item used, so a row added after removing an item never takes over the removed item's key.
 */
function withKeys(rows: Row[], saved: ProgramItem[]): ProgramItem[] {
  const taken = new Set([...rows.filter((r) => r.key).map((r) => r.key), ...saved.map((i) => i.key)]);
  return rows.map(({ rid: _rid, ...item }) => {
    const clean = { ...item, title: item.title.trim(), proofs: cleanProofs(item.proofs) };
    if (clean.key) return clean;
    const base = slugify(clean.title).slice(0, 70) || 'item';
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return { ...clean, key };
  });
}

// Fixed field order, so the comparison does not depend on how the service orders its JSON.
const norm = (i: ProgramItem) => ({ key: i.key, title: i.title.trim(), details: i.details, proofs: cleanProofs(i.proofs) });
const normExam = (e: ExamFormat) => ({ written: e.written, oral: e.oral, proofs: e.proofs, summary: e.summary });

const validUrl = (v: string) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } };

export function ProgramCard({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const programQ = useProgram(pid);
  const project = useProject(pid);
  const program = programQ.data ?? null;

  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [exam, setExam] = useState<ExamFormat>(DEFAULT_EXAM);
  const [synced, setSynced] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [confirmRead, setConfirmRead] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const parsing = program?.status === 'parsing';
  const showItems = !!program && !parsing && (program.status === 'ready' || program.items.length > 0);
  const items = withKeys(rows, program?.items ?? []);
  const dirty = !!program && (JSON.stringify(rows.map(norm)) !== JSON.stringify(program.items.map(norm)) || JSON.stringify(normExam(exam)) !== JSON.stringify(normExam(program.examFormat)));
  const textDirty = !!program && (text !== program.text || (url.trim() || null) !== program.url);

  // Adopt what the service saved, unless the author has unsaved edits (or just asked for a fresh reading).
  useEffect(() => {
    if (!program || parsing) return;
    if (synced === null) { setText(program.text); setUrl(program.url ?? ''); }
    if (program.updatedAt === synced) return;
    if (synced !== null && dirty && !force) return;
    setRows(toRows(program.items));
    setExam(program.examFormat);
    setText(program.text);
    setUrl(program.url ?? '');
    setSynced(program.updatedAt);
    setForce(false);
  }, [program, parsing, synced, dirty, force]);

  const run = project.data?.activeRun;
  const programRun = run && run.kind === 'program' && !['completed', 'failed', 'cancelled'].includes(run.status) ? run : null;
  const runDetail = useRun(programRun?.id);
  const taskNow = (runDetail.data?.tasks ?? []).find((t) => t.state === 'running')?.label;
  const counts = programRun ? runCounts(programRun) : null;

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.program(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); void qc.invalidateQueries({ queryKey: qk.runs(pid) }); };

  const read = useMutation({
    mutationFn: () => api('PUT /api/projects/:id/program', { params: { id: pid }, body: { text, url: url.trim() || null } }),
    onSuccess: (r) => {
      qc.setQueryData(qk.program(pid), r.program);
      setForce(true);
      toast('Reading the course program', { action: { label: 'Open run', to: `/books/${pid}/run` } });
      refresh();
    },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const save = useMutation({
    mutationFn: () => api('PUT /api/projects/:id/program/items', { params: { id: pid }, body: { items, examFormat: exam } }),
    onSuccess: (p) => {
      qc.setQueryData(qk.program(pid), p);
      setRows(toRows(p.items)); setExam(p.examFormat); setSynced(p.updatedAt);
      toast('Course program saved');
      refresh();
    },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const remove = useMutation({
    mutationFn: () => api('DELETE /api/projects/:id/program', { params: { id: pid } }),
    onSuccess: () => {
      qc.setQueryData(qk.program(pid), null);
      setRows([]); setExam(DEFAULT_EXAM); setText(''); setUrl(''); setSynced(null); setForce(false); setConfirmRemove(false);
      toast('Course program removed');
      refresh();
    },
    onError: (e) => { setConfirmRemove(false); toast(errorText(e), { tone: 'danger' }); },
  });

  const urlBad = url.trim() !== '' && !validUrl(url.trim());
  const nothingToRead = !text.trim() && !url.trim();
  const readDisabled = nothingToRead || urlBad || read.isPending || parsing;
  const startRead = () => { if (rows.length > 0) setConfirmRead(true); else read.mutate(); };

  const missingTitle = rows.some((r) => !r.title.trim());
  const saveDisabled = !dirty || missingTitle || save.isPending || parsing;

  const setRow = (rid: string, patch: Partial<ProgramItem>) => setRows((l) => l.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));

  // The card sits inside the book form: Enter in a field must not submit the whole setup.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (e.target.id === 'pg-url' && !readDisabled) startRead();
    }
  };

  return (
    <section className="ui-card ui-card--pad su-section pg-card" aria-labelledby="su-program" onKeyDown={onKeyDown}>
      <div className="pg-head">
        <div>
          <h2 id="su-program" className="ui-panel-title">Course program</h2>
          <p className="ui-field__hint">Paste the program from the PoliTo course guide, or give its address. The builder reads it into the list of topics the exam can ask, and the outline follows that list.</p>
        </div>
        {program && (
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--danger" onClick={() => setConfirmRemove(true)} disabled={parsing}><Icon name="trash" />Remove program</button>
        )}
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor="pg-text">Program text</label>
        <textarea id="pg-text" className="ui-textarea pg-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Programma\n1. Successioni e serie numeriche …\n\nModalità d’esame\nProva scritta di 2 ore, orale facoltativo …'} />
        <span className="ui-field__hint">Include the exam rules ("Modalità d’esame") when the guide has them. They set how much weight proofs get.</span>
      </div>
      <div className="ui-field">
        <label className="ui-field__label" htmlFor="pg-url">Course guide address</label>
        <input id="pg-url" className="ui-input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://didattica.polito.it/pls/portal30/gap.pkg_guide.viewGap?…" aria-invalid={urlBad} aria-describedby="pg-url-hint" />
        <span id="pg-url-hint" className={`ui-field__hint${urlBad ? ' su-bad' : ''}`}>{urlBad ? 'Use a full address that starts with https://.' : 'Optional. The page is read together with the text above.'}</span>
      </div>

      <div className="ui-row">
        <button type="button" className="ui-btn ui-btn--accent" onClick={startRead} disabled={readDisabled}>
          {parsing ? <><span className="ui-spinner" />Reading…</> : program && program.items.length ? 'Read again' : 'Read program'}
        </button>
        {program?.parsedAt && !parsing && <span className="ui-muted pg-when">Last read {timeAgo(program.parsedAt)}{textDirty ? ', before your changes to the text' : ''}</span>}
      </div>

      {parsing && (
        <div className="ui-banner ui-banner--info" role="status">
          <span className="ui-spinner pg-spin" aria-hidden="true" />
          <div className="ui-banner__body">
            <span className="ui-banner__title">Reading the program</span>
            <span>{taskNow ? `${taskNow}. ` : ''}{counts && counts.total ? `${counts.done} of ${plural(counts.total, 'step')} done. ` : ''}The list appears here when it is ready. <Link className="ui-btn ui-btn--link" to={`/books/${pid}/run`}>Open run</Link></span>
          </div>
        </div>
      )}
      {program?.status === 'failed' && (
        <div className="ui-banner ui-banner--danger" role="alert">
          <Icon name="alert" size={16} />
          <div className="ui-banner__body">
            <span className="ui-banner__title">The program could not be read</span>
            <span>{program.error ?? 'The service gave no reason.'} Check the text or the address and read it again.</span>
          </div>
        </div>
      )}
      {programQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(programQ.error)}</div>}

      {showItems && (
        <>
          <hr className="pg-rule" />
          <div className="pg-items-head">
            <h3 className="pg-sub">Program items <span className="ui-muted">({rows.length})</span></h3>
            <p className="ui-field__hint">The outline gives every item a section, or leaves it out with a reason. Keep the program’s own wording in the details.</p>
          </div>
          {rows.length === 0 && <p className="ui-muted">No items were found. Add them by hand or change the text and read it again.</p>}
          <ol className="pg-items">
            {rows.map((r, k) => (
              <li key={r.rid} className="pg-item">
                <div className="pg-item__top">
                  <span className="pg-num ui-mono">{k + 1}</span>
                  <input className="ui-input pg-item__title" aria-label={`Title of item ${k + 1}`} value={r.title} onChange={(e) => setRow(r.rid, { title: e.target.value })} aria-invalid={!r.title.trim()} placeholder="Title" />
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm ui-btn--danger" aria-label={`Remove item ${k + 1}`} onClick={() => setRows((l) => l.filter((x) => x.rid !== r.rid))}><Icon name="trash" /></button>
                </div>
                <div className="pg-item__body">
                  <div className="ui-field">
                    <label className="ui-field__label pg-small" htmlFor={`pg-d-${r.rid}`}>Details</label>
                    <textarea id={`pg-d-${r.rid}`} className="ui-textarea pg-lines" rows={2} value={r.details} onChange={(e) => setRow(r.rid, { details: e.target.value })} />
                  </div>
                  <div className="ui-field">
                    <label className="ui-field__label pg-small" htmlFor={`pg-p-${r.rid}`}>Proofs asked</label>
                    <textarea
                      id={`pg-p-${r.rid}`} className="ui-textarea pg-lines" rows={2} value={r.proofs.join('\n')}
                      onChange={(e) => setRow(r.rid, { proofs: e.target.value.split('\n') })}
                      onBlur={(e) => setRow(r.rid, { proofs: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })}
                    />
                    <span className="ui-field__hint">One theorem per line. Leave empty when no proof is asked.</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="ui-btn ui-btn--sm pg-add" onClick={() => setRows((l) => [...l, { rid: newId('pi'), key: '', title: '', details: '', proofs: [] }])}><Icon name="plus" />Add item</button>

          <hr className="pg-rule" />
          <h3 className="pg-sub">Exam format</h3>
          <fieldset className="su-fieldset">
            <legend className="ui-field__label">Parts</legend>
            <div className="ui-row">
              <label className="ui-check"><input type="checkbox" checked={exam.written} onChange={(e) => setExam({ ...exam, written: e.target.checked })} />Written</label>
              <label className="ui-check"><input type="checkbox" checked={exam.oral} onChange={(e) => setExam({ ...exam, oral: e.target.checked })} />Oral</label>
            </div>
          </fieldset>
          <fieldset className="su-fieldset">
            <legend className="ui-field__label">Proofs at the exam</legend>
            <div className="ui-row" role="radiogroup" aria-label="Proofs at the exam">
              {PROOFS.map((p) => (
                <label key={p.value} className="ui-check"><input type="radio" name="pg-proofs" checked={exam.proofs === p.value} onChange={() => setExam({ ...exam, proofs: p.value })} />{p.label}</label>
              ))}
            </div>
            <p className="ui-field__hint">With proofs asked, sections give the complete proof and mark it. With none, the weight goes to methods and worked exercises.</p>
          </fieldset>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="pg-summary">Summary</label>
            <textarea id="pg-summary" className="ui-textarea" rows={3} value={exam.summary} onChange={(e) => setExam({ ...exam, summary: e.target.value })} placeholder="Parts, length, what is allowed, how it is graded" />
          </div>

          <div className="ui-row">
            <button type="button" className="ui-btn ui-btn--accent" onClick={() => save.mutate()} disabled={saveDisabled}>Save program</button>
            {missingTitle ? <span className="ui-muted pg-when">Every item needs a title.</span> : dirty ? <span className="ui-muted pg-when">Unsaved changes.</span> : <span className="ui-muted pg-when">Saved.</span>}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmRead}
        title="Read the program again"
        message="The list and the exam format below are replaced by a fresh reading, including edits you saved. Items whose title stays the same keep their key, so sections that use them stay linked."
        confirmLabel="Read again"
        onClose={() => setConfirmRead(false)}
        onConfirm={() => { setConfirmRead(false); read.mutate(); }}
      />
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the course program"
        message="The book goes back to planning from the sources alone. Sections keep their text. The links between sections and program items are dropped the next time you save the outline."
        confirmLabel="Remove program"
        danger
        busy={remove.isPending}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}
