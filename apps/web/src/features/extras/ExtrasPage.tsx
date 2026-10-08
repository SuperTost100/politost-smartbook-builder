import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset, Enrichment, QuestionCheck } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk, useManuscript } from '../../lib/queries';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import './extras.css';

type Tab = 'figures' | 'ide' | 'graphs';
const ORIGIN_LABEL: Record<Asset['origin'], string> = { plot: 'plot', 'generated-svg': 'generated', imported: 'imported' };

export default function ExtrasPage() {
  useDocumentTitle('Extras');
  const pid = useBookId();
  const [params, setParams] = useSearchParams();
  const tab = (['figures', 'ide', 'graphs'].includes(params.get('tab') ?? '') ? params.get('tab') : 'figures') as Tab;
  const assets = useQuery({ queryKey: qk.assets(pid), queryFn: () => api('GET /api/projects/:id/assets', { params: { id: pid } }) });
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
        {([['figures', `Figures (${assets.data?.length ?? 0})`], ['ide', `IDE examples (${ide.length})`], ['graphs', `Graphs (${graphs.length})`]] as const).map(([t, l]) => (
          <button key={t} type="button" role="tab" className="ui-tab" aria-selected={tab === t} onClick={() => setParams({ tab: t }, { replace: true })}>{l}</button>
        ))}
      </div>
      {tab === 'figures' && <Figures pid={pid} assets={assets.data ?? []} loading={assets.isLoading} error={assets.error} />}
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

function Figures({ pid, assets, loading, error }: { pid: string; assets: Asset[]; loading: boolean; error: unknown }) {
  const qc = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const manuscript = useManuscript(pid);
  const sections = (manuscript.data ?? []).flatMap((c) => c.sections.map((s) => ({ id: s.sectionId, label: `${c.number}. ${s.title}` })));
  const imp = useMutation({
    mutationFn: (f: File) => { const form = new FormData(); form.set('file', f, f.name); return api('POST /api/projects/:id/assets', { params: { id: pid }, form }); },
    onSuccess: () => { toast('Figure imported'); void qc.invalidateQueries({ queryKey: qk.assets(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  return (
    <div className="ui-stack">
      <div className="ui-row">
        <input ref={file} type="file" accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg" className="ui-sr" tabIndex={-1} aria-label="Choose a figure file" onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ''; }} />
        <button type="button" className="ui-btn" onClick={() => file.current?.click()} disabled={imp.isPending}><Icon name="upload" />Import file</button>
        <span className="ui-muted">SVG, PNG or JPEG. The file is copied into the book's assets.</span>
      </div>
      {loading && <div className="ui-skeleton" style={{ height: 160 }} />}
      {!!error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(error)}</div>}
      {!loading && assets.length === 0 && <div className="ui-empty"><p className="ui-empty__text">No figures yet. Drafting adds plots and diagrams where the text needs them, or import your own.</p></div>}
      <ul className="ex-grid">{assets.map((a) => <li key={a.id}><FigureCard a={a} sections={sections} /></li>)}</ul>
    </div>
  );
}

function FigureCard({ a, sections }: { a: Asset; sections: { id: string; label: string }[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [caption, setCaption] = useState(a.caption);
  const [alt, setAlt] = useState(a.alt);
  const [nodeId, setNodeId] = useState(a.nodeId ?? '');
  const dirty = caption !== a.caption || alt !== a.alt || nodeId !== (a.nodeId ?? '');
  const save = useMutation({
    mutationFn: () => api('PATCH /api/assets/:assetId', { params: { assetId: a.id }, body: { caption, alt, nodeId: nodeId || null } }),
    onSuccess: () => { toast('Figure saved'); void qc.invalidateQueries({ queryKey: qk.assets(a.projectId) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  return (
    <article className="ex-card ui-card">
      <div className="ex-fig"><img src={apiUrl('GET /api/assets/:assetId/file', { params: { assetId: a.id } })} alt={a.alt || a.filename} loading="lazy" /></div>
      <div className="ex-card__body">
        <div className="ui-row"><span className="ui-mono ui-wrap ex-fname">{a.filename}</span><span className="ui-badge">{ORIGIN_LABEL[a.origin]}</span></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor={`cap-${a.id}`}>Caption</label><input id={`cap-${a.id}`} className="ui-input ui-input--sm" value={caption} onChange={(e) => setCaption(e.target.value)} /></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor={`alt-${a.id}`}>Alt text</label><input id={`alt-${a.id}`} className="ui-input ui-input--sm" value={alt} onChange={(e) => setAlt(e.target.value)} /></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor={`sec-${a.id}`}>Section</label>
          <select id={`sec-${a.id}`} className="ui-select ui-select--sm" value={nodeId} onChange={(e) => setNodeId(e.target.value)}><option value="">Not placed</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <Checks checks={a.checks} />
        <div><button type="button" className="ui-btn ui-btn--sm ui-btn--accent" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save figure</button></div>
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
