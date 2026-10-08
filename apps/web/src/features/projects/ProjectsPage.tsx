import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectSummary } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk, useExports, useProjects } from '../../lib/queries';
import { STEPS, nextAction, stepIndex } from '../../lib/stage';
import { plural, timeAgo } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { ConfirmDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import './projects.css';

export function ProjectsPage() {
  useDocumentTitle('Books');
  const { data, isLoading, error, refetch } = useProjects();
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();

  const all = data ?? [];
  const live = all.filter((p) => !p.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const archived = all.filter((p) => p.archivedAt);

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <h1 className="ui-screen-title">Books</h1>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn ui-btn--accent" onClick={() => navigate('/new')}><Icon name="plus" />New book</button>
        </div>
      </div>

      {isLoading && <div className="ui-stack"><div className="ui-skeleton" style={{ height: 150 }} /><div className="ui-skeleton" style={{ height: 150 }} /></div>}
      {error && (
        <div className="ui-banner ui-banner--danger" role="alert">
          <div className="ui-banner__body">
            <span className="ui-banner__title">Books did not load</span>
            <span>{errorText(error)}</span>
            <div className="ui-banner__actions"><button type="button" className="ui-btn ui-btn--sm" onClick={() => void refetch()}>Try again</button></div>
          </div>
        </div>
      )}

      {!isLoading && !error && live.length === 0 && (
        <div className="ui-empty">
          <p className="ui-empty__text">A book starts from your course notes and past exams; add your first one to begin.</p>
          <button type="button" className="ui-btn ui-btn--accent" onClick={() => navigate('/new')}><Icon name="plus" />New book</button>
        </div>
      )}

      <ul className="pj-list">
        {live.map((p, i) => <li key={p.id}><ProjectCard p={p} lead={i === 0 && live.length > 1} /></li>)}
      </ul>

      {archived.length > 0 && (
        <div className="ui-stack">
          <button type="button" className="ui-btn ui-btn--link" style={{ alignSelf: 'flex-start' }} aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? 'Hide archived books' : `Show ${plural(archived.length, 'archived book')}`}
          </button>
          {showArchived && <ul className="pj-list">{archived.map((p) => <li key={p.id}><ProjectCard p={p} lead={false} /></li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p, lead }: { p: ProjectSummary; lead: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = nextAction(p);
  const step = stepIndex(p.stage);
  const exports = useExports(p.stage === 'export' ? p.id : undefined);
  const latest = [...(exports.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const refresh = () => void qc.invalidateQueries({ queryKey: qk.projects });
  const archive = useMutation({
    mutationFn: () => api('POST /api/projects/:id/archive', { params: { id: p.id } }),
    onSuccess: () => { toast('Book archived'); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE /api/projects/:id', { params: { id: p.id } }),
    onSuccess: () => { toast('Book deleted'); setConfirmDelete(false); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const { counts } = p;
  return (
    <article className={`pj-card${lead ? ' pj-card--lead' : ''}${p.archivedAt ? ' pj-card--archived' : ''}`} aria-labelledby={`pj-${p.id}`}>
      <div className="pj-main">
        <div className="pj-head">
          <h2 id={`pj-${p.id}`} className="pj-title"><Link to={`/books/${p.id}/${p.stage === 'drafting' || p.stage === 'review' ? 'manuscript' : 'sources'}`}>{p.title}</Link></h2>
          <p className="pj-meta">
            <span>{p.subject}</span>
            <span aria-hidden="true">·</span>
            <span className="ui-mono">{p.language}</span>
            {p.authors.length > 0 && <><span aria-hidden="true">·</span><span>{p.authors.join(', ')}</span></>}
            <span aria-hidden="true">·</span>
            <span>updated {timeAgo(p.updatedAt)}</span>
          </p>
        </div>

        <ol className="pj-track" aria-label="Stage">
          {STEPS.map((s, i) => (
            <li key={s} className={`pj-step${i < step ? ' is-done' : ''}${i === step ? ' is-current' : ''}`} aria-current={i === step ? 'step' : undefined}>
              <span className="pj-step__mark" aria-hidden="true">{i < step ? <Icon name="check" size={11} /> : null}</span>
              <span className="pj-step__label">{s}{i === step && p.stage === 'mapping' ? ' (mapping)' : ''}</span>
            </li>
          ))}
        </ol>

        <ul className="pj-counts">
          <li><strong>{counts.resources}</strong> {counts.resources === 1 ? 'source' : 'sources'}</li>
          <li><strong>{counts.drafted}</strong> of {counts.sections} sections drafted</li>
          <li><strong>{counts.questions}</strong> {counts.questions === 1 ? 'question' : 'questions'}</li>
          <li className={counts.openIssues > 0 ? 'pj-counts__issues' : ''}><strong>{counts.openIssues}</strong> open {counts.openIssues === 1 ? 'issue' : 'issues'}</li>
        </ul>
        {action.note && <p className="pj-note" role="status">{action.note}</p>}
      </div>

      <div className="pj-side">
        {action.kind === 'download' && latest ? (
          <a className="ui-btn" href={apiUrl('GET /api/exports/:exportId/download', { params: { exportId: latest.id } })} download><Icon name="download" />Download .ptsb</a>
        ) : (
          <Link className="ui-btn" to={action.kind === 'download' ? action.to : action.to}>{action.kind === 'download' ? 'Export book' : action.label}</Link>
        )}
        <div className="ui-row pj-secondary">
          <Link className="ui-btn ui-btn--ghost ui-btn--sm" to={`/books/${p.id}/settings`}>Setup</Link>
          {!p.archivedAt && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => archive.mutate()} disabled={archive.isPending}>Archive</button>}
          {p.archivedAt && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this book"
        message={<>This removes <strong>{p.title}</strong>, its sources, drafts and exports from this computer. It cannot be undone.</>}
        confirmLabel="Delete book"
        danger
        busy={remove.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      />
    </article>
  );
}
