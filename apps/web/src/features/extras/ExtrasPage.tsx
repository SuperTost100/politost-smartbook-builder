import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { Asset, ChapterView, Enrichment, QuestionCheck } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { figureNumber, imageFilename, mapSection } from '../../lib/blocks';
import { qk, useManuscript } from '../../lib/queries';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import './extras.css';

type Tab = 'figures' | 'ide' | 'graphs';
const ORIGIN_LABEL: Record<Asset['origin'], string> = { plot: 'plot', structure: 'structure', diagram: 'diagram', stock: 'photo', 'generated-svg': 'generated', imported: 'imported' };

export default function ExtrasPage() {
  useDocumentTitle('Extras');
  const pid = useBookId();
  const [params, setParams] = useSearchParams();
  const tab = (['figures', 'ide', 'graphs'].includes(params.get('tab') ?? '') ? params.get('tab') : 'figures') as Tab;
  const assets = useQuery({ queryKey: qk.assets(pid), queryFn: () => api('GET /api/projects/:id/assets', { params: { id: pid } }) });
  const manuscript = useManuscript(pid);
  const placed = useMemo(() => placedFigures(manuscript.data ?? [], assets.data ?? []), [manuscript.data, assets.data]);
  const enr = useQuery({ queryKey: qk.enrichments(pid), queryFn: () => api('GET /api/projects/:id/enrichments', { params: { id: pid } }) });
  const ide = (enr.data ?? []).filter((e) => e.kind === 'ide');
  const graphs = (enr.data ?? []).filter((e) => e.kind === 'graph');

  return (
    <div className="ui-page ui-page--wide">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Extras</h1>
          <p className="ui-lede">Figures, runnable code examples and graphs that go with the text.</p>
        </div>
      </div>
      <div className="ui-tabs" role="tablist" aria-label="Extras">
        {([['figures', `Figures (${placed.length})`], ['ide', `IDE examples (${ide.length})`], ['graphs', `Graphs (${graphs.length})`]] as const).map(([t, l]) => (
          <button key={t} type="button" role="tab" className="ui-tab" aria-selected={tab === t} onClick={() => setParams({ tab: t }, { replace: true })}>{l}</button>
        ))}
      </div>
      {tab === 'figures' && <Figures pid={pid} placed={placed} loading={assets.isLoading || manuscript.isLoading} error={assets.error ?? manuscript.error} />}
      {tab === 'ide' && <EnrichmentList pid={pid} items={ide} loading={enr.isLoading} error={enr.error} kind="ide" />}
      {tab === 'graphs' && <EnrichmentList pid={pid} items={graphs} loading={enr.isLoading} error={enr.error} kind="graph" />}
    </div>
  );
}

function Checks({ checks }: { checks: QuestionCheck[] }) {
  if (checks.length === 0) return <p className="ui-muted ex-nocheck">No checks have run.</p>;
  return (
    <ul className="ex-checks">
      {checks.map((c, i) => (
        <li key={i} className={c.ok ? 'is-ok' : 'is-bad'}><Icon name={c.ok ? 'check' : 'x'} size={13} /><span><strong>{c.method}</strong>: {c.detail}</span></li>
      ))}
    </ul>
  );
}

interface Placed { key: string; asset: Asset; nodeId: string; where: string; number: string | null }

/** The figures the current text of the book shows, one entry for each image block. An older copy of a figure, or one no text uses, is not a figure of the book. */
function placedFigures(chapters: ChapterView[], assets: Asset[]): Placed[] {
  const byFile = new Map(assets.map((a) => [a.filename, a]));
  const out: Placed[] = [];
  const add = (nodeId: string, where: string, source: string, compiled: string | null, at: number) => {
    const asset = byFile.get(imageFilename(source) ?? '');
    if (asset) out.push({ key: `${nodeId}:${at}`, asset, nodeId, where, number: figureNumber(compiled) });
  };
  for (const c of chapters) {
    splitBlocks(c.intro?.markdown ?? '').forEach((b, i) => { if (b.kind === 'image') add(c.chapterId, `${c.number}. ${c.title}, introduction`, b.text, null, i); });
    for (const s of c.sections) for (const b of mapSection(s).blocks) if (b.kind === 'image') add(s.sectionId, `${c.number}. ${s.title}`, b.source, b.compiled, b.index);
  }
  return out;
}

function Figures({ pid, placed, loading, error }: { pid: string; placed: Placed[]; loading: boolean; error: unknown }) {
  return (
    <div className="ui-stack">
      <p className="ui-muted">The figures the text of the book shows now. To change one, open it in the Manuscript: every change there is a version of the section, so History and Restore keep working.</p>
      {loading && <div className="ui-skeleton" style={{ height: 160 }} />}
      {!!error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(error)}</div>}
      {!loading && !error && placed.length === 0 && <div className="ui-empty"><p className="ui-empty__text">No figures in the text yet. Drafting adds plots and diagrams where the text needs them, and Add figure in the Manuscript adds your own.</p></div>}
      <ul className="ex-grid">{placed.map((f) => <li key={f.key}><FigureCard pid={pid} f={f} /></li>)}</ul>
    </div>
  );
}

function FigureCard({ pid, f }: { pid: string; f: Placed }) {
  const a = f.asset;
  return (
    <article className="ex-card ui-card">
      <div className="sb-figure-frame ex-fig"><img src={apiUrl('GET /api/assets/:assetId/file', { params: { assetId: a.id } })} alt={a.alt || a.filename} loading="lazy" /></div>
      <div className="ex-card__body">
        <div className="ui-row"><span className="ex-where ui-wrap">{f.number ? `Fig. ${f.number}` : 'No number'} in {f.where}</span><span className="ui-badge">{ORIGIN_LABEL[a.origin]}</span></div>
        <p className={`ex-caption${a.caption.trim() ? '' : ' ui-muted'}`}>{a.caption.trim() || 'No caption'}</p>
        <span className="ui-mono ui-wrap ex-fname">{a.filename}</span>
        <Checks checks={a.checks} />
        <div><Link className="ui-btn ui-btn--sm" to={`/books/${pid}/manuscript/${f.nodeId}?figure=${encodeURIComponent(a.filename)}`}>Edit in the Manuscript</Link></div>
      </div>
    </article>
  );
}

function EnrichmentList({ pid, items, loading, error, kind }: { pid: string; items: Enrichment[]; loading: boolean; error: unknown; kind: 'ide' | 'graph' }) {
  return (
    <div className="ui-stack">
      {loading && <div className="ui-skeleton" style={{ height: 160 }} />}
      {!!error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(error)}</div>}
      {!loading && items.length === 0 && <div className="ui-empty"><p className="ui-empty__text">{kind === 'ide' ? 'No code examples yet. Turn them on in Book setup and drafting adds runnable examples to the sections that need them.' : 'No graphs yet. Turn them on in Book setup and drafting adds function plots where they help.'}</p></div>}
      <ul className="ex-list">{items.map((e) => <li key={e.id}><EnrichmentCard e={e} pid={pid} /></li>)}</ul>
    </div>
  );
}

function EnrichmentCard({ e, pid }: { e: Enrichment; pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(JSON.stringify(e.payload, null, 2));
  const [confirm, setConfirm] = useState(false);
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try { const v = JSON.parse(text) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>; else parseError = 'The payload must be a JSON object.'; } catch (err) { parseError = (err as Error).message; }
  const dirty = text !== JSON.stringify(e.payload, null, 2);
  const save = useMutation({
    mutationFn: () => api('PATCH /api/enrichments/:eid', { params: { eid: e.id }, body: { payload: parsed! } }),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: qk.enrichments(pid) }); },
    onError: (er) => toast(errorText(er), { tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE /api/enrichments/:eid', { params: { eid: e.id } }),
    onSuccess: () => { toast('Deleted'); setConfirm(false); void qc.invalidateQueries({ queryKey: qk.enrichments(pid) }); },
    onError: (er) => toast(errorText(er), { tone: 'danger' }),
  });
  const title = typeof e.payload.title === 'string' ? e.payload.title : e.id.slice(0, 8);
  const language = typeof e.payload.language === 'string' ? e.payload.language : null;
  const code = typeof e.payload.code === 'string' ? e.payload.code : null;
  const type = typeof e.payload.type === 'string' ? e.payload.type : null;
  return (
    <article className="ex-enr ui-card">
      <header className="ex-enr__head">
        <h3 className="ui-panel-title ui-wrap">{title}</h3>
        {language && <span className="ui-badge ui-badge--mono">{language}</span>}
        {type && <span className="ui-badge ui-badge--mono">{type}</span>}
        <span className={`ui-badge ui-badge--${e.status === 'verified' ? 'success' : e.status === 'issue' ? 'danger' : 'neutral'}`}>{e.status}</span>
      </header>
      <div className="ex-enr__cols">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`json-${e.id}`}>{e.kind === 'ide' ? 'Example (JSON)' : 'Graph payload (JSON)'}</label>
          <textarea id={`json-${e.id}`} className="ui-textarea ui-textarea--mono ex-json" rows={Math.min(18, Math.max(6, text.split('\n').length))} spellCheck={false} value={text} onChange={(ev) => setText(ev.target.value)} aria-invalid={!!parseError} />
          {parseError && <span className="ex-bad" role="alert">{parseError}</span>}
        </div>
        <div className="ui-stack">
          {e.kind === 'ide' && code && (<div><div className="ui-meta">Code preview</div><pre className="ui-pre ex-code">{code}</pre></div>)}
          {e.kind === 'graph' && <p className="ui-muted">Graphs are evaluated when the book is checked and drawn in the reader. Figures of origin plot appear on the Figures tab.</p>}
          <div><div className="ui-meta">Check results</div><Checks checks={e.checks} /></div>
        </div>
      </div>
      <div className="ui-row">
        <button type="button" className="ui-btn ui-btn--sm ui-btn--accent" disabled={!dirty || !!parseError || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button type="button" className="ui-btn ui-btn--sm" disabled={!dirty} onClick={() => setText(JSON.stringify(e.payload, null, 2))}>Revert</button>
        <span className="ui-grow" />
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost ui-btn--danger" onClick={() => setConfirm(true)}><Icon name="trash" />Delete</button>
      </div>
      <ConfirmDialog open={confirm} title={`Delete ${e.kind === 'ide' ? 'example' : 'graph'}`} message="It is removed from the book and cannot be restored." confirmLabel="Delete" danger busy={remove.isPending} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} />
    </article>
  );
}
