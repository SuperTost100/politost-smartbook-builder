import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SUBJECT_AREAS, SUBJECT_PROFILES, inferSubjectArea, type BookOptions, type FigureKind, type ProjectInput, type SubjectArea } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useProject } from '../../lib/queries';
import { slugify } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { ProgramCard } from './ProgramCard';
import { changedFields, splitAuthors, wholeNumberIn, type SetupValues } from './form';
import './setup.css';

const DEFAULT_OPTIONS: BookOptions = {
  outsideMaterial: false, ide: true, labLanguage: 'python', graphs: true, figures: true, firstChapterGate: true, outlineGate: true,
  exercisesPerTopic: 3, exercisesPerHotTopic: 6, chapterScope: [], offProgram: 'delete', noClaudeFallback: false, selfCheck: true, reviewSamples: 2, figurePolicy: 'helpful', circuitSymbols: 'american',
};

type LangChoice = 'it' | 'en' | 'other';

/** The number fields and the range each accepts, the same as the options schema of the service. */
const NUMBERS = { exercisesPerTopic: [0, 20], exercisesPerHotTopic: [0, 30], reviewSamples: [1, 5] } as const;
type NumberKey = keyof typeof NUMBERS;
const numberTexts = (o: BookOptions) => ({ exercisesPerTopic: String(o.exercisesPerTopic), exercisesPerHotTopic: String(o.exercisesPerHotTopic), reviewSamples: String(o.reviewSamples) });
const numberOk = (texts: Record<NumberKey, string>, k: NumberKey) => wholeNumberIn(texts[k], NUMBERS[k][0], NUMBERS[k][1]) !== null;

const AREA_LABEL: Record<SubjectArea, string> = {
  mathematics: 'Mathematics', physics: 'Physics', chemistry: 'Chemistry', electronics: 'Electronics', 'computer-science': 'Computer science', mechanics: 'Mechanics', other: 'Other',
};
// A Record over FigureKind, so a kind added to the domain table cannot be shown without a name here.
const KIND_LABEL: Record<FigureKind, string> = {
  plot: 'function plots', structure: 'molecule structures', levels: 'energy-level diagrams', orbitals: 'orbital boxes', cell: 'electrochemical cells', periodic: 'periodic table highlights', drawing: 'drawings (circuits, diagrams, sketches)', photo: 'photos',
};
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
  // What the number fields show, which can be text the options cannot hold (empty, 2.5) until the author corrects it.
  const [numText, setNumText] = useState<Record<NumberKey, string>>(numberTexts(DEFAULT_OPTIONS));
  // The book as this form loaded it: a save sends only what differs from it.
  const loadedValues = useRef<SetupValues | null>(null);
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
    const options = { ...DEFAULT_OPTIONS, ...p.options };
    setOpts(options);
    setNumText(numberTexts(options));
    // Read the way the form saves it, so a field left alone compares equal: a stored "Doe, Jane" shows as two names and is
    // sent only when the author edits the field.
    loadedValues.current = { title: p.title.trim(), subject: p.subject.trim(), slug: p.slug, authors: splitAuthors(p.authors.join(', ')), language: p.language, audience: p.audience, goals: p.goals, options };
    setLoaded(true);
  }, [editing, project.data, loaded]);

  const onTitle = (v: string) => { setTitle(v); if (!slugTouched) setSlug(slugify(v)); };
  const set = <K extends keyof BookOptions>(k: K, v: BookOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const setNumber = (k: NumberKey, text: string) => {
    setNumText((t) => ({ ...t, [k]: text }));
    const n = wholeNumberIn(text, NUMBERS[k][0], NUMBERS[k][1]);
    if (n !== null) set(k, n);
  };
  const numbersValid = (Object.keys(NUMBERS) as NumberKey[]).every((k) => numberOk(numText, k));
  const numberField = (k: NumberKey, id: string, label: string, hint?: string, narrow?: boolean) => {
    const bad = !numberOk(numText, k);
    const [lo, hi] = NUMBERS[k];
    return (
      <div className="ui-field">
        <label className="ui-field__label" htmlFor={id}>{label}</label>
        <input id={id} type="number" min={lo} max={hi} step={1} className={`ui-input${narrow ? ' su-narrow' : ''}`} value={numText[k]} onChange={(e) => setNumber(k, e.target.value)}
          aria-invalid={bad} aria-describedby={[bad && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined} />
        {bad && <span id={`${id}-error`} className="ui-field__hint su-bad">Enter a whole number from {lo} to {hi}.</span>}
        {hint && <p id={`${id}-hint`} className="ui-field__hint">{hint}</p>}
      </div>
    );
  };

  const inferred = inferSubjectArea(subject, title);
  const area: SubjectArea = opts.subjectArea ?? inferred;
  const profile = SUBJECT_PROFILES[area];
  const language = lang === 'other' ? otherLang.trim() : lang;
  const authorList = splitAuthors(authors);
  const slugValid = /^[a-z0-9-]+$/.test(slug) && slug.length > 0;
  const valid = title.trim() && subject.trim() && slugValid && language.length >= 2 && numbersValid;

  const save = useMutation({
    mutationFn: async () => {
      const body: ProjectInput = { title: title.trim(), subject: subject.trim(), slug, authors: authorList, language, audience, goals, options: opts };
      if (editing) return api('PATCH /api/projects/:id', { params: { id: id! }, body: changedFields(loadedValues.current!, { ...body, options: opts }) });
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
          <select id="su-area" className="ui-select su-area" value={opts.subjectArea ?? ''} onChange={(e) => set('subjectArea', e.target.value ? e.target.value as SubjectArea : undefined)} aria-describedby="su-area-hint">
            <option value="">Automatic ({AREA_LABEL[inferred]})</option>
            {SUBJECT_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
          </select>
          <span id="su-area-hint" className="ui-field__hint">{opts.subjectArea ? 'Sets which figures the writer may draw and which notation the outline settles. You can still change every option below.' : `Automatic follows the subject and the title, so editing either can change the area. Choosing an area fixes it. It sets which figures the writer may draw and which notation the outline settles.`}</span>
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
          {profile.hasCircuits && (
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
          {numberField('exercisesPerTopic', 'su-ept', 'Exercises per topic')}
          {numberField('exercisesPerHotTopic', 'su-eph', 'Exercises per high-priority topic')}
        </div>
      </section>

      <section className="ui-card ui-card--pad su-section" aria-labelledby="su-gen">
        <h2 id="su-gen" className="ui-panel-title">Generation</h2>
        <fieldset className="su-fieldset">
          <legend className="ui-field__label">When Claude usage runs out</legend>
          <div className="ui-stack su-stack" role="radiogroup" aria-label="When Claude usage runs out">
            {([
              [false, 'Continue on the fallback model', 'The work goes on with the fallback model of each job, as set in Connections. The wording can change from one section to the next.'],
              [true, 'Pause until it resets', 'A usage limit stops the run, and it starts again by itself when the Claude window resets. Choose this when the book must keep one voice.'],
            ] as const).map(([v, l, d]) => (
              <label key={l} className="su-radio"><input type="radio" name="su-quota" checked={opts.noClaudeFallback === v} onChange={() => set('noClaudeFallback', v)} /><span><strong>{l}</strong><br /><span className="ui-muted">{d}</span></span></label>
            ))}
          </div>
          <p className="ui-field__hint">With this choice, the jobs that start on Claude never use their fallback for this book, whatever the fallbacks in Connections say. A usage limit pauses the run until it resets, and the Run panel says when. Any other failure, such as a timeout, is retried and then stops the task.</p>
        </fieldset>
        {numberField('reviewSamples', 'su-samples', 'Reviewer reads per chapter', "How many independent reviewer calls read a whole chapter, in its first review and once more after the fixes of that review. Each call finds a different part of the errors: in a test on known errors, 2 calls found 6 to 9 of 9 and 3 calls found 8 or 9. The cross review adds one call on another model. Use 3 for a book that must be clean; each extra call costs about 95k input tokens of the reviewer's model per chapter.", true)}
      </section>

      {error && <div className="ui-banner ui-banner--danger" role="alert"><div className="ui-banner__body"><span className="ui-banner__title">The book was not saved</span><span>{error}</span></div></div>}

      <div className="ui-row su-actions">
        <button type="submit" className="ui-btn ui-btn--accent" disabled={!valid || save.isPending}>{editing ? 'Save setup' : 'Create book'}</button>
        <button type="button" className="ui-btn" onClick={() => navigate(editing ? `/books/${id}/sources` : '/')}>Cancel</button>
        {!valid && <span className="ui-muted su-why">{!title.trim() ? 'Add a title.' : !subject.trim() ? 'Add a subject.' : !slugValid ? 'Fix the slug.' : !numbersValid ? 'Fix the number marked above.' : 'Add a language.'}</span>}
      </div>
    </form>
  );
}
