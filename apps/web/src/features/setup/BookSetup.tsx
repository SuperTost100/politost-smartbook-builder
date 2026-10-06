import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BookOptions, ProjectInput } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useProject } from '../../lib/queries';
import { slugify } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import './setup.css';

const DEFAULT_OPTIONS: BookOptions = {
  outsideMaterial: false, ide: true, graphs: true, figures: true, firstChapterGate: true, outlineGate: true,
  exercisesPerTopic: 3, exercisesPerHotTopic: 6, chapterScope: [],
};

type LangChoice = 'it' | 'en' | 'other';

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="su-toggle">
      <label className="ui-switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="ui-switch__track" aria-hidden="true" />
        <span>{label}</span>
      </label>
      {hint && <p className="ui-field__hint">{hint}</p>}
    </div>
  );
}

export default function BookSetup() {
  const { id } = useParams();
  const editing = !!id;
  useDocumentTitle(editing ? 'Book setup' : 'New book');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject(id);

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [authors, setAuthors] = useState('');
  const [lang, setLang] = useState<LangChoice>('it');
  const [otherLang, setOtherLang] = useState('');
  const [audience, setAudience] = useState('');
  const [goals, setGoals] = useState('');
  const [opts, setOpts] = useState<BookOptions>(DEFAULT_OPTIONS);
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = project.data;
    if (!editing || !p || loaded) return;
    setTitle(p.title); setSubject(p.subject); setSlug(p.slug); setSlugTouched(true);
    setAuthors(p.authors.join(', '));
    if (p.language === 'it' || p.language === 'en') setLang(p.language);
    else { setLang('other'); setOtherLang(p.language); }
    setAudience(p.audience); setGoals(p.goals);
    setOpts({ ...DEFAULT_OPTIONS, ...p.options });
    setLoaded(true);
  }, [editing, project.data, loaded]);

  const onTitle = (v: string) => { setTitle(v); if (!slugTouched) setSlug(slugify(v)); };
  const set = <K extends keyof BookOptions>(k: K, v: BookOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const language = lang === 'other' ? otherLang.trim() : lang;
  const authorList = authors.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean);
  const slugValid = /^[a-z0-9-]+$/.test(slug) && slug.length > 0;
  const valid = title.trim() && subject.trim() && slugValid && language.length >= 2;

  const save = useMutation({
    mutationFn: async () => {
      const body: ProjectInput = { title: title.trim(), subject: subject.trim(), slug, authors: authorList, language, audience, goals, options: opts };
      if (editing) return api('PATCH /api/projects/:id', { params: { id: id! }, body });
      return api('POST /api/projects', { body });
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: qk.project(p.id) });
      toast(editing ? 'Book setup saved' : 'Book created');
      navigate(editing ? `/books/${p.id}/sources` : `/books/${p.id}/sources`);
    },
    onError: (e) => setError(errorText(e)),
  });

  const submit = (e: FormEvent) => { e.preventDefault(); setError(null); if (valid) save.mutate(); };

  if (editing && project.isLoading) return <div className="ui-page ui-page--narrow"><div className="ui-skeleton" style={{ height: 300 }} /></div>;
  if (editing && project.error) return <div className="ui-page ui-page--narrow"><div className="ui-banner ui-banner--danger" role="alert">{errorText(project.error)}</div></div>;

  return (
    <form className="ui-page ui-page--narrow su-form" onSubmit={submit} noValidate>
      <div className="ui-page__head">
        <h1 className="ui-screen-title">{editing ? 'Book setup' : 'New book'}</h1>
      </div>

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-about">
        <h2 id="su-about" className="ui-panel-title">About the book</h2>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="su-title">Title</label>
          <input id="su-title" className="ui-input" value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Analisi matematica 1" required autoFocus={!editing} />
        </div>
        <div className="su-two">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="su-subject">Subject</label>
            <input id="su-subject" className="ui-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Analisi matematica" required />
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="su-slug">Slug</label>
            <input id="su-slug" className="ui-input ui-input--mono" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} aria-invalid={!!slug && !slugValid} aria-describedby="su-slug-hint" />
            <span id="su-slug-hint" className={`ui-field__hint${slug && !slugValid ? ' su-bad' : ''}`}>Lowercase letters, digits and hyphens. It names the exported file.</span>
          </div>
        </div>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="su-authors">Authors</label>
          <input id="su-authors" className="ui-input" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Separate names with commas" />
        </div>
        <fieldset className="su-fieldset">
          <legend className="ui-field__label">Book language</legend>
          <div className="ui-row" role="radiogroup" aria-label="Book language">
            {([['it', 'Italian'], ['en', 'English'], ['other', 'Other…']] as const).map(([v, l]) => (
              <label key={v} className="ui-check"><input type="radio" name="su-lang" checked={lang === v} onChange={() => setLang(v)} />{l}</label>
            ))}
            {lang === 'other' && <input className="ui-input ui-input--sm su-lang-other" aria-label="Language name or code" value={otherLang} onChange={(e) => setOtherLang(e.target.value)} placeholder="fr" />}
          </div>
        </fieldset>
      </section>

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-readers">
        <h2 id="su-readers" className="ui-panel-title">Readers and goals</h2>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="su-aud">Audience</label>
          <textarea id="su-aud" className="ui-textarea" rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Primo anno di Ingegneria, nessuna base di analisi" />
        </div>
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="su-goals">Goals</label>
          <textarea id="su-goals" className="ui-textarea" rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="Passare l'esame scritto; capire le dimostrazioni principali" />
        </div>
      </section>

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-opts">
        <h2 id="su-opts" className="ui-panel-title">What goes in the book</h2>
        <Toggle label="Use verified outside material" hint="Allow explanations that go beyond your sources, when they can be verified. Off keeps the book to your material." checked={opts.outsideMaterial} onChange={(v) => set('outsideMaterial', v)} />
        <Toggle label="IDE examples" checked={opts.ide} onChange={(v) => set('ide', v)} />
        <Toggle label="Graphs" checked={opts.graphs} onChange={(v) => set('graphs', v)} />
        <Toggle label="Figures" checked={opts.figures} onChange={(v) => set('figures', v)} />
        <Toggle label="Outline approval gate" hint="Drafting waits until you approve the outline." checked={opts.outlineGate} onChange={(v) => set('outlineGate', v)} />
        <Toggle label="First-chapter approval gate" hint="Chapters after the first wait until you approve chapter 1." checked={opts.firstChapterGate} onChange={(v) => set('firstChapterGate', v)} />
      </section>

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-ex">
        <h2 id="su-ex" className="ui-panel-title">Exercise targets</h2>
        <div className="su-two">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="su-ept">Exercises per topic</label>
            <input id="su-ept" type="number" min={0} max={20} className="ui-input" value={opts.exercisesPerTopic} onChange={(e) => set('exercisesPerTopic', clamp(e.target.value, 0, 20))} />
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="su-eph">Exercises per high-priority topic</label>
            <input id="su-eph" type="number" min={0} max={30} className="ui-input" value={opts.exercisesPerHotTopic} onChange={(e) => set('exercisesPerHotTopic', clamp(e.target.value, 0, 30))} />
          </div>
        </div>
      </section>

      {error && <div className="ui-banner ui-banner--danger" role="alert"><div className="ui-banner__body"><span className="ui-banner__title">The book was not saved</span><span>{error}</span></div></div>}

      <div className="ui-row su-actions">
        <button type="submit" className="ui-btn ui-btn--primary" disabled={!valid || save.isPending}>{editing ? 'Save setup' : 'Create book'}</button>
        <button type="button" className="ui-btn" onClick={() => navigate(editing ? `/books/${id}/sources` : '/')}>Cancel</button>
        {!valid && <span className="ui-muted su-why">{!title.trim() ? 'Add a title.' : !subject.trim() ? 'Add a subject.' : !slugValid ? 'Fix the slug.' : 'Add a language.'}</span>}
      </div>
    </form>
  );
}

function clamp(v: string, lo: number, hi: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo;
}
