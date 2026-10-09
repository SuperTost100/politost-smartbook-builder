import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvidenceNote, ReviewIssue, Resource, SectionView } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { qk } from '../../lib/queries';
import type { MappedBlock } from '../../lib/blocks';
import { CiteMark } from '../../components/CiteMark';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ContentFlow } from '../../reader/ContentFlow';
import './evidence.css';

/** NotebookLM writes math as \\( … \\) and \\[ … \\]; the reader renderer expects $ … $ and $$ … $$. */
function texDelimiters(text: string) {
  return text
    .replace(/\\{1,2}\[([\s\S]+?)\\{1,2}\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\{1,2}\(([\s\S]+?)\\{1,2}\)/g, (_, m) => `$${m}$`);
}

interface Props {
  pid: string;
  section: SectionView;
  block: MappedBlock;
  notes: { n: number; note: EvidenceNote }[];
  issues: ReviewIssue[];
  resources: Resource[];
  focusNote?: string;
  onClose: () => void;
  onEdit: (index: number) => void;
}

export function EvidenceDrawer({ pid, section, block, notes, issues, resources, focusNote, onClose, onEdit }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const checks = issues.filter((i) => i.source !== 'review');
  const review = issues.filter((i) => i.source === 'review');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.cm-editor, dialog')) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="ev-drawer" aria-label={`Evidence for block ${block.index + 1}`}>
      <header className="ev-head">
        <div className="ui-grow">
          <div className="ui-meta">Evidence</div>
          <div className="ev-head__title">Block {block.index + 1} · {notes.length ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : 'no evidence cited'}</div>
        </div>
        <button ref={closeRef} type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label="Close evidence" onClick={onClose}><Icon name="x" /></button>
      </header>

      <div className="ev-body">
        {notes.length === 0 && (
          <p className="ev-none">This block cites no source. If it states a fact from your material, ask for a regeneration that cites it, or edit it and add the source by hand.</p>
        )}
        {notes.map(({ n, note }) => <NoteCard key={`${block.index}-${note.id}`} n={n} note={note} resources={resources} highlighted={note.id === focusNote} />)}

        {(checks.length > 0 || review.length > 0) && (
          <section className="ev-issues" aria-label="Checks and review issues">
            {checks.length > 0 && <IssueGroup title="Checks" pid={pid} issues={checks} block={block} onEdit={onEdit} />}
            {review.length > 0 && <IssueGroup title="Review issues" pid={pid} issues={review} block={block} onEdit={onEdit} />}
          </section>
        )}
        {section.evidence && notes.length === 0 && section.evidence.notes.length > 0 && (
          <p className="ui-muted ev-more">{section.evidence.notes.length} evidence notes were gathered for this section; this block does not cite them.</p>
        )}
      </div>
    </aside>
  );
}

function NoteCard({ n, note, resources, highlighted }: { n: number; note: EvidenceNote; resources: Resource[]; highlighted: boolean }) {
  const resource = resources.find((r) => r.id === note.resourceId);
  const located = note.page !== null && !!note.resourceId;
  const pages = useQuery({ queryKey: qk.pages(note.resourceId ?? ''), queryFn: () => api('GET /api/resources/:rid/pages', { params: { rid: note.resourceId! } }), enabled: located, staleTime: 60_000 });
  const label = located ? (pages.data?.find((p) => p.idx === note.page)?.label ?? String((note.page ?? 0) + 1)) : null;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (highlighted) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [highlighted]);

  const src = located
    ? apiUrl('GET /api/resources/:rid/pages/:idx/image', { params: { rid: note.resourceId!, idx: note.page! }, query: { scale: 1.5, highlight: note.quote.slice(0, 700), t: tries || undefined } })
    : null;

  return (
    <article ref={ref} className={`ev-note${highlighted ? ' is-focus' : ''}`} aria-label={`Evidence note ${n}`}>
      <div className="ev-note__head">
        <span className="ev-note__n"><CiteMark n={n} /></span>
        <span className={`ui-badge ${note.verified ? 'ui-badge--success' : 'ui-badge--warning'}`}>
          <Icon name={note.verified ? 'check' : 'alert'} size={12} />{note.verified ? (note.url ? 'found on the page' : 'verified') : 'not located'}
        </span>
      </div>
      {note.claim && <div className="ev-note__claim"><ContentFlow content={texDelimiters(note.claim)} /></div>}

      {src && !failed && (
        <figure className="ev-page">
          {!loaded && <div className="ev-page__wait ui-skeleton" aria-hidden="true" />}
          <img className={`ev-img${loaded ? ' is-in' : ''}`} src={src} alt={`Source page ${label} of ${resource?.filename ?? 'the source'}, with the quoted lines marked`} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        </figure>
      )}
      {src && failed && (
        <div className="ev-page__fail">
          <span>The page image did not load.</span>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => { setFailed(false); setLoaded(false); setTries((t) => t + 1); }}>Try again</button>
        </div>
      )}
      {note.url ? (
        <div className="ev-cap"><a href={note.url} target="_blank" rel="noopener noreferrer">{note.title || note.url}</a> <span className="ui-mono ui-muted">{webHost(note.url)}</span></div>
      ) : located ? (
        <div className="ev-cap ui-mono">{resource?.filename ?? 'source'} · p. {label}</div>
      ) : (
        <div className="ev-cap ev-cap--warn">No page found for this quote, so it is not shown against a source.</div>
      )}
      <blockquote className="ev-quote">{note.quote}</blockquote>
    </article>
  );
}

export function IssueGroup({ title, pid, issues, block, onEdit }: { title: string; pid: string; issues: ReviewIssue[]; block?: MappedBlock; onEdit?: (i: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.issues(pid) }); void qc.invalidateQueries({ queryKey: ['section', pid] }); void qc.invalidateQueries({ queryKey: qk.manuscript(pid) }); };
  const fix = useMutation({
    mutationFn: (id: string) => api('POST /api/projects/:id/issues/fix', { params: { id: pid }, body: { issueIds: [id] } }),
    onSuccess: () => { toast('Fix requested. It is applied to the text; earlier versions stay in the history.', { action: { label: 'Open run', to: `/books/${pid}/run` } }); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const accept = useMutation({
    mutationFn: (id: string) => api('PATCH /api/issues/:iid', { params: { iid: id }, body: { status: 'accepted' } }),
    onSuccess: () => { toast('Issue accepted as is'); refresh(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  return (
    <div className="ev-group">
      <h3 className="ui-meta">{title}</h3>
      <ul className="ev-issue-list">
        {issues.map((i) => (
          <li key={i.id} className="ev-issue">
            <div className="ui-row">
              <span className={`ui-badge ${i.severity === 'blocker' ? 'ui-badge--danger' : i.severity === 'major' ? 'ui-badge--warning' : ''}`}>{i.severity}</span>
              <span className="ui-muted ev-issue__cat">{i.category}</span>
              {i.status === 'proposed' && <span className="ui-badge ui-badge--info">fix proposed</span>}
            </div>
            <p className="ev-issue__msg">{i.message}</p>
            {i.quote && <blockquote className="ev-quote ev-quote--small">{i.quote}</blockquote>}
            {i.suggestion && <p className="ev-issue__sug"><strong>Suggestion:</strong> {i.suggestion}</p>}
            <div className="ui-row">
              {block && onEdit && <button type="button" className="ui-btn ui-btn--sm" onClick={() => onEdit(block.index)}><Icon name="edit" />Edit</button>}
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => fix.mutate(i.id)} disabled={fix.isPending || i.status === 'proposed'}><Icon name="sparkle" />Ask AI to fix</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => accept.mutate(i.id)} disabled={accept.isPending}>Accept as is</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const webHost = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
