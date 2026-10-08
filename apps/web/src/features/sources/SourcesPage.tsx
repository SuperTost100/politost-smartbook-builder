import { useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Resource, ResourceRole } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useResources, useTopics } from '../../lib/queries';
import { bytes, plural } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { Dialog, ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Inspector } from './Inspector';
import './sources.css';

const ROLES: { value: ResourceRole; label: string }[] = [
  { value: 'theory', label: 'Theory' },
  { value: 'exercises', label: 'Exercises' },
  { value: 'exams', label: 'Exams' },
  { value: 'mixed', label: 'Mixed' },
];
const ACCEPT = '.pdf,.docx,.pptx,.md,.markdown,application/pdf';

const STATUS: Record<Resource['status'], { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: '' },
  extracting: { label: 'Reading', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export default function SourcesPage() {
  useDocumentTitle('Sources');
  const pid = useBookId();
  const { rid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const resources = useResources(pid);
  const topics = useTopics(pid);
  const [role, setRole] = useState<ResourceRole>('theory');
  const [dragging, setDragging] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Resource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.resources(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); };

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      form.set('role', role);
      for (const f of files) form.append('file', f, f.name);
      return api('POST /api/projects/:id/resources', { params: { id: pid }, form });
    },
    onSuccess: (r) => { toast(r.length === 1 ? 'Source added' : `${r.length} sources added`); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const patch = useMutation({
    mutationFn: (v: { rid: string; role?: ResourceRole; included?: boolean }) => api('PATCH /api/resources/:rid', { params: { rid: v.rid }, body: { role: v.role, included: v.included } }),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: (r: Resource) => api('DELETE /api/resources/:rid', { params: { rid: r.id } }),
    onSuccess: (_d, r) => { toast('Source deleted'); setToDelete(null); refresh(); if (rid === r.id) navigate(`/books/${pid}/sources`); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const prepare = useMutation({
    mutationFn: () => api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'prepare' } }),
    onSuccess: () => { toast('Mapping topics', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const addFiles = (list: FileList | File[] | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const ok = files.filter((f) => /\.(pdf|docx|pptx|md|markdown)$/i.test(f.name));
    if (ok.length !== files.length) toast(`Skipped ${plural(files.length - ok.length, 'file')}: only PDF, DOCX, PPTX and Markdown are read.`, { tone: 'danger' });
    if (ok.length) upload.mutate(ok);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); };

  const list = resources.data ?? [];
  const selected = list.find((r) => r.id === rid);
  const readyCount = list.filter((r) => r.status === 'ready' && r.included).length;
  const topicCount = topics.data?.length ?? 0;

  return (
    <div className="ui-page ui-page--wide so-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Sources</h1>
          <p className="ui-lede">Notes, slides and past exams the book is built from.</p>
        </div>
        <div className="ui-page__actions">
          {readyCount > 0 && <button type="button" className="ui-btn" onClick={() => prepare.mutate()} disabled={prepare.isPending} title="Finds the topics in your sources so the outline can cover them">{topicCount ? 'Map topics again' : 'Map topics'}</button>}
          <Link className={`ui-btn${readyCount ? ' ui-btn--accent' : ''}`} to={`/books/${pid}/outline`}>Go to outline</Link>
        </div>
      </div>

      <p className="ui-banner ui-banner--info so-notice"><Icon name="info" />Selected material is sent to the configured AI providers and NotebookLM.</p>

      <div className={`so-grid${selected ? ' has-inspector' : ''}`}>
        <div className="so-left">
          <div
            className={`so-drop${dragging ? ' is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Icon name="upload" size={22} />
            <p><strong>Drop files here</strong> or choose them from your computer.</p>
            <p className="ui-muted so-drop__types">PDF, DOCX, PPTX, Markdown</p>
            <div className="ui-row so-drop__actions">
              <div className="ui-field so-role">
                <label className="ui-field__label" htmlFor="so-role">Role of new files</label>
                <select id="so-role" className="ui-select ui-select--sm" value={role} onChange={(e) => setRole(e.target.value as ResourceRole)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="ui-sr" tabIndex={-1} aria-label="Choose source files" data-testid="source-file-input" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" className="ui-btn ui-btn--accent" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>{upload.isPending ? <><span className="ui-spinner" />Uploading…</> : 'Choose files'}</button>
              <button type="button" className="ui-btn" onClick={() => setLinkOpen(true)}><Icon name="link" />Add link</button>
            </div>
          </div>

          {resources.isLoading && <div className="ui-skeleton" style={{ height: 96 }} />}
          {resources.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(resources.error)}</div>}
          {!resources.isLoading && list.length === 0 && <div className="ui-empty"><p className="ui-empty__text">Add your notes or a past exam to start; PDF files with a text layer work best.</p></div>}

          <ul className="so-list" aria-label="Sources">
            {list.map((r) => (
              <li key={r.id} className={`so-row${r.id === rid ? ' is-selected' : ''}${r.included ? '' : ' is-excluded'}`}>
                <div className="so-row__top">
                  <Link className="so-row__name ui-wrap" to={`/books/${pid}/sources/${r.id}`} aria-current={r.id === rid ? 'true' : undefined}>
                    <Icon name={r.kind === 'url' ? 'link' : 'file'} size={16} />{r.filename}
                  </Link>
                  <span className={`ui-badge ui-badge--${STATUS[r.status].tone || 'neutral'}`}>{r.status === 'extracting' && <span className="ui-spinner" />}{STATUS[r.status].label}</span>
                </div>
                <div className="so-row__meta ui-muted">
                  <span className="ui-mono">{r.kind}</span>
                  <span>{bytes(r.size)}</span>
                  {r.status === 'ready' && <span>{plural(r.pageCount, 'page')}</span>}
                  {r.pagesNeedingVision > 0 && (
                    <Link className="so-need" to={`/books/${pid}/sources/${r.id}?filter=reading`}>
                      {r.pagesNeedingVision} {r.pagesNeedingVision === 1 ? 'page needs' : 'pages need'} reading{r.pagesTranscribed > 0 ? ` (${r.pagesTranscribed} done)` : ''}
                    </Link>
                  )}
                </div>
                {r.error && <p className="so-row__error">{r.error}</p>}
                <div className="so-row__controls">
                  <label className="so-role-inline">
                    <span className="ui-sr">Role of {r.filename}</span>
                    <select className="ui-select ui-select--sm" value={r.role} onChange={(e) => patch.mutate({ rid: r.id, role: e.target.value as ResourceRole })}>
                      {ROLES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                    </select>
                  </label>
                  <label className="ui-check"><input type="checkbox" checked={r.included} onChange={(e) => patch.mutate({ rid: r.id, included: e.target.checked })} />Include</label>
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon so-del" aria-label={`Delete ${r.filename}`} onClick={() => setToDelete(r)}><Icon name="trash" /></button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {selected && <Inspector key={selected.id} projectId={pid} resource={selected} onClose={() => navigate(`/books/${pid}/sources`)} />}
        {rid && !selected && !resources.isLoading && <div className="ui-empty so-missing"><p className="ui-empty__text">This source is no longer in the book.</p><Link className="ui-btn" to={`/books/${pid}/sources`}>Back to sources</Link></div>}
      </div>

      <AddLink open={linkOpen} onClose={() => setLinkOpen(false)} projectId={pid} defaultRole={role} onAdded={refresh} />
      <ConfirmDialog
        open={!!toDelete}
        title="Delete source"
        message={<>Delete <strong className="ui-wrap">{toDelete?.filename}</strong>? Evidence drawn from it will no longer be available in the book.</>}
        confirmLabel="Delete source"
        danger
        busy={remove.isPending}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
      />
    </div>
  );
}

function AddLink({ open, onClose, projectId, defaultRole, onAdded }: { open: boolean; onClose: () => void; projectId: string; defaultRole: ResourceRole; onAdded: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [role, setRole] = useState<ResourceRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api('POST /api/projects/:id/resources/url', { params: { id: projectId }, body: { url: url.trim(), role } }),
    onSuccess: () => { toast('Link added'); setUrl(''); setError(null); onAdded(); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  const valid = /^https?:\/\/\S+$/i.test(url.trim());
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add link"
      footer={<><button type="button" className="ui-btn" onClick={onClose}>Cancel</button><button type="submit" form="so-link-form" className="ui-btn ui-btn--accent" disabled={!valid || add.isPending}>Add link</button></>}
    >
      <form id="so-link-form" className="ui-stack" onSubmit={(e) => { e.preventDefault(); if (valid) add.mutate(); }}>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="so-url">Address</label>
          <input id="so-url" className="ui-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus />
          <span className="ui-field__hint">A public page or PDF. The text is saved with the book's sources.</span>
        </div>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="so-link-role">Role</label>
          <select id="so-link-role" className="ui-select" value={role} onChange={(e) => setRole(e.target.value as ResourceRole)}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}
