import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page, Resource } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk } from '../../lib/queries';
import { Icon } from '../../components/Icon';
import { VirtualList } from '../../components/VirtualList';
import { useToast } from '../../components/Toast';
import { ContentFlow } from '../../reader/ContentFlow';
import { formulaMap, prepareSnippet } from '../../reader/render';

type PageRow = { id: string; idx: number; label: string; quality: Page['quality'] };
const QUALITY: Record<Page['quality'], { label: string; tone: string }> = {
  good: { label: 'Text ok', tone: 'success' },
  garbled: { label: 'Needs reading', tone: 'warning' },
  empty: { label: 'No text', tone: 'warning' },
};

export function Inspector({ projectId, resource, onClose }: { projectId: string; resource: Resource; onClose: () => void }) {
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') === 'reading' ? 'reading' : 'all';
  const pages = useQuery({ queryKey: qk.pages(resource.id), queryFn: () => api('GET /api/resources/:rid/pages', { params: { rid: resource.id } }), enabled: resource.status === 'ready' });
  const index = useQuery({ queryKey: qk.sourceIndex(resource.id), queryFn: () => api('GET /api/resources/:rid/index', { params: { rid: resource.id } }), enabled: resource.status === 'ready' });
  const [sel, setSel] = useState(0);
  const qc = useQueryClient();
  const toast = useToast();

  const rows: PageRow[] = useMemo(() => {
    const all = pages.data ?? [];
    return filter === 'reading' ? all.filter((p) => p.quality !== 'good') : all;
  }, [pages.data, filter]);
  const current = rows[Math.min(sel, Math.max(0, rows.length - 1))];

  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const transcribeAll = async () => {
    const todo = (pages.data ?? []).filter((p) => p.quality !== 'good');
    setBatch({ done: 0, total: todo.length });
    let failed = 0;
    for (const [i, p] of todo.entries()) {
      try {
        const page = await api('POST /api/resources/:rid/pages/:idx/transcribe', { params: { rid: resource.id, idx: p.idx } });
        qc.setQueryData(qk.page(resource.id, p.idx), page);
      } catch (e) {
        failed++;
        if (failed === 1) toast(errorText(e), { tone: 'danger' });
        if (failed >= 3) break;
      }
      setBatch({ done: i + 1, total: todo.length });
    }
    setBatch(null);
    void qc.invalidateQueries({ queryKey: ['resources'] });
    toast(failed ? 'Some pages could not be read' : 'Pages read', { tone: failed ? 'danger' : 'default' });
  };

  const jumpTo = (pageIdx: number) => {
    if (filter !== 'all') setParams({}, { replace: true });
    setSel(Math.max(0, Math.min((pages.data?.length ?? 1) - 1, pageIdx)));
  };

  const needing = (pages.data ?? []).filter((p) => p.quality !== 'good').length;

  return (
    <section className="so-inspector ui-card" aria-label={`Inspector for ${resource.filename}`}>
      <header className="so-insp__head">
        <div className="ui-grow">
          <div className="ui-meta">Source inspector</div>
          <h2 className="ui-panel-title ui-wrap">{resource.filename}</h2>
        </div>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label="Close inspector" onClick={onClose}><Icon name="x" /></button>
      </header>

      {resource.status !== 'ready' && (
        <div className={`ui-banner ${resource.status === 'failed' ? 'ui-banner--danger' : 'ui-banner--info'}`}>
          {resource.status === 'failed' ? (resource.error ?? 'This file could not be read.') : 'The file is still being read. Pages appear here when it finishes.'}
        </div>
      )}

      {resource.status === 'ready' && (
        <>
          {index.data && index.data.entries.length > 0 && (
            <details className="so-index">
              <summary>
                Source index <span className="ui-badge ui-badge--mono">{index.data.origin === 'extracted' ? 'from the file' : 'inferred'}</span>
              </summary>
              <ul className="so-index__list">
                {index.data.entries.map((en, i) => (
                  <li key={i} style={{ paddingLeft: (Math.max(1, en.level) - 1) * 14 }}>
                    <button type="button" className="ui-btn ui-btn--link so-index__btn" onClick={() => jumpTo(en.page)}>{en.title}</button>
                    <span className="ui-muted ui-mono"> p. {pages.data?.[en.page]?.label ?? en.page + 1}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="so-insp__bar ui-row">
            <div className="ui-tabs" role="group" aria-label="Page filter">
              <button type="button" className="ui-tab" aria-selected={filter === 'all'} onClick={() => { setParams({}, { replace: true }); setSel(0); }}>All pages ({pages.data?.length ?? resource.pageCount})</button>
              <button type="button" className="ui-tab" aria-selected={filter === 'reading'} onClick={() => { setParams({ filter: 'reading' }, { replace: true }); setSel(0); }}>Need reading ({needing})</button>
            </div>
            {needing > 0 && (
              <button type="button" className="ui-btn ui-btn--sm" disabled={!!batch} onClick={() => void transcribeAll()}>
                {batch ? <><span className="ui-spinner" />Reading {batch.done}/{batch.total}</> : `Read ${needing} ${needing === 1 ? 'page' : 'pages'} with AI`}
              </button>
            )}
          </div>

          <div className="so-insp__body">
            <div className="so-pages">
              {pages.isLoading && <div className="ui-skeleton" style={{ height: 200 }} />}
              {pages.error && <div className="ui-banner ui-banner--danger">{errorText(pages.error)}</div>}
              {rows.length > 0 && (
                <VirtualList
                  items={rows}
                  rowHeight={36}
                  height={420}
                  label="Pages"
                  selected={Math.min(sel, rows.length - 1)}
                  onSelect={setSel}
                  renderRow={(p, _i, selected) => (
                    <div className={`so-page-row${selected ? ' is-selected' : ''}`}>
                      <span className="ui-mono">p. {p.label}</span>
                      <span className={`ui-dot ui-dot--${QUALITY[p.quality].tone}`} aria-hidden="true" />
                      <span className="ui-muted so-page-row__q">{QUALITY[p.quality].label}</span>
                    </div>
                  )}
                />
              )}
              {pages.data && rows.length === 0 && <p className="ui-muted">{filter === 'reading' ? 'Every page has readable text.' : 'This file has no pages.'}</p>}
            </div>

            {current && <PageDetail key={`${resource.id}-${current.idx}`} resource={resource} row={current} />}
          </div>
        </>
      )}
    </section>
  );
}

function PageDetail({ resource, row }: { resource: Resource; row: PageRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  const page = useQuery({ queryKey: qk.page(resource.id, row.idx), queryFn: () => api('GET /api/resources/:rid/pages/:idx', { params: { rid: resource.id, idx: row.idx } }) });
  const [imgFailed, setImgFailed] = useState(false);
  const transcribe = useMutation({
    mutationFn: () => api('POST /api/resources/:rid/pages/:idx/transcribe', { params: { rid: resource.id, idx: row.idx } }),
    onSuccess: (p) => {
      qc.setQueryData(qk.page(resource.id, row.idx), p);
      void qc.invalidateQueries({ queryKey: qk.pages(resource.id) });
      void qc.invalidateQueries({ queryKey: ['resources'] });
      toast('Page read');
    },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const p = page.data;
  const transcript = useMemo(() => (p?.transcript ? prepareSnippet(p.transcript) : null), [p?.transcript]);
  const hasImage = resource.kind !== 'md' && !imgFailed;

  return (
    <div className="so-detail">
      <div className="so-detail__head">
        <span className="ui-mono">{resource.filename} · p. {row.label}</span>
        <span className="ui-row">
          {p?.transcript && <span className="ui-badge ui-badge--success">Read by AI{p.transcriptModel ? ` · ${p.transcriptModel}` : ''}</span>}
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => transcribe.mutate()} disabled={transcribe.isPending}>
            {transcribe.isPending ? <><span className="ui-spinner" />Reading…</> : <><Icon name="sparkle" />{p?.transcript ? 'Read this page again with AI' : 'Read this page with AI'}</>}
          </button>
        </span>
      </div>
      <div className={`so-detail__cols${hasImage ? '' : ' no-image'}`}>
        {hasImage && (
          <figure className="so-detail__image">
            <img src={apiUrl('GET /api/resources/:rid/pages/:idx/image', { params: { rid: resource.id, idx: row.idx }, query: { scale: 1.2 } })} alt={`Page ${row.label} of ${resource.filename}`} loading="lazy" onError={() => setImgFailed(true)} />
          </figure>
        )}
        <div className="so-detail__text">
          <div className="ui-meta">Extracted text</div>
          {page.isLoading && <div className="ui-skeleton" style={{ height: 120 }} />}
          {page.error && <div className="ui-banner ui-banner--danger">{errorText(page.error)}</div>}
          {p && (p.text.trim() ? <pre className="so-text">{p.text}</pre> : <p className="ui-muted">No text layer on this page.</p>)}
          {transcript && (
            <>
              <div className="ui-meta so-transcript-label">Transcript</div>
              <div className="so-transcript"><ContentFlow content={transcript.content} formulaIndex={formulaMap(transcript.formulas)} /></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
