import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Difficulty, Question, QuestionKind, QuestionOrigin, QuestionStatus, Topic } from '@smartbuilder/domain';
import { api, errorText, isConflict } from '../../lib/api';
import { qk, useManuscript, useProject, useQuestions, useTopics } from '../../lib/queries';
import { plural } from '../../lib/format';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { DifficultyTag } from '../../reader/DifficultyTag';
import { ConfirmDialog } from '../../components/Dialog';
import { LivePreview, SourceEditor } from '../../components/SourceEditor';
import { useToast } from '../../components/Toast';
import './practice.css';

const ORIGINS: QuestionOrigin[] = ['authentic', 'adapted', 'generated'];
const STATUSES: QuestionStatus[] = ['draft', 'verified', 'issue'];
const DIFFS: Difficulty[] = ['facile', 'medio', 'difficile'];
const STATUS_TONE: Record<QuestionStatus, string> = { draft: '', verified: 'success', issue: 'danger' };

const excerpt = (s: string) => s.replace(/\$[^$]*\$/g, '…').replace(/[#*:{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);

export default function PracticePage() {
  useDocumentTitle('Practice');
  const pid = useBookId();
  const [params, setParams] = useSearchParams();
  const tab: QuestionKind = params.get('tab') === 'exam' ? 'exam' : 'exercise';
  const selectedId = params.get('q');
  const questions = useQuestions(pid);
  const topics = useTopics(pid);
  const project = useProject(pid);
  const manuscript = useManuscript(pid);
  const qc = useQueryClient();
  const toast = useToast();

  const [chapter, setChapter] = useState('');
  const [topic, setTopic] = useState('');
  const [origin, setOrigin] = useState('');
  const [status, setStatus] = useState('');

  const all = questions.data ?? [];
  const ofTab = all.filter((q) => q.kind === tab);
  const shown = ofTab.filter((q) => (!chapter || q.chapterId === chapter) && (!topic || q.topicIds.includes(topic)) && (!origin || q.origin === origin) && (!status || q.status === status));
  const selected = all.find((q) => q.id === selectedId);
  const topicList = topics.data ?? [];
  const opts = project.data?.options;

  const setTab = (t: QuestionKind) => { const p = new URLSearchParams(params); p.set('tab', t); p.delete('q'); setParams(p, { replace: true }); };
  const select = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set('q', id); else p.delete('q'); setParams(p, { replace: true }); };

  const create = useMutation({
    mutationFn: () => api('POST /api/projects/:id/questions', { params: { id: pid }, body: { kind: tab, origin: 'adapted', statement: '', hint: '', solution: '', difficulty: 'medio', topicIds: topic ? [topic] : [] } }),
    onSuccess: (q) => { void qc.invalidateQueries({ queryKey: qk.questions(pid) }); select(q.id); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  return (
    <div className="ui-page ui-page--wide pr-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Practice</h1>
          <p className="ui-lede">Exercises that belong to the chapters, and exam practice kept apart so past exams stay recognisable.</p>
        </div>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn ui-btn--accent" onClick={() => create.mutate()} disabled={create.isPending}><Icon name="plus" />{tab === 'exam' ? 'Add exam question' : 'Add exercise'}</button>
        </div>
      </div>

      <div className="ui-tabs" role="tablist" aria-label="Practice type">
        <button type="button" role="tab" className="ui-tab" aria-selected={tab === 'exercise'} onClick={() => setTab('exercise')}>Exercises ({all.filter((q) => q.kind === 'exercise').length})</button>
        <button type="button" role="tab" className="ui-tab" aria-selected={tab === 'exam'} onClick={() => setTab('exam')}>Exam practice ({all.filter((q) => q.kind === 'exam').length})</button>
      </div>

      <Coverage questions={ofTab} topics={topicList} tab={tab} target={opts} onPick={(id) => setTopic(topic === id ? '' : id)} active={topic} />

      <div className="pr-filters ui-row" role="group" aria-label="Filters">
        <label className="pr-filter"><span className="ui-sr">Chapter</span>
          <select className="ui-select ui-select--sm" value={chapter} onChange={(e) => setChapter(e.target.value)}>
            <option value="">All chapters</option>
            {(manuscript.data ?? []).map((c) => <option key={c.chapterId} value={c.chapterId}>{c.number}. {c.title}</option>)}
          </select></label>
        <label className="pr-filter"><span className="ui-sr">Topic</span>
          <select className="ui-select ui-select--sm" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">All topics</option>
            {topicList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
        <label className="pr-filter"><span className="ui-sr">Origin</span>
          <select className="ui-select ui-select--sm" value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="">Any origin</option>
            {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select></label>
        <label className="pr-filter"><span className="ui-sr">Status</span>
          <select className="ui-select ui-select--sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select></label>
        <span className="ui-muted pr-count">{shown.length} of {plural(ofTab.length, 'question')}</span>
      </div>

      <div className={`pr-grid${selected ? ' has-editor' : ''}`}>
        <div className="pr-list-wrap">
          {questions.isLoading && <div className="ui-skeleton" style={{ height: 160 }} />}
          {questions.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(questions.error)}</div>}
          {!questions.isLoading && ofTab.length === 0 && (
            <div className="ui-empty"><p className="ui-empty__text">{tab === 'exam' ? 'No exam questions yet. Add a past exam in Sources, or write a practice question by hand.' : 'No exercises yet. Drafting writes them per topic, or add one yourself.'}</p></div>
          )}
          <ul className="pr-list">
            {shown.map((q) => {
              const groups = tab === 'exam' && q.examGroup;
              return (
                <li key={q.id}>
                  <button type="button" className="pr-item" aria-current={q.id === selectedId} onClick={() => select(q.id)}>
                    <span className="pr-item__top">
                      <span className="ui-mono pr-item__id">{q.number ? `#${q.number}` : q.id.slice(0, 6)}</span>
                      <span className={`ui-badge ui-badge--${STATUS_TONE[q.status] || 'neutral'}`}>{q.status}</span>
                      <span className="ui-badge">{q.origin}</span>
                      <DifficultyTag level={q.difficulty} />
                    </span>
                    {groups && <span className="ui-muted pr-item__group">{q.examGroup}</span>}
                    <span className="pr-item__text ui-serif">{excerpt(q.statement) || <em className="ui-muted">Empty statement</em>}</span>
                    <span className="ui-muted pr-item__topics">{q.topicIds.map((id) => topicList.find((t) => t.id === id)?.name).filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        {selected && <QuestionEditor key={selected.id} q={selected} pid={pid} topics={topicList} chapters={manuscript.data ?? []} onClose={() => select(null)} />}
      </div>
    </div>
  );
}

function Coverage({ questions, topics, tab, target, onPick, active }: { questions: Question[]; topics: Topic[]; tab: QuestionKind; target?: { exercisesPerTopic: number; exercisesPerHotTopic: number }; onPick: (id: string) => void; active: string }) {
  if (topics.length === 0) return null;
  return (
    <section aria-label="Coverage per topic" className="pr-cov">
      <h2 className="ui-meta">{tab === 'exercise' ? 'Exercises per topic: actual of target' : 'Exam questions per topic'}</h2>
      <ul className="pr-cov__list">
        {topics.map((t) => {
          const actual = questions.filter((q) => q.topicIds.includes(t.id)).length;
          const goal = tab === 'exercise' && target ? (t.priority === 'high' ? target.exercisesPerHotTopic : target.exercisesPerTopic) : 0;
          const pct = goal ? Math.min(100, Math.round((actual / goal) * 100)) : actual ? 100 : 0;
          const short = goal > 0 && actual < goal;
          return (
            <li key={t.id}>
              <button type="button" className={`pr-cov__item${short ? ' is-short' : ''}`} aria-pressed={active === t.id} onClick={() => onPick(t.id)} title={`Filter by ${t.name}`}>
                <span className="pr-cov__name ui-wrap">{t.name}{t.priority === 'high' && <span className="ui-badge ui-badge--accent">high</span>}</span>
                <span className="pr-cov__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                <span className="pr-cov__n ui-mono">{goal ? `${actual}/${goal}` : actual}<span className="ui-sr"> of {goal || 'no target'}</span></span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Field = 'statement' | 'hint' | 'solution';

function QuestionEditor({ q, pid, topics, chapters, onClose }: { q: Question; pid: string; topics: Topic[]; chapters: { chapterId: string; number: number; title: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState({ statement: q.statement, hint: q.hint, solution: q.solution, difficulty: q.difficulty, origin: q.origin, topicIds: q.topicIds, chapterId: q.chapterId });
  const [rev, setRev] = useState(q.rev);
  const [field, setField] = useState<Field>('statement');
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = draft.statement !== q.statement || draft.hint !== q.hint || draft.solution !== q.solution || draft.difficulty !== q.difficulty || draft.origin !== q.origin || draft.chapterId !== q.chapterId || draft.topicIds.join() !== q.topicIds.join();

  const save = useMutation({
    mutationFn: () => api('PATCH /api/questions/:qid', { params: { qid: q.id }, body: { ...draft, rev } }),
    onSuccess: (next) => { setRev(next.rev); setConflict(null); qc.setQueryData(qk.questions(pid), (old: Question[] | undefined) => old?.map((x) => (x.id === next.id ? next : x))); toast('Question saved'); },
    onError: (e) => { if (isConflict(e)) setConflict(errorText(e)); else toast(errorText(e), { tone: 'danger' }); },
  });
  const verify = useMutation({
    mutationFn: () => api('POST /api/questions/:qid/verify', { params: { qid: q.id } }),
    onSuccess: () => { toast('Verification started', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE /api/questions/:qid', { params: { qid: q.id } }),
    onSuccess: () => { toast('Question deleted'); void qc.invalidateQueries({ queryKey: qk.questions(pid) }); setConfirmDelete(false); onClose(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const loadLatest = async () => {
    const list = await qc.fetchQuery({ queryKey: qk.questions(pid), queryFn: () => api('GET /api/projects/:id/questions', { params: { id: pid } }), staleTime: 0 });
    const fresh = list.find((x) => x.id === q.id);
    // The fields take the latest text too: saving the old draft with the new rev would overwrite the other change.
    if (fresh) {
      setDraft({ statement: fresh.statement, hint: fresh.hint, solution: fresh.solution, difficulty: fresh.difficulty, origin: fresh.origin, topicIds: fresh.topicIds, chapterId: fresh.chapterId });
      setRev(fresh.rev);
      setConflict(null);
    }
  };

  return (
    <section className="pr-editor ui-card" aria-label="Question editor">
      <header className="pr-editor__head">
        <div className="ui-grow">
          <div className="ui-meta">{q.kind === 'exam' ? 'Exam question' : 'Exercise'}{q.examGroup ? ` · ${q.examGroup}` : ''}</div>
          <h2 className="ui-panel-title">{q.number ? `Question ${q.number}` : 'Question'}</h2>
        </div>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label="Close editor" onClick={onClose}><Icon name="x" /></button>
      </header>

      {conflict && (
        <div className="ui-banner ui-banner--warning" role="alert">
          <div className="ui-banner__body"><span className="ui-banner__title">This question changed since you opened it</span><span>{conflict}</span>
            <div className="ui-banner__actions"><button type="button" className="ui-btn ui-btn--sm" onClick={() => void loadLatest()}>Load latest</button></div></div>
        </div>
      )}

      <div className="ui-tabs" role="tablist" aria-label="Question part">
        {(q.kind === 'exam' ? ['statement', 'solution'] as Field[] : ['statement', 'hint', 'solution'] as Field[]).map((f) => <button key={f} type="button" role="tab" className="ui-tab" aria-selected={field === f} onClick={() => setField(f)}>{f[0].toUpperCase() + f.slice(1)}{draft[f] ? '' : ' (empty)'}</button>)}
      </div>
      <SourceEditor key={field} value={draft[field]} onChange={(v) => setDraft((d) => ({ ...d, [field]: v }))} label={`${field} source`} minRows={5} />
      <LivePreview source={draft[field]} label={`Preview of the ${field}`} />

      <div className="pr-meta">
        <label className="ui-field"><span className="ui-field__label">Difficulty</span>
          <select className="ui-select ui-select--sm" value={draft.difficulty} onChange={(e) => setDraft((d) => ({ ...d, difficulty: e.target.value as Difficulty }))}>{DIFFS.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="ui-field"><span className="ui-field__label">Origin</span>
          <select className="ui-select ui-select--sm" value={draft.origin} onChange={(e) => setDraft((d) => ({ ...d, origin: e.target.value as QuestionOrigin }))}>{ORIGINS.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="ui-field"><span className="ui-field__label">Chapter</span>
          <select className="ui-select ui-select--sm" value={draft.chapterId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, chapterId: e.target.value || null }))}>
            <option value="">None</option>{chapters.map((c) => <option key={c.chapterId} value={c.chapterId}>{c.number}. {c.title}</option>)}</select></label>
      </div>
      <details className="pr-topics">
        <summary>Topics ({draft.topicIds.length})</summary>
        <div className="pr-topics__list" role="group" aria-label="Topics">
          {topics.map((t) => (
            <label key={t.id} className="ui-check"><input type="checkbox" checked={draft.topicIds.includes(t.id)} onChange={(e) => setDraft((d) => ({ ...d, topicIds: e.target.checked ? [...d.topicIds, t.id] : d.topicIds.filter((x) => x !== t.id) }))} /><span className="ui-wrap">{t.name}</span></label>
          ))}
          {topics.length === 0 && <span className="ui-muted">No topics yet.</span>}
        </div>
      </details>

      <section aria-label="Checks" className="pr-checks">
        <div className="ui-row"><h3 className="ui-meta">Checks</h3><span className={`ui-badge ui-badge--${STATUS_TONE[q.status] || 'neutral'}`}>{q.status}</span></div>
        {q.checks.length === 0 ? <p className="ui-muted">No checks have run on this question.</p> : (
          <ul className="pr-checks__list">
            {q.checks.map((c, i) => (
              <li key={i} className={`pr-check${c.ok ? ' is-ok' : ' is-bad'}`}>
                <Icon name={c.ok ? 'check' : 'x'} size={14} />
                <span><strong>{c.method}</strong>{c.model ? <span className="ui-muted ui-mono"> · {c.model}</span> : null} — {c.ok ? 'passed' : 'failed'}<br /><span className="ui-muted ui-wrap">{c.detail}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ui-row pr-actions">
        <button type="button" className="ui-btn ui-btn--accent" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save question</button>
        <button type="button" className="ui-btn" disabled={verify.isPending || dirty} title={dirty ? 'Save first' : undefined} onClick={() => verify.mutate()}><Icon name="refresh" />Verify again</button>
        <span className="ui-grow" />
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" />Delete</button>
      </div>
      <ConfirmDialog open={confirmDelete} title="Delete question" message="This question is removed from the book and cannot be restored." confirmLabel="Delete question" danger busy={remove.isPending} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} />
    </section>
  );
}
