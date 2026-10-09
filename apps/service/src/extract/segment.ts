// Split exam and exercise PDFs into authentic questions using the text layer only.
// Statements and solutions are the raw text (math may be garbled); they are re-transcribed from page images later.
import type { Question } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { ExtractError } from './errors.ts';

export type QuestionRow = Omit<Question, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'rev'>;

interface PageText { idx: number; text: string }

const MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8,
  settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};
const MONTH_NAMES = Object.keys(MONTHS);

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const LEADERS = /(?:\.\s?){4,}/;

interface Line { page: number; text: string }

function pageLines(pages: PageText[]): Line[] {
  const out: Line[] = [];
  for (const p of pages) {
    const raw = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
    let kept = 0;
    raw.forEach((l, i) => {
      // Page numbers sit among the first lines; section numbers sit right before a session heading.
      if (/^\d{1,3}$/.test(l) && (kept < 3 || /^Esame\s+(del|di)\b/i.test(raw[i + 1] ?? ''))) return;
      if (/^Esami scritti di Analisi/i.test(l)) return;
      if (/^(c\S{0,2}\s*)?\d{4}\s+Politecnico di Torino$/i.test(l) || /^Politecnico di Torino$/i.test(l)) return;
      kept++;
      out.push({ page: p.idx, text: l });
    });
  }
  return out;
}

interface Heading { key: string; date: string | null; numbered: boolean; variant?: string | null }

/** Parse a session heading line. `next` is the following non-empty line (to spot table-of-contents entries). `label` names the file. */
function parseHeading(l: string, following: string[], page: number, label: string): Heading | null {
  const next = following[0];
  // Cover of a paper without the dated header line: "Esame di ANALISI MATEMATICA I" then "11 aprile 2024, ore 17:30".
  if (/^Esame\s+di\s+ANALISI\s+MATEMATICA\s+I\s*$/i.test(l)) {
    const d = /^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})\b/.exec(next ?? '');
    const month = d ? MONTHS[d[2].toLowerCase()] : undefined;
    if (d && month) return { key: `Esame del ${Number(d[1])} ${MONTH_NAMES[month - 1]} ${d[3]}`, date: iso(Number(d[3]), month, Number(d[1])), numbered: false };
    if (following.slice(0, 8).some((f) => /^Esercizio\s+1\b/i.test(f))) {
      return { key: `Esame di Analisi Matematica I (senza data, pagina ${page + 1})`, date: null, numbered: false };
    }
    return null;
  }
  const old = /^(?:(\d+)\s+)?Esame\s+del\s+(\d{1,2})\s*[°º]?\s*([A-Za-zÀ-ÿ]+)\s+(\d{4})\b(.*)$/i.exec(l);
  if (old) {
    const month = MONTHS[old[3].toLowerCase()];
    if (!month) return null;
    const rest = old[5];
    if (LEADERS.test(rest) || (next && /^(?:\.\s?){4,}/.test(next))) return null;
    const turn = rest.replace(/^[\s\-–—:,]+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim();
    const d = Number(old[2]);
    return {
      key: `Esame del ${d} ${MONTH_NAMES[month - 1]} ${old[4]}${turn ? ` - ${turn}` : ''}`,
      date: iso(Number(old[4]), month, d),
      numbered: old[1] !== undefined,
    };
  }
  const nw = /^Esame\s+di\s+ANALISI\s+MATEMATICA\s+I\b\D{0,3}?(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/i.exec(l);
  if (nw) {
    const [d, m, y] = [Number(nw[1]), Number(nw[2]), Number(nw[3])];
    if (m < 1 || m > 12) return null;
    const turn = nw[4].replace(/^[\s\-–—:,]+/, '').replace(/\s+/g, ' ').trim();
    return { key: `Esame del ${d} ${MONTH_NAMES[m - 1]} ${y}${turn ? ` - ${turn}` : ''}`, date: iso(y, m, d), numbered: false };
  }
  return parsePaper(l, following, label);
}

/**
 * One paper per file (Fisica 1): "Prova scritta 23/06/2022 - Corso … - Prof. …", then "Compito FILA A".
 * The date may be d.m.yy or lack the year (taken from the file name); blank templates are named after the file.
 * The compito (fila) becomes the exercise variant, so fila A and fila B of one day count as a single session.
 */
function parsePaper(l: string, following: string[], label: string): Heading | null {
  const m = /^Prova\s+scritta\b(.*)$/i.exec(l);
  if (!m) return null;
  const fila = /\bCompito\s+(?:fila\s+)?([A-Z]\d?)\b/i.exec([m[1], ...following.slice(0, 2)].join('\n'));
  const variant = fila ? fila[1].toUpperCase() : null;
  const dm = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2})(?!\d))?/.exec(m[1]);
  const year = dm?.[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : Number(/\b(?:19|20)\d{2}\b/.exec(label)?.[0] ?? NaN);
  const [d, mo] = dm ? [Number(dm[1]), Number(dm[2])] : [0, 0];
  if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && year) {
    return { key: `Prova scritta del ${d} ${MONTH_NAMES[mo - 1]} ${year}`, date: iso(year, mo, d), numbered: false, variant };
  }
  return { key: label ? `Prova scritta - ${label}` : 'Prova scritta', date: null, numbered: false, variant };
}

interface Ex { num: number; variant: string | null; startPage: number; endPage: number; lines: string[] }
interface Group { key: string; date: string | null; variant: string | null; statements: Ex[]; solutions: Ex[] }

function variantOf(rest: string): string | null {
  const v = /\bversione\s+([A-Z])\b/i.exec(rest);
  if (v) return v[1].toUpperCase();
  const k = /\bvariante\s+(\d+)\b/i.exec(rest);
  return k ? `v${k[1]}` : null;
}

const numberLabel = (e: Ex) => (e.variant ? (e.variant.startsWith('v') ? `${e.num}.${e.variant.slice(1)}` : `${e.num}${e.variant}`) : String(e.num));

function joinLines(lines: string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface SegmentOptions {
  /** File name without extension: names undated papers and supplies a missing year. */
  label?: string;
  kind?: 'exam' | 'exercise';
  /** With no session heading anywhere in the file, the whole file is one group named after `label`. */
  untitled?: boolean;
}

export function segmentExams(resourceId: string, pages: PageText[], opts: SegmentOptions = {}): QuestionRow[] {
  const { label = '', kind = 'exam' } = opts;
  const lines = pageLines(pages);
  const heads = lines.map((x, i) => parseHeading(x.text, lines.slice(i + 1, i + 9).map((y) => y.text), x.page, label));
  const untitled = !!opts.untitled && !!label && !heads.some(Boolean);
  const groups: Group[] = [];
  let group = null as Group | null;
  let mode = 'statement' as 'statement' | 'solution';
  let cur = null as Ex | null;

  const startGroup = (h: Heading) => {
    group = { key: h.key, date: h.date, variant: h.variant ?? null, statements: [], solutions: [] };
    groups.push(group);
    mode = 'statement';
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const { page, text } = lines[i];
    const h = heads[i];
    if (h) {
      const hasContent = !!group && (group.statements.length > 0 || group.solutions.length > 0);
      if (!group || group.key !== h.key) startGroup(h);
      // Same heading again after exercises: another copy of the paper (running headers carry a section number and are ignored).
      else if (hasContent && !h.numbered) startGroup(h);
      else if (!hasContent && mode === 'solution') mode = 'statement';
      continue;
    }
    const ex = /^(Soluzione\s+(?:dell['’]\s*)?)?Esercizio\s+(\d{1,2})\b(.*)$/i.exec(text);
    if (!group) {
      if (!untitled || !ex) continue;
      startGroup({ key: label, date: null, numbered: false });
    }
    const g = group!;
    // A bare "soluzione" can be a wrapped line of prose; the section marker is in capitals.
    if (/^svolgimento\s*[.:]?$/i.test(text) || /^SOLUZION[EI]\s*[.:]?$/.test(text)) { mode = 'solution'; cur = null; continue; }
    if (ex) {
      // "Soluzione Esercizio 1" and "Esercizio 1 _soluzione" open a solution even without a SOLUZIONI line.
      if (ex[1] || /^\s*[_\-–:.]?\s*soluzion[ei]\b/i.test(ex[3])) mode = 'solution';
      const e: Ex = { num: Number(ex[2]), variant: variantOf(ex[3]) ?? g.variant, startPage: page, endPage: page, lines: [text] };
      const list = g[mode === 'statement' ? 'statements' : 'solutions'];
      const last = list[list.length - 1];
      // The same header repeated at the top of the next page continues the exercise.
      if (last && last === cur && last.num === e.num && last.variant === e.variant && page > last.endPage) { last.endPage = page; continue; }
      list.push(e);
      cur = e;
      continue;
    }
    if (cur) { cur.lines.push(text); cur.endPage = page; }
  }

  // Name duplicated papers (same heading, several versions) apart.
  const seen = new Map<string, number>();
  for (const g of groups) if (g.statements.length) seen.set(g.key, (seen.get(g.key) ?? 0) + 1);
  const counter = new Map<string, number>();

  const rows: QuestionRow[] = [];
  for (const g of groups) {
    if (!g.statements.length) continue;
    let examGroup = g.key;
    if ((seen.get(g.key) ?? 0) > 1) {
      const n = (counter.get(g.key) ?? 0) + 1;
      counter.set(g.key, n);
      examGroup = `${g.key} - versione ${n}`;
    }
    const usedSolutions = new Set<Ex>();
    for (const st of g.statements) {
      let sol = g.solutions.find((s) => !usedSolutions.has(s) && s.num === st.num && s.variant === st.variant);
      if (!sol) {
        const sameNum = g.statements.filter((s) => s.num === st.num).length === 1;
        if (sameNum) sol = g.solutions.find((s) => !usedSolutions.has(s) && s.num === st.num);
      }
      if (sol) usedSolutions.add(sol);
      rows.push({
        kind,
        origin: 'authentic',
        resourceId,
        pageFrom: st.startPage,
        // The range covers statement and solution so both can be re-read from the page images.
        pageTo: Math.max(st.endPage, sol?.endPage ?? st.endPage),
        examGroup,
        examDate: g.date,
        number: numberLabel(st),
        statement: joinLines(st.lines),
        hint: '',
        solution: sol ? joinLines(sol.lines) : '',
        difficulty: 'medio',
        topicIds: [],
        chapterId: null,
        status: 'draft',
        checks: [],
      });
    }
  }
  return rows;
}

// ---------- Multiple-choice quizzes ("Simulazione N") ----------

interface Sim {
  label: string;
  questions: { num: number; startPage: number; endPage: number; lines: string[] }[];
  answers: Map<number, string>;
  hints: Map<number, string[]>;
}

const SIM_HEAD = /^(\d{1,3})\s*[◦°º]?\s*simulazione\b(.*)$/i;
const TEST_HEAD = /^(Test di prova\s*[—–-]\s*.+|Simulazione di test completo\b.*)$/i;

const sig = (lines: string[]) => lines.join(' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function segmentQuiz(resourceId: string, pages: PageText[]): QuestionRow[] {
  const lines = pageLines(pages);
  const runs: Sim[] = [];
  let sim = null as Sim | null;
  let section: 'questions' | 'answers' | 'hints' = 'questions';
  let curQ: Sim['questions'][number] | null = null;
  let curHint: number | null = null;
  let answerBuf: string[] = [];

  const flushAnswers = () => {
    if (!sim || !answerBuf.length) { answerBuf = []; return; }
    const at = answerBuf.findIndex((l) => /^risposta\b/i.test(l));
    if (at > 0) {
      const nums = answerBuf.slice(0, at).filter((l) => /^\d{1,2}$/.test(l)).map(Number);
      const letters = answerBuf.slice(at + 1).filter((l) => /^[a-e]$/i.test(l)).map((l) => l.toLowerCase());
      nums.forEach((n, i) => { if (letters[i]) sim!.answers.set(n, letters[i]); });
    }
    answerBuf = [];
  };
  const open = (label: string, advice: boolean) => {
    flushAnswers();
    const last = [...runs].reverse().find((r) => r.label === label) ?? null;
    // A header repeated on every page keeps the same run; "- Consigli" pages continue the run they advise on.
    if (sim && sim.label === label) { if (advice && sim.questions.length) section = 'hints'; return; }
    if (advice && last) { sim = last; section = 'hints'; curQ = null; curHint = null; return; }
    sim = { label, questions: [], answers: new Map(), hints: new Map() };
    runs.push(sim);
    section = 'questions';
    curQ = null;
    curHint = null;
  };

  for (const { page, text } of lines) {
    const h = SIM_HEAD.exec(text);
    if (h) { open(`Simulazione ${Number(h[1])}`, /consigli/i.test(h[2])); continue; }
    const t = TEST_HEAD.exec(text);
    if (t) { open(t[1].replace(/\s+/g, ' ').trim(), false); continue; }
    if (!sim) continue;
    if (/^RISPOSTE AI QUESITI$/i.test(text)) { section = 'answers'; curQ = null; continue; }
    if (/^CONSIGLI$/i.test(text)) { flushAnswers(); section = 'hints'; curHint = null; continue; }
    if (section === 'questions') {
      const m = /^(\d{1,2})\.\s*(.*)$/.exec(text);
      const expect: number = (curQ ? (curQ as { num: number }).num : 0) + 1;
      if (m && Number(m[1]) === expect) {
        curQ = { num: expect, startPage: page, endPage: page, lines: [text] };
        sim.questions.push(curQ);
      } else if (curQ) { curQ.lines.push(text); curQ.endPage = page; }
    } else if (section === 'answers') {
      answerBuf.push(text);
    } else {
      const m = /^Quesito\s+(?:n[◦°º]?\s*)?(\d{1,2})\b\s*(.*)$/i.exec(text);
      if (m) { curHint = Number(m[1]); sim.hints.set(curHint, m[2] ? [m[2]] : []); }
      else if (curHint !== null) sim.hints.get(curHint)!.push(text);
    }
  }
  flushAnswers();

  // Collections often repeat a whole block; identical repeats are folded into the first copy.
  const kept: Sim[] = [];
  const copies = new Map<string, number>();
  for (const r of runs) {
    if (!r.questions.length) continue;
    const first = sig(r.questions[0].lines) + '|' + sig(r.questions[r.questions.length - 1].lines);
    const twin = kept.find((k) => k.label === r.label.replace(/ \(\d+\)$/, '') && k.questions.length && sig(k.questions[0].lines) + '|' + sig(k.questions[k.questions.length - 1].lines) === first);
    const twin2 = twin ?? kept.find((k) => k.questions.length && sig(k.questions[0].lines) + '|' + sig(k.questions[k.questions.length - 1].lines) === first && k.label.startsWith(r.label));
    if (twin2) {
      for (const [n, a] of r.answers) if (!twin2.answers.has(n)) twin2.answers.set(n, a);
      for (const [n, h] of r.hints) if (!twin2.hints.has(n)) twin2.hints.set(n, h);
      continue;
    }
    const k = (copies.get(r.label) ?? 0) + 1;
    copies.set(r.label, k);
    kept.push(k > 1 ? { ...r, label: `${r.label} (${k})` } : r);
  }

  const rows: QuestionRow[] = [];
  for (const s of kept) {
    for (const q of s.questions) {
      const ans = s.answers.get(q.num);
      const hint = s.hints.get(q.num);
      rows.push({
        kind: 'exercise',
        origin: 'authentic',
        resourceId,
        pageFrom: q.startPage,
        pageTo: q.endPage,
        examGroup: s.label,
        examDate: null,
        number: String(q.num),
        statement: joinLines(q.lines),
        hint: hint ? joinLines(hint) : '',
        solution: ans ? `Risposta corretta: ${ans}` : '',
        difficulty: 'medio',
        topicIds: [],
        chapterId: null,
        status: 'draft',
        checks: [],
      });
    }
  }
  return rows;
}

// ---------- Multiple-choice quizzes numbered "N)" with options "a)" … ("DBQuiz") ----------

interface QuizItem { num: number; startPage: number; endPage: number; stem: string[]; options: { letter: string; lines: string[] }[] }

const QUIZ_NUM = /^(\d{1,3})\)\s*(.*)$/;
const QUIZ_OPTION = /^([a-e])\)\s*(.*)$/;

/**
 * Collections where every question is "N) statement" followed by options "a)" … "e)" and no answer key in the text
 * (the right option is only highlighted in the PDF, so there is no solution). Numbering that restarts at 1 after a
 * complete question starts a new block, named after the file. Question numbers may skip or repeat a little.
 */
export function segmentNumberedQuiz(resourceId: string, pages: PageText[], label = ''): QuestionRow[] {
  const blocks: QuizItem[][] = [];
  let block = null as QuizItem[] | null;
  let cur = null as QuizItem | null;
  for (const { page, text } of pageLines(pages)) {
    const q = QUIZ_NUM.exec(text);
    if (q) {
      const n = Number(q[1]);
      const prev = cur?.num ?? 0;
      // A question with a single option is a broken one; the next number still starts a new question.
      const done = !!cur && (cur.options.length >= 2 || (cur.options.length === 1 && n === prev + 1));
      // An option that continues with "1) …" is not a new question: a restart needs a full question before and a sentence after.
      const restart = n === 1 && !!cur && cur.options.length >= 4 && /^\p{L}.{9}/u.test(q[2]);
      if ((!cur && n <= 3) || (done && n !== prev && n >= prev - 3 && n <= prev + 4) || restart) {
        cur = { num: n, startPage: page, endPage: page, stem: q[2] ? [q[2]] : [], options: [] };
        if (!block || restart) blocks.push(block = []);
        block.push(cur);
        continue;
      }
    }
    if (!cur) continue;
    cur.endPage = page;
    const o = QUIZ_OPTION.exec(text);
    // Options come in order; a "b) …" inside a statement or an option is text.
    if (o && o[1] === String.fromCharCode(97 + cur.options.length)) cur.options.push({ letter: o[1], lines: o[2] ? [o[2]] : [] });
    else if (cur.options.length) cur.options[cur.options.length - 1].lines.push(text);
    else cur.stem.push(text);
  }
  const blocksWithItems = blocks.map((b) => b.filter((x) => x.options.length >= 2)).filter((b) => b.length);
  // A handful of "1) … a) …" lines in an ordinary sheet is not a quiz collection.
  if (blocksWithItems.reduce((n, b) => n + b.length, 0) < 3) return [];
  return blocksWithItems.flatMap((b, i) => b.map((x): QuestionRow => ({
    kind: 'exercise',
    origin: 'authentic',
    resourceId,
    pageFrom: x.startPage,
    pageTo: x.endPage,
    examGroup: blocksWithItems.length > 1 ? `${label} - blocco ${i + 1}` : label,
    examDate: null,
    number: String(x.num),
    statement: `${joinLines(x.stem)}\n\n${x.options.map((o) => `- ${o.letter}) ${o.lines.join(' ')}`.trimEnd()).join('\n')}`,
    hint: '',
    solution: '',
    difficulty: 'medio',
    topicIds: [],
    chapterId: null,
    status: 'draft',
    checks: [],
  })));
}

/** Split an exam/exercise resource into authentic questions with page ranges and exam sessions. Text-layer heuristics; statements may be garbled until transcribed. */
export function segmentQuestions(ctx: AppContext, resourceId: string): QuestionRow[] {
  const res = ctx.db.get<{ role: string; filename: string }>('SELECT role, filename FROM resources WHERE id = ?', resourceId);
  if (!res) throw new ExtractError('That source was not found. It may have been deleted.', 404, 'not_found');
  const pages = ctx.db.all<PageText>('SELECT idx, text FROM pages WHERE resource_id = ? ORDER BY idx', resourceId);
  const label = res.filename.replace(/\.[^.]+$/, '').trim();
  if (res.role === 'exams') return segmentExams(resourceId, pages, { label, untitled: true });
  if (!['exercises', 'mixed'].includes(res.role)) return [];
  const quiz = segmentQuiz(resourceId, pages);
  // Other quiz layout ("13) …" with options a) to e)), then exercise sheets ("Esercizio 1", "Esercizio 2", …) as one group per file.
  if (res.role === 'exercises') {
    if (quiz.length) return quiz;
    const numbered = segmentNumberedQuiz(resourceId, pages, label);
    return numbered.length ? numbered : segmentExams(resourceId, pages, { label, kind: 'exercise', untitled: true });
  }
  return [...segmentExams(resourceId, pages, { label, untitled: !quiz.length }), ...quiz];
}
