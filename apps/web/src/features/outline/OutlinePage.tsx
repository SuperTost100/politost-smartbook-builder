import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { Outline, OutlineChapter, OutlineSection, Resource, Topic } from '@smartbuilder/domain';
import { api, errorText, isConflict } from '../../lib/api';
import { qk, useOutline, useProject, useQuestions, useResources, useTopics } from '../../lib/queries';
import { coverage, emptyOutline, examSessionTotal, mergeSections, move, newChapter, newSection, sessionsPhrase } from '../../lib/outline';
import { newId, slugify, timeAgo } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import './outline.css';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function OutlinePage() {
  useDocumentTitle('Outline');
  const pid = useBookId();
  const qc = useQueryClient();
  const toast = useToast();
  const outlineQ = useOutline(pid);
  const topicsQ = useTopics(pid);
  const resourcesQ = useResources(pid);
  const questionsQ = useQuestions(pid);
  const project = useProject(pid);

  const current = outlineQ.data?.current ?? null;
  const [draft, setDraft] = useState<Outline | null>(null);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [newer, setNewer] = useState(false);
  const initial = useRef<Outline | null>(null);

  const dirty = !!draft && !same(draft, initial.current);

  // Adopt the server outline when we have no unsaved edits; otherwise offer it.
  useEffect(() => {
    if (!outlineQ.data) return;
    const serverId = current?.id ?? null;
    if (draft === null || (!dirty && serverId !== baseId)) {
      const o = current?.outline ?? null;
      initial.current = o;
      setDraft(o ? structuredClone(o) : null);
      setBaseId(serverId);
      setNewer(false);
    } else if (serverId !== baseId && dirty) {
      setNewer(true);
    }
  }, [outlineQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLatest = async () => {
    const fresh = await outlineQ.refetch();
    const c = fresh.data?.current ?? null;
    initial.current = c?.outline ?? null;
    setDraft(c ? structuredClone(c.outline) : null);
    setBaseId(c?.id ?? null);
    setConflict(null);
    setNewer(false);
  };

  const refresh = () => { void qc.invalidateQueries({ queryKey: qk.outline(pid) }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); };

  const save = useMutation({
    mutationFn: (v: { base: string | null }) => api('PUT /api/projects/:id/outline', { params: { id: pid }, body: { outline: draft!, baseRevId: v.base } }),
    onSuccess: (rev) => {
      initial.current = structuredClone(rev.outline);
      setBaseId(rev.id);
      setConflict(null);
      setNewer(false);
      qc.setQueryData(qk.outline(pid), (old: typeof outlineQ.data) => (old ? { ...old, current: rev } : old));
      toast('Outline saved');
      refresh();
    },
    onError: (e) => { if (isConflict(e)) setConflict(errorText(e)); else toast(errorText(e), { tone: 'danger' }); },
  });

  const approve = useMutation({
    mutationFn: async () => {
      let revId = baseId;
      if (dirty) { const rev = await api('PUT /api/projects/:id/outline', { params: { id: pid }, body: { outline: draft!, baseRevId: baseId } }); revId = rev.id; initial.current = structuredClone(rev.outline); setBaseId(rev.id); }
      return api('POST /api/projects/:id/outline/approve', { params: { id: pid }, body: { revId: revId! } });
    },
    onSuccess: () => { toast('Outline approved', { action: { label: 'Open run', to: `/books/${pid}/run` } }); setConflict(null); refresh(); },
    onError: (e) => { if (isConflict(e)) setConflict(errorText(e)); else toast(errorText(e), { tone: 'danger' }); },
  });

  const plan = useMutation({
    mutationFn: () => api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'plan' } }),
    onSuccess: () => { toast('Generating outline', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); void qc.invalidateQueries({ queryKey: qk.runs(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const topics = topicsQ.data ?? [];
  const resources = (resourcesQ.data ?? []).filter((r) => r.status === 'ready' && r.included);
  const approved = !!current?.approvedAt && !dirty;
  const hasSources = resources.length > 0;
  const running = project.data?.activeRun?.kind === 'plan' && !!project.data.activeRun && !['completed', 'failed', 'cancelled'].includes(project.data.activeRun.status);

  const update = (fn: (o: Outline) => Outline) => setDraft((d) => (d ? fn(d) : d));

  return (
    <div className="ui-page ui-page--wide ol-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Outline</h1>
          <p className="ui-lede">
            {current ? (approved ? `Approved ${timeAgo(current.approvedAt)}. Drafting follows this outline.` : dirty ? 'You have unsaved changes.' : 'Not approved yet. Drafting waits for your approval.') : 'The common index of the book, built from your sources.'}
          </p>
        </div>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn" onClick={() => plan.mutate()} disabled={!hasSources || plan.isPending || running} title={hasSources ? undefined : 'Add and read a source first'}>
            {running ? <><span className="ui-spinner" />Generating outline…</> : 'Generate outline'}
          </button>
          <button type="button" className="ui-btn" onClick={() => save.mutate({ base: baseId })} disabled={!dirty || save.isPending}>Save</button>
          {approved ? <span className="ui-badge ui-badge--success"><Icon name="check" size={12} />Approved</span> : (
            <button type="button" className="ui-btn ui-btn--accent" onClick={() => approve.mutate()} disabled={!draft || draft.chapters.length === 0 || approve.isPending}>Approve outline</button>
          )}
        </div>
      </div>

      {conflict && (
        <div className="ui-banner ui-banner--warning" role="alert">
          <div className="ui-banner__body">
            <span className="ui-banner__title">The outline changed somewhere else</span>
            <span>{conflict}</span>
            <div className="ui-banner__actions">
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => void loadLatest()}>Load latest</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={async () => { const f = await outlineQ.refetch(); save.mutate({ base: f.data?.current?.id ?? null }); }}>Save my version over it</button>
            </div>
          </div>
        </div>
      )}
      {newer && !conflict && (
        <div className="ui-banner ui-banner--info" role="status">
          <div className="ui-banner__body">
            <span className="ui-banner__title">A newer outline is available</span>
            <span>It was generated while you were editing. Your unsaved changes are still here.</span>
            <div className="ui-banner__actions"><button type="button" className="ui-btn ui-btn--sm" onClick={() => void loadLatest()}>Load latest</button></div>
          </div>
        </div>
      )}

      <div className="ol-grid">
        <aside className="ol-sources" aria-label="Source indexes">
          <h2 className="ui-panel-title">Source indexes</h2>
          <p className="ui-muted ol-hint">As found in each file. Read only.</p>
          <SourceIndexes resources={resources} />
        </aside>

        <section className="ol-editor" aria-label="Common index">
          {outlineQ.isLoading && <div className="ui-skeleton" style={{ height: 240 }} />}
          {outlineQ.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(outlineQ.error)}</div>}
          {!outlineQ.isLoading && draft === null && (
            <div className="ui-empty">
              <p className="ui-empty__text">{hasSources ? 'No outline yet. Generate one from your sources, or start an empty one and write it yourself.' : 'An outline needs sources first. Add a source, then generate the outline.'}</p>
              <div className="ui-row">
                {hasSources ? <button type="button" className="ui-btn ui-btn--accent" onClick={() => plan.mutate()} disabled={plan.isPending}>Generate outline</button> : <Link className="ui-btn ui-btn--accent" to={`/books/${pid}/sources`}>Add sources</Link>}
                <button type="button" className="ui-btn" onClick={() => { initial.current = null; setDraft({ ...emptyOutline(), chapters: [newChapter(1)] }); }}>Start an empty outline</button>
              </div>
            </div>
          )}
          {draft && (
            <>
              <ol className="ol-chapters">
                {draft.chapters.map((ch, ci) => (
                  <ChapterCard
                    key={ch.id}
                    chapter={ch}
                    index={ci}
                    count={draft.chapters.length}
                    topics={topics}
                    onChange={(next) => update((o) => ({ ...o, chapters: o.chapters.map((c, i) => (i === ci ? next : c)) }))}
                    onMove={(dir) => { update((o) => ({ ...o, chapters: move(o.chapters, ci, dir) })); focusLater(`ol-ch-${ch.id}`); }}
                    onRemove={() => update((o) => ({ ...o, chapters: o.chapters.filter((_, i) => i !== ci) }))}
                  />
                ))}
              </ol>
              <button type="button" className="ui-btn" onClick={() => update((o) => ({ ...o, chapters: [...o.chapters, newChapter(o.chapters.length + 1)] }))}><Icon name="plus" />Add chapter</button>
              <div className="ui-field ol-notation">
                <label className="ui-field__label" htmlFor="ol-notation">Notation</label>
                <textarea id="ol-notation" className="ui-textarea" rows={2} value={draft.notation} onChange={(e) => update((o) => ({ ...o, notation: e.target.value }))} placeholder="Symbols and conventions used across the book" />
              </div>
            </>
          )}
        </section>

        <aside className="ol-coverage" aria-label="Topic coverage">
          <Coverage outline={draft} topics={topics} total={examSessionTotal(questionsQ.data ?? [])} onExclude={(topicId, reason) => update((o) => ({ ...o, exclusions: [...o.exclusions.filter((e) => e.topicId !== topicId), ...(reason !== null ? [{ topicId, reason }] : [])] }))} loading={topicsQ.isLoading} />
        </aside>
      </div>
    </div>
  );
}

function focusLater(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function onReorderKey(e: React.KeyboardEvent, dir: (d: -1 | 1) => void) {
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); dir(e.key === 'ArrowUp' ? -1 : 1); }
}

function Lines({ id, label, value, onChange, rows = 2 }: { id: string; label: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  return (
    <div className="ui-field">
      <label className="ui-field__label ol-small-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="ui-textarea ol-lines" rows={Math.max(rows, value.length)} value={value.join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} onBlur={(e) => onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))} />
      <span className="ui-field__hint">One per line.</span>
    </div>
  );
}

function ChapterCard({ chapter, index, count, topics, onChange, onMove, onRemove }: {
  chapter: OutlineChapter; index: number; count: number; topics: Topic[];
  onChange: (c: OutlineChapter) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const setSections = (sections: OutlineSection[]) => onChange({ ...chapter, sections });
  const retitle = (title: string) => {
    const auto = chapter.slug === '' || chapter.slug === slugify(chapter.title);
    onChange({ ...chapter, title, slug: auto ? slugify(title) || `capitolo-${index + 1}` : chapter.slug });
  };
  return (
    <li className="ol-chapter ui-card">
      <div className="ol-chapter__head">
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-expanded={open} aria-label={open ? 'Collapse chapter' : 'Expand chapter'} onClick={() => setOpen((o) => !o)}><Icon name={open ? 'chevron-down' : 'chevron-right'} /></button>
        <span className="ol-num ui-mono">{index + 1}</span>
        <input id={`ol-ch-${chapter.id}`} className="ui-input ol-title ol-title--chapter" aria-label={`Title of chapter ${index + 1}`} value={chapter.title} onChange={(e) => retitle(e.target.value)} onKeyDown={(e) => onReorderKey(e, onMove)} />
        <div className="ol-ctl">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move chapter ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}><Icon name="arrow-up" /></button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move chapter ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}><Icon name="arrow-down" /></button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm ui-btn--danger" aria-label={`Delete chapter ${index + 1}`} onClick={() => { if (chapter.sections.length === 0 || window.confirm(`Delete chapter ${index + 1} and its ${chapter.sections.length} sections from the outline?`)) onRemove(); }}><Icon name="trash" /></button>
        </div>
      </div>
      {open && (
        <div className="ol-chapter__body">
          <div className="ol-two">
            <Lines id={`ol-obj-${chapter.id}`} label="Objectives" value={chapter.objectives} onChange={(objectives) => onChange({ ...chapter, objectives })} />
            <div className="ui-field">
              <label className="ui-field__label ol-small-label" htmlFor={`ol-slug-${chapter.id}`}>Slug</label>
              <input id={`ol-slug-${chapter.id}`} className="ui-input ui-input--mono ui-input--sm" value={chapter.slug} onChange={(e) => onChange({ ...chapter, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            </div>
          </div>
          <ol className="ol-sections">
            {chapter.sections.map((s, si) => (
              <SectionRow
                key={s.id}
                section={s}
                label={`${index + 1}.${si + 1}`}
                count={chapter.sections.length}
                index={si}
                topics={topics}
                onChange={(next) => setSections(chapter.sections.map((x, i) => (i === si ? next : x)))}
                onMove={(d) => { setSections(move(chapter.sections, si, d)); focusLater(`ol-sec-${s.id}`); }}
                onRemove={() => setSections(chapter.sections.filter((_, i) => i !== si))}
                onMerge={(dir) => setSections(mergeSections(chapter.sections, si, si + dir))}
              />
            ))}
          </ol>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => setSections([...chapter.sections, newSection()])}><Icon name="plus" />Add section</button>
        </div>
      )}
    </li>
  );
}

function SectionRow({ section, label, index, count, topics, onChange, onMove, onRemove, onMerge }: {
  section: OutlineSection; label: string; index: number; count: number; topics: Topic[];
  onChange: (s: OutlineSection) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onMerge: (dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const setSubs = (subsections: OutlineSection['subsections']) => onChange({ ...section, subsections });
  return (
    <li className="ol-section">
      <div className="ol-section__head">
        <span className="ol-num ui-mono">{label}</span>
        <input id={`ol-sec-${section.id}`} className="ui-input ol-title" aria-label={`Title of section ${label}`} value={section.title} onChange={(e) => onChange({ ...section, title: e.target.value })} onKeyDown={(e) => onReorderKey(e, onMove)} />
        <select className="ui-select ui-select--sm ol-depth" aria-label={`Depth of section ${label}`} value={section.depth} onChange={(e) => onChange({ ...section, depth: e.target.value as OutlineSection['depth'] })}>
          <option value="brief">Brief</option><option value="standard">Standard</option><option value="deep">Deep</option>
        </select>
        <button type="button" className={`ui-btn ui-btn--sm${section.topicIds.length ? '' : ' ui-btn--ghost'}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {section.topicIds.length} {section.topicIds.length === 1 ? 'topic' : 'topics'}, {section.subsections.length} sub
        </button>
        <div className="ol-ctl">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move section ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}><Icon name="arrow-up" /></button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move section ${label} down`} disabled={index === count - 1} onClick={() => onMove(1)}><Icon name="arrow-down" /></button>
        </div>
      </div>
      {open && (
        <div className="ol-section__body">
          <Lines id={`ol-sobj-${section.id}`} label="Objectives" value={section.objectives} onChange={(objectives) => onChange({ ...section, objectives })} />
          <TopicPicker topics={topics} value={section.topicIds} onChange={(topicIds) => onChange({ ...section, topicIds })} id={section.id} />
          <div className="ol-subs">
            <div className="ui-field__label ol-small-label">Subsections</div>
            {section.subsections.map((sub, i) => (
              <div key={sub.id} className="ol-sub">
                <input className="ui-input ui-input--sm" aria-label={`Subsection ${i + 1} title`} value={sub.title} onChange={(e) => setSubs(section.subsections.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} onKeyDown={(e) => onReorderKey(e, (d) => setSubs(move(section.subsections, i, d)))} />
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move subsection ${i + 1} up`} disabled={i === 0} onClick={() => setSubs(move(section.subsections, i, -1))}><Icon name="arrow-up" /></button>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={`Move subsection ${i + 1} down`} disabled={i === section.subsections.length - 1} onClick={() => setSubs(move(section.subsections, i, 1))}><Icon name="arrow-down" /></button>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm ui-btn--danger" aria-label={`Delete subsection ${i + 1}`} onClick={() => setSubs(section.subsections.filter((_, k) => k !== i))}><Icon name="trash" /></button>
              </div>
            ))}
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSubs([...section.subsections, { id: newId('ss'), title: 'New subsection', objectives: [] }])}><Icon name="plus" />Add subsection</button>
          </div>
          <div className="ui-row ol-danger-row">
            <button type="button" className="ui-btn ui-btn--sm" disabled={index === 0} onClick={() => onMerge(-1)}><Icon name="merge" />Merge into previous section</button>
            <button type="button" className="ui-btn ui-btn--sm" disabled={index === count - 1} onClick={() => onMerge(1)}><Icon name="merge" />Merge into next section</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" onClick={onRemove}><Icon name="trash" />Remove section</button>
          </div>
        </div>
      )}
    </li>
  );
}

function TopicPicker({ topics, value, onChange, id }: { topics: Topic[]; value: string[]; onChange: (v: string[]) => void; id: string }) {
  const [q, setQ] = useState('');
  const shown = topics.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  if (topics.length === 0) return <p className="ui-muted ol-hint">No topics yet. Use Map topics on the Sources screen to find them.</p>;
  return (
    <div className="ui-field">
      <label className="ui-field__label ol-small-label" htmlFor={`ol-tq-${id}`}>Linked topics</label>
      <input id={`ol-tq-${id}`} className="ui-input ui-input--sm" type="search" placeholder="Filter topics" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ol-topic-list" role="group" aria-label="Topics">
        {shown.map((t) => (
          <label key={t.id} className="ui-check">
            <input type="checkbox" checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} />
            <span className="ui-wrap">{t.name}</span>
          </label>
        ))}
        {shown.length === 0 && <span className="ui-muted">No topic matches.</span>}
      </div>
    </div>
  );
}

function SourceIndexes({ resources }: { resources: Resource[] }) {
  const results = useQueries({ queries: resources.map((r) => ({ queryKey: qk.sourceIndex(r.id), queryFn: () => api('GET /api/resources/:rid/index', { params: { rid: r.id } }) })) });
  if (resources.length === 0) return <p className="ui-muted ol-hint">Sources appear here once they are read.</p>;
  return (
    <div className="ol-src-list">
      {resources.map((r, i) => {
        const idx = results[i]?.data;
        return (
          <details key={r.id} className="ol-src" open={resources.length <= 2}>
            <summary><span className="ui-wrap">{r.filename}</span></summary>
            {results[i]?.isLoading && <div className="ui-skeleton" style={{ height: 40 }} />}
            {idx === null && <p className="ui-muted ol-hint">No index found in this file.</p>}
            {idx && (
              <ul className="ol-tree">
                {idx.entries.map((e, k) => <li key={k} style={{ paddingLeft: Math.max(0, e.level - 1) * 12 }}><span className="ui-wrap">{e.title}</span> <span className="ui-mono ui-muted">p.{e.page + 1}</span></li>)}
              </ul>
            )}
          </details>
        );
      })}
    </div>
  );
}

function Coverage({ outline, topics, total, onExclude, loading }: { outline: Outline | null; topics: Topic[]; total: number; onExclude: (topicId: string, reason: string | null) => void; loading: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const pid = useBookId();
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [excluding, setExcluding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const rows = useMemo(() => {
    const cov = outline ? coverage(outline, topics) : topics.map((topic) => ({ topic, sections: [], excludedReason: null as string | null }));
    const weight = { high: 2, normal: 1, low: 0 };
    return cov.sort((a, b) => {
      const ga = a.sections.length === 0 && a.excludedReason === null ? 1 : 0;
      const gb = b.sections.length === 0 && b.excludedReason === null ? 1 : 0;
      return gb - ga || weight[b.topic.priority] - weight[a.topic.priority] || b.topic.examSessions - a.topic.examSessions;
    });
  }, [outline, topics]);
  const gaps = rows.filter((r) => r.sections.length === 0 && r.excludedReason === null).length;
  const shown = onlyGaps ? rows.filter((r) => r.sections.length === 0 && r.excludedReason === null) : rows;

  const setPriority = useMutation({
    mutationFn: (v: { id: string; priority: Topic['priority'] }) => api('PATCH /api/topics/:tid', { params: { tid: v.id }, body: { priority: v.priority } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.topics(pid) }),
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  return (
    <>
      <div className="ol-cov-head">
        <h2 className="ui-panel-title">Topic coverage</h2>
        {topics.length > 0 && <span className={`ui-badge ${gaps ? 'ui-badge--warning' : 'ui-badge--success'}`}>{gaps ? `${gaps} uncovered` : 'All covered'}</span>}
      </div>
      {loading && <div className="ui-skeleton" style={{ height: 120 }} />}
      {!loading && topics.length === 0 && <p className="ui-muted ol-hint">Topics are found when sources are mapped. Run Map topics on the Sources screen.</p>}
      {topics.length > 0 && (
        <label className="ui-check"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />Show uncovered only</label>
      )}
      <ul className="ol-cov">
        {shown.map(({ topic, sections, excludedReason }) => {
          const gap = sections.length === 0 && excludedReason === null;
          return (
            <li key={topic.id} className={`ol-topic${gap ? ' is-gap' : ''}`}>
              <div className="ol-topic__top">
                <span className="ol-topic__name ui-wrap">{topic.name}</span>
                {gap && <span className="ui-badge ui-badge--warning">Uncovered</span>}
                {excludedReason !== null && <span className="ui-badge">Excluded</span>}
              </div>
              <div className="ui-muted ol-topic__sessions">{sessionsPhrase(topic.examSessions, total)}</div>
              <div className="ol-topic__row">
                <label className="ol-topic__prio">
                  <span className="ui-sr">Priority of {topic.name}</span>
                  <select className="ui-select ui-select--sm" value={topic.priority} onChange={(e) => setPriority.mutate({ id: topic.id, priority: e.target.value as Topic['priority'] })}>
                    <option value="low">Low priority</option><option value="normal">Normal priority</option><option value="high">High priority</option>
                  </select>
                </label>
                {gap && excluding !== topic.id && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setExcluding(topic.id); setReason(''); }}>Exclude</button>}
                {excludedReason !== null && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => onExclude(topic.id, null)}>Include again</button>}
              </div>
              {excluding === topic.id && (
                <form className="ol-exclude" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { onExclude(topic.id, reason.trim()); setExcluding(null); } }}>
                  <input className="ui-input ui-input--sm" aria-label={`Reason for excluding ${topic.name}`} placeholder="Why leave it out" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <button type="submit" className="ui-btn ui-btn--sm" disabled={!reason.trim()}>Exclude</button>
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setExcluding(null)}>Cancel</button>
                </form>
              )}
              {excludedReason !== null && <p className="ol-topic__where">Left out: {excludedReason}</p>}
              {sections.length > 0 && <p className="ol-topic__where">Covered in {sections.map((s) => `${s.number} ${s.title}`).join('; ')}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
