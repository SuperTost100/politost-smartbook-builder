import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SUBJECT_AREAS, SUBJECT_PROFILES, inferSubjectArea, type BookOptions, type FigureKind, type ProjectInput, type SubjectArea } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useProject } from '../../lib/queries';
import { slugify } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { ProgramCard } from './ProgramCard';
import './setup.css';

const DEFAULT_OPTIONS: BookOptions = {
  outsideMaterial: false, ide: true, labLanguage: 'python', graphs: true, figures: true, firstChapterGate: true, outlineGate: true,
  exercisesPerTopic: 3, exercisesPerHotTopic: 6, chapterScope: [], offProgram: 'delete', noClaudeFallback: false, figurePolicy: 'helpful', circuitSymbols: 'american',
};

type LangChoice = 'it' | 'en' | 'other';

const AREA_LABEL: Record<SubjectArea, string> = {
  mathematics: 'Mathematics', physics: 'Physics', chemistry: 'Chemistry', electronics: 'Electronics', 'computer-science': 'Computer science', mechanics: 'Mechanics', other: 'Other',
};
// A Record over FigureKind, so a kind added to the domain table cannot be shown without a name here.
const KIND_LABEL: Record<FigureKind, string> = {
  plot: 'function plots', structure: 'molecule structures', levels: 'energy-level diagrams', orbitals: 'orbital boxes', cell: 'electrochemical cells', periodic: 'periodic table highlights', photo: 'photos',
};
// shortcut: the domain profile does not say which subjects have circuits, so the two that do are listed here. Move it into the profile when the figure drawing agent adds circuit figures.
const CIRCUIT_AREAS: readonly SubjectArea[] = ['electronics', 'physics'];
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Resistor({ kind }: { kind: 'american' | 'european' }) {
  return (
    <svg width="64" height="22" viewBox="0 0 64 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'american' ? <path d="M2 11h10l3-7 6 14 6-14 6 14 6-14 3 7h18" /> : <><path d="M2 11h14M46 11h16" /><rect x="16" y="4" width="30" height="14" /></>}
    </svg>
  );
}

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

  const area: SubjectArea = opts.subjectArea ?? inferSubjectArea(subject, title);
  const profile = SUBJECT_PROFILES[area];
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
          <label className="ui-field__label" htmlFor="su-area">Subject area</label>
          <select id="su-area" className="ui-select su-area" value={area} onChange={(e) => set('subjectArea', e.target.value as SubjectArea)} aria-describedby="su-area-hint">
            {SUBJECT_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
          </select>
          <span id="su-area-hint" className="ui-field__hint">{opts.subjectArea ? 'Sets which figures the writer may draw and which notation the outline settles. You can still change every option below.' : `Taken from the subject and the title, because no area is chosen. Choosing one fixes it. It sets which figures the writer may draw and which notation the outline settles.`}</span>
          <dl className="su-area-effects" aria-label={`What ${AREA_LABEL[area]} sets`}>
            <dt>Figure kinds</dt><dd>{upper(profile.figureKinds.map((k) => KIND_LABEL[k]).join(', '))}</dd>
            <dt>Notation hints</dt><dd>{upper(profile.notation)}</dd>
          </dl>
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

      {editing ? <ProgramCard pid={id!} /> : (
        <section className="ui-card ui-card--pad su-section" aria-labelledby="su-program-later">
          <h2 id="su-program-later" className="ui-panel-title">Course program</h2>
          <p className="ui-field__hint">After you create the book, come back to Book setup to add its course program. The outline and the alignment check use it.</p>
        </section>
      )}

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-opts">
        <h2 id="su-opts" className="ui-panel-title">What goes in the book</h2>
        <Toggle label="Use verified outside material" hint="Allow explanations that go beyond your sources, when they can be verified. Off keeps the book to your material." checked={opts.outsideMaterial} onChange={(v) => set('outsideMaterial', v)} />
        <Toggle label="IDE examples" checked={opts.ide} onChange={(v) => set('ide', v)} />
        {opts.ide && (
          <fieldset className="su-fieldset">
            <legend className="ui-field__label">Lab language</legend>
            <div className="ui-row" role="radiogroup" aria-label="Lab language">
              {([['python', 'Python'], ['matlab', 'MATLAB']] as const).map(([v, l]) => (
                <label key={v} className="ui-check"><input type="radio" name="su-lab" checked={opts.labLanguage === v} onChange={() => set('labLanguage', v)} />{l}</label>
              ))}
            </div>
            <p className="ui-field__hint">A MATLAB book gets up to one example per section, and the text writes commands as inline code. A Python book gets one example per chapter.</p>
          </fieldset>
        )}
        <Toggle label="Graphs" checked={opts.graphs} onChange={(v) => set('graphs', v)} />
        <Toggle label="Figures" checked={opts.figures} onChange={(v) => set('figures', v)} />
        <div className="su-sub">
          <fieldset className="su-fieldset" disabled={!opts.figures}>
            <legend className="ui-field__label">How many figures</legend>
            <div className="ui-stack su-stack" role="radiogroup" aria-label="How many figures">
              {([
                ['helpful', 'Where they help', 'A figure when the text is hard to follow without one. Usually one or two per section.'],
                ['generous', 'Generous', 'Also for definitions and worked examples that a picture would make quicker to read. Up to 3 per section.'],
              ] as const).map(([v, l, d]) => (
                <label key={v} className="su-radio"><input type="radio" name="su-amount" checked={opts.figurePolicy === v} onChange={() => set('figurePolicy', v)} /><span><strong>{l}</strong><br /><span className="ui-muted">{d}</span></span></label>
              ))}
            </div>
          </fieldset>
          {CIRCUIT_AREAS.includes(area) && (
            <fieldset className="su-fieldset" disabled={!opts.figures}>
              <legend className="ui-field__label">Circuit symbols</legend>
              <div className="su-symbols" role="radiogroup" aria-label="Circuit symbols">
                {([['american', 'American', 'Zigzag resistor'], ['european', 'European', 'Rectangle resistor']] as const).map(([v, l, d]) => (
                  <label key={v} className="su-sym"><input type="radio" name="su-sym" checked={opts.circuitSymbols === v} onChange={() => set('circuitSymbols', v)} /><Resistor kind={v} /><span><strong>{l}</strong><small>{d}</small></span></label>
                ))}
              </div>
              <p className="ui-field__hint">Applies to resistors, and to the other parts that have two symbol families. The course notes you uploaded are not redrawn.</p>
            </fieldset>
          )}
        </div>
        <fieldset className="su-fieldset">
          <legend className="ui-field__label">Sections outside the course program</legend>
          <div className="ui-row" role="radiogroup" aria-label="Sections outside the course program">
            {([['delete', 'Remove off-program sections'], ['mark', 'Keep them with a note']] as const).map(([v, l]) => (
              <label key={v} className="ui-check"><input type="radio" name="su-off" checked={opts.offProgram === v} onChange={() => set('offProgram', v)} />{l}</label>
            ))}
          </div>
          <p className="ui-field__hint">What Align book does with a section the program does not ask for. Removed sections stay in the outline history. A kept section starts with a note that the exam does not ask it.</p>
        </fieldset>
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

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-gen">
        <h2 id="su-gen" className="ui-panel-title">Generation</h2>
        <fieldset className="su-fieldset">
          <legend className="ui-field__label">When Claude usage runs out</legend>
          <div className="ui-stack su-stack" role="radiogroup" aria-label="When Claude usage runs out">
            {([
              [false, 'Continue on the fallback model', 'The work goes on with the fallback model of each job, as set in Connections. The wording can change from one section to the next.'],
              [true, 'Pause until it resets', 'Drafting stops and starts again by itself when the Claude window resets. Choose this when the book must keep one voice.'],
            ] as const).map(([v, l, d]) => (
              <label key={l} className="su-radio"><input type="radio" name="su-quota" checked={opts.noClaudeFallback === v} onChange={() => set('noClaudeFallback', v)} /><span><strong>{l}</strong><br /><span className="ui-muted">{d}</span></span></label>
            ))}
          </div>
          <p className="ui-field__hint">This choice wins over the fallbacks set in Connections, for this book only. While a book is paused for usage, the Run panel says when it starts again.</p>
        </fieldset>
      </section>

      {error && <div className="ui-banner ui-banner--danger" role="alert"><div className="ui-banner__body"><span className="ui-banner__title">The book was not saved</span><span>{error}</span></div></div>}

      <div className="ui-row su-actions">
        <button type="submit" className="ui-btn ui-btn--accent" disabled={!valid || save.isPending}>{editing ? 'Save setup' : 'Create book'}</button>
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
