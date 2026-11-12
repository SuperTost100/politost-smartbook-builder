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

/** Emphasis that wraps the start of a line: **bold**, __bold__, *italic*, _italic_. The closing mark must end a word, so a product "a*b" is not one. */
const EMPHASIS = [/^\*{1,3}(?=[^\s*])([^*\n]*?[^\s*])\*{1,3}(?=\s|$|[.,:;!?)])/, /^_{1,3}(?=[^\s_])([^_\n]*?[^\s_])_{1,3}(?=\s|$|[.,:;!?)])/];
const plainCell = (s: string) => EMPHASIS.reduce((t, re) => t.replace(re, '$1'), s.replace(/^#{1,6}\s+/, '')).trim();

/**
 * The lines of a page as plain text, so a source written in Markdown reads like the PDF of the same paper: "## Esercizio 1" and
 * "**Problema 1** (12 punti)" lose their marks, a row of a pipe table gives one line per cell (as a PDF text layer does), and a
 * separator row, an empty row and a rule ("---") give none. Text that is not Markdown comes back unchanged apart from trimming.
 * A line of pipes is a table row only inside a table, which is a run of such lines that holds a separator row ("|---|---|"), so a
 * line of math such as "| x | + | y |" stays whole.
 */
export function plainLines(text: string): string[] {
  const out: string[] = [];
  const rows = text.split('\n').map((raw) => raw.trim());
  const isRow = (l: string) => /^\|.*\|$/.test(l);
  const isSeparator = (l: string) => /^\|[\s:|-]*-[\s:|-]*\|$/.test(l);
  rows.forEach((l, i) => {
    if (!l || /^(?:-{3,}|\*{3,})$/.test(l)) return;
    if (isRow(l)) {
      let from = i;
      let to = i;
      while (from > 0 && isRow(rows[from - 1])) from--;
      while (to < rows.length - 1 && isRow(rows[to + 1])) to++;
      if (rows.slice(from, to + 1).some(isSeparator)) {
        if (!isSeparator(l)) out.push(...l.slice(1, -1).split(/(?<!\\)\|/).map((c) => plainCell(c.trim())).filter(Boolean));
        return;
      }
    }
    const plain = plainCell(l);
    if (plain) out.push(plain);
  });
  return out;
}

function pageLines(pages: PageText[]): Line[] {
  const out: Line[] = [];
  for (const p of pages) {
    const raw = plainLines(p.text);
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

interface Heading { key: string; date: string | null; numbered: boolean; variant?: string | null; generic?: boolean }

// ---------- Exercise and session headings of papers from any course ----------

/** Words that head an exercise ("Esercizio 1", "Problema 2", "Quesito 3", "Domanda 4", "Parte A"). */
const EXERCISE = /^(?:(Soluzione|Svolgimento|Risoluzione)\s+(?:(?:dell['’]\s*)|(?:(?:del|della|dello|di)\s+))?)?(Esercizio|Problema|Quesito|Domanda|Parte)\s+(\d{1,2}|[A-Za-z]|[IVX]{2,4})\b(.*)$/iu;
/** "Soluzione 2", "Svolgimento 2": a solution that names only the number. */
const SOLUTION_NUMBER = /^(?:Soluzione|Svolgimento|Risoluzione|SOLUZIONE|SVOLGIMENTO|RISOLUZIONE)\s+(\d{1,2})\b(.*)$/u;
const SOLUTION_WORD = String.raw`(?:Soluzion[ei]|SOLUZION[EI]|Risoluzion[ei]|RISOLUZION[EI])`;
/** What may follow the word on the same line: text in brackets "(Appello del 12 febbraio 2024)", or the name of the session "- Appello del …", "dell'appello del …". */
const SOLUTION_QUALIFIER = String.raw`(?:\([^()]{1,80}\)|(?:(?:dell['’]\s*|del(?:l[aeo])?\s+|di\s+)?(?:[Aa]ppello|[Ee]same|[Pp]rova|[Cc]ompito|[Tt]ema|[Tt]urno|[Ff]ila|[Vv]ersione)\b.{0,80}))`;
const SOLUTION_HEADING = new RegExp(String.raw`^${SOLUTION_WORD}\s*(?:[.:]?$|[.:\-–—]?\s*${SOLUTION_QUALIFIER}\s*[.:]?$)`);
/**
 * A section marker on its own line, alone or with a qualifier ("Soluzioni (Appello del 12 febbraio 2024)"). "svolgimento" is a
 * marker in any case; the other words only capitalised, because a bare "soluzione" can be a wrapped line of prose, and with a
 * qualifier only the qualifiers of a session or a version, so a sentence that starts with "Soluzione di …" is no marker.
 */
export const isSolutionMarker = (t: string) => /^svolgimento\s*[.:]?$/i.test(t) || SOLUTION_HEADING.test(t);

interface ExHead { solution: boolean; word: string; id: string; rest: string }

/**
 * An exercise heading, or a solution heading that names its exercise. A letter or a roman numeral counts only when a
 * delimiter follows ("Parte A", "Parte B:", "Parte a)"), so prose that starts with "parte a destra" is not a heading.
 */
function parseExercise(text: string): ExHead | null {
  const sol = SOLUTION_NUMBER.exec(text);
  if (sol) return { solution: true, word: '', id: String(Number(sol[1])), rest: sol[2] };
  const m = EXERCISE.exec(text);
  if (!m) return null;
  const rest = m[4];
  const id = /^\d/.test(m[3]) ? String(Number(m[3])) : m[3].toUpperCase();
  if (!/^\d/.test(m[3]) && !/^\s*(?:$|[.:)\-–—(])/.test(rest) && !/^\s+\(/.test(rest)) return null;
  return { solution: !!m[1], word: m[2].toLowerCase(), id, rest };
}

const dateOf = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 ? { y, m, d } : null);

/** The first date in a text: 2024-02-12, 12/02/2024 (also 12.02.24, 12-2-2024), 12 febbraio 2024 (also "1° febbraio 2024"). */
export function findDate(text: string): { y: number; m: number; d: number } | null {
  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) { const r = dateOf(Number(iso[1]), Number(iso[2]), Number(iso[3])); if (r) return r; }
  const word = new RegExp(`(?<!\\d)(\\d{1,2})\\s*[°º]?\\s+(${MONTH_NAMES.join('|')})\\s+(\\d{4})(?!\\d)`, 'i').exec(text);
  if (word) { const r = dateOf(Number(word[3]), MONTHS[word[2].toLowerCase()], Number(word[1])); if (r) return r; }
  const num = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/])/.exec(text);
  if (num) return dateOf(Number(num[3].length === 2 ? `20${num[3]}` : num[3]), Number(num[2]), Number(num[1]));
  return null;
}

const isoOf = (d: { y: number; m: number; d: number }) => iso(d.y, d.m, d.d);

/**
 * Session name for a dated paper, shared by the text splitter and the AI split so the same session in two files matches.
 * `turn` is the text printed after the date ("Turno A"), which tells two papers of one day apart.
 */
export const sessionKey = (d: { y: number; m: number; d: number }, word = 'Esame', turn = '') => `${word} del ${d.d} ${MONTH_NAMES[d.m - 1]} ${d.y}${turn ? ` - ${turn}` : ''}`;

const SESSION_WORD = /^(Esame|Appello|Compito|Tema\s+d['’]?\s*esame)\b(.*)$/i;
const canonicalWord = (raw: string) => (/^tema/i.test(raw) ? "Tema d'esame" : raw[0].toUpperCase() + raw.slice(1).toLowerCase());
/** What follows the year of a heading, without its separators: "Esame del 12 febbraio 2024 - Turno A" gives "Turno A". */
const turnAfterYear = (rest: string) => rest.replace(/^[\s\-–—:,]+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim();

/**
 * The name of a session from the title the AI split read and its date. The title goes through the same heading parser as the
 * text rules, so every heading form they support gets the name they give it, with the same turn or none. A title the rules
 * do not recognise, or one whose date differs from the model's, is named from its first word and the model's date.
 */
export function sessionName(title: string, d: { y: number; m: number; d: number }): string {
  const t = title.trim();
  const own = parseHeading(t, [], 0, '', []);
  if (own?.date === isoOf(d)) return own.key;
  const m = /^(Esame|Appello|Compito|Tema\s+d['’]?\s*esame|Prova\s+scritta)\b/i.exec(t);
  return sessionKey(d, m ? (/^prova/i.test(m[1]) ? 'Prova scritta' : canonicalWord(m[1])) : 'Esame');
}

/** The date of a paper whose heading is on `l`: on the same line, in the header lines after it (a table of name, matricola, date), or just before it. */
function dateAround(l: string, following: string[], before: string[]) {
  const own = findDate(l);
  if (own) return own;
  const upto = following.findIndex((f) => parseExercise(f));
  for (const f of upto < 0 ? following : following.slice(0, upto)) { const d = findDate(f); if (d) return d; }
  for (const b of before) { const d = findDate(b); if (d) return d; }
  return null;
}

/**
 * Session heading of a course other than Analisi or Fisica: "Esame di <any course>", "Appello", "Compito", "Tema d'esame",
 * with a date on the line or in the header after it. Without a date the line counts only when an exercise follows soon,
 * so a sentence that starts with "Compito di casa" is not a heading.
 */
function parseGenericHeading(l: string, following: string[], before: string[], label: string): Heading | null {
  const m = SESSION_WORD.exec(l);
  if (!m || l.length > 90 || LEADERS.test(l) || /^(?:\.\s?){4,}/.test(following[0] ?? '')) return null;
  const word = canonicalWord(m[1]);
  const rest = m[2];
  if (!/^\s*(?:$|[-–—:,(]|\d|(?:di|del|della|dello|dell['’]|d['’]|scritto|fila|[A-Z]\b))/i.test(rest)) return null;
  // "Compito A", "Compito FILA A": the letter names the version of the paper.
  const fila = word === 'Compito' ? /^\s+fila\s+([A-Za-z]\d?)\b/i.exec(rest) ?? /^\s+([A-Z]\d?)\b/.exec(rest) : null;
  const variant = fila ? fila[1].toUpperCase() : null;
  const date = dateAround(l, following, before);
  // "Appello del 12 febbraio 2024 - Turno A": two turns of one day are two papers. Only the word "Turno" counts, because other text after the date is a course name or a room.
  const turn = /\bturno\s+([^\s,;()\-–—]+)/i.exec(l);
  if (date) return { key: sessionKey(date, word, turn ? `Turno ${turn[1].toUpperCase()}` : ''), date: isoOf(date), numbered: false, variant, generic: true };
  if (!following.some((f) => parseExercise(f))) return null;
  return { key: label ? `${word} - ${label}` : word, date: null, numbered: false, variant, generic: true };
}

/** Parse a session heading line. `next` is the following non-empty line (to spot table-of-contents entries). `label` names the file. */
function parseHeading(l: string, following: string[], page: number, label: string, before: string[] = [], allowGeneric = true): Heading | null {
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
    const d = Number(old[2]);
    return {
      key: sessionKey({ y: Number(old[4]), m: month, d }, 'Esame', turnAfterYear(rest)),
      date: iso(Number(old[4]), month, d),
      numbered: old[1] !== undefined,
    };
  }
  const nw = /^Esame\s+di\s+ANALISI\s+MATEMATICA\s+I\b\D{0,3}?(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/i.exec(l);
  if (nw) {
    const [d, m, y] = [Number(nw[1]), Number(nw[2]), Number(nw[3])];
    if (m < 1 || m > 12) return null;
    const turn = nw[4].replace(/^[\s\-–—:,]+/, '').replace(/\s+/g, ' ').trim();
    return { key: sessionKey({ y, m, d }, 'Esame', turn), date: iso(y, m, d), numbered: false };
  }
  const paper = parsePaper(l, following, label);
  if (paper || !allowGeneric || /^Esame\s+di\s+ANALISI\s+MATEMATICA\s+I\b/i.test(l)) return paper;
  return parseGenericHeading(l, following, before, label);
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
  // A full date in any supported form ("12 febbraio 2024", "2024-02-12", "23/06/2022") is read first; the pattern below also accepts a date without its year.
  const full = findDate(m[1]);
  if (full) return { key: sessionKey(full, 'Prova scritta'), date: isoOf(full), numbered: false, variant };
  const dm = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2})(?!\d))?/.exec(m[1]);
  // No date on the line and no blank-template placeholder: a header table may carry it ("Data: 12/02/2024").
  if (!dm && !/[xX_]{2}|\d/.test(m[1])) {
    const upto = following.findIndex((f) => parseExercise(f));
    const header = upto < 0 ? following : following.slice(0, upto);
    const at = header.findIndex((f, i) => /^data\b/i.test(f) && findDate(`${f} ${header[i + 1] ?? ''}`));
    const labelled = at >= 0 ? findDate(`${header[at]} ${header[at + 1] ?? ''}`) : null;
    if (labelled) return { key: sessionKey(labelled, 'Prova scritta'), date: isoOf(labelled), numbered: false, variant };
  }
  const year = dm?.[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : Number(/\b(?:19|20)\d{2}\b/.exec(label)?.[0] ?? NaN);
  const [d, mo] = dm ? [Number(dm[1]), Number(dm[2])] : [0, 0];
  if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && year) {
    return { key: `Prova scritta del ${d} ${MONTH_NAMES[mo - 1]} ${year}`, date: iso(year, mo, d), numbered: false, variant };
  }
  return { key: label ? `Prova scritta - ${label}` : 'Prova scritta', date: null, numbered: false, variant };
}

/** The label cells of a paper's header table: "Corso", "Corso di Laurea", "Prova", "Durata", "Nome e cognome", "Matricola", "Data". */
const HEADER_LABEL = /^(?:corso(?:\s+di\s+laurea)?|prova|durata|nome(?:\s+e\s+cognome)?|cognome(?:\s+e\s+nome)?|matricola|data|docente|anno\s+accademico)\s*:?$/i;
/** A short line of a header table, label or value: no formula, no sub-question mark, no sentence. */
const headerCell = (l: string) => l.length <= 60 && !/[=$]/.test(l) && !/^(?:[a-z]\)|\d{1,2}[.)])\s/i.test(l) && !/[.;]$/.test(l);

/**
 * How many of the last lines of an exercise or solution are the header table of the paper that follows ("Corso", "Elettrotecnica
 * (ING-IND/31)", "Corso di Laurea", "Ingegneria Elettronica, primo anno", "Prova", printed before the session heading). The block
 * is at least two lines, starts at a label cell, never takes the exercise's own first line and holds at least two different
 * labels: one label and its value ("Durata", "20 s") can be a solution's own table, and the caller removes what this returns.
 * shortcut: a header whose labels are not in HEADER_LABEL stays at the end of the last text, upgrade when a paper needs another label.
 */
export function trailingHeaderCells(lines: string[]): number {
  let n = 0;
  while (n < lines.length - 1 && n < 12 && headerCell(lines[lines.length - 1 - n])) n++;
  // The block starts at a label cell: short lines before it ("Risposta:") are the solution's.
  while (n >= 2 && !HEADER_LABEL.test(lines[lines.length - n])) n--;
  if (n < 2) return 0;
  const labels = new Set(lines.slice(-n).filter((l) => HEADER_LABEL.test(l)).map((l) => l.toLowerCase().replace(/[\s:]+/g, ' ').trim()));
  return labels.size >= 2 ? n : 0;
}

interface Ex { word: string; id: string; variant: string | null; startPage: number; endPage: number; lines: string[] }
interface Group { key: string; date: string | null; variant: string | null; statements: Ex[]; solutions: Ex[] }

function variantOf(rest: string): string | null {
  const v = /\bversione\s+([A-Z])\b/i.exec(rest);
  if (v) return v[1].toUpperCase();
  const k = /\bvariante\s+(\d+)\b/i.exec(rest);
  return k ? `v${k[1]}` : null;
}

/** The letter or number after "Turno", "Versione", "Fila" or "Compito" ("Turno A" gives "A"). */
const turnOf = (s: string) => /\b(?:turno|versione|fila|variante|compito)\s+([A-Za-z]\d?|\d+)\b(?!['’])/i.exec(s)?.[1].toUpperCase() ?? null;

const numberLabel = (e: Ex) => (e.variant ? (e.variant.startsWith('v') ? `${e.id}.${e.variant.slice(1)}` : `${e.id}${e.variant}`) : e.id);

export function joinLines(lines: string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface SegmentOptions {
  /** File name without extension: names undated papers and supplies a missing year. */
  label?: string;
  kind?: 'exam' | 'exercise';
  /** With no session heading anywhere in the file, the whole file is one group named after `label`. */
  untitled?: boolean;
}

export interface ExamSplit {
  rows: QuestionRow[];
  /** True when no session heading was recognised anywhere in the file. */
  noHeading: boolean;
}

export function segmentExams(resourceId: string, pages: PageText[], opts: SegmentOptions = {}): QuestionRow[] {
  return splitExams(resourceId, pages, opts).rows;
}

export function splitExams(resourceId: string, pages: PageText[], opts: SegmentOptions = {}): ExamSplit {
  const { label = '', kind = 'exam' } = opts;
  const lines = pageLines(pages);
  const texts = lines.map((x) => x.text);
  const heads: (Heading | null)[] = [];
  lines.forEach((x, i) => {
    // A heading for another course is not looked for right under a heading: "Compito FILA A" under "Prova scritta ..." names a version.
    const before = texts.slice(Math.max(0, i - 3), i).filter((_, k) => lines[Math.max(0, i - 3) + k].page === x.page);
    // A version label right under a session heading of the same page is not a new session. A heading on a new page always is.
    const nearHeading = heads.slice(-3).some((h, k) => h && lines[Math.max(0, i - 3) + k].page === x.page);
    heads.push(parseHeading(x.text, texts.slice(i + 1, i + 9), x.page, label, before, !nearHeading));
  });
  const noHeading = !heads.some(Boolean);
  // Position of each line among the kept lines of its page.
  const pos: number[] = [];
  lines.forEach((x, i) => pos.push(i > 0 && lines[i - 1].page === x.page ? pos[i - 1] + 1 : 0));
  const untitled = !!opts.untitled && !!label && noHeading;
  const groups: Group[] = [];
  let group = null as Group | null;
  let mode = 'statement' as 'statement' | 'solution';
  let cur = null as Ex | null;

  const startGroup = (h: Heading, at = -1) => {
    // The header table of this paper is printed before its heading, so it sits at the end of the previous paper's last text.
    if (cur && at >= 0) {
      const tail = cur.lines.slice(-12);
      let n = trailingHeaderCells(cur.lines);
      while (n > 0 && tail[tail.length - n] !== texts[at - n]) n--;
      if (n) {
        cur.lines.length -= n;
        cur.endPage = Math.max(cur.startPage, lines[at - n - 1]?.page ?? cur.startPage);
      }
    }
    group = { key: h.key, date: h.date, variant: h.variant ?? null, statements: [], solutions: [] };
    groups.push(group);
    mode = 'statement';
    cur = null;
  };
  // A heading repeated at the top of a later page is a running header unless the exercises start again from the first one.
  // An exercise that continues from the page before repeats its own heading, which is not a restart.
  const startsNewCopy = (i: number, g: Group) => {
    for (let j = i + 1; j < lines.length; j++) {
      if (heads[j] || isSolutionMarker(texts[j])) return false;
      const e = parseExercise(texts[j]);
      if (e) {
        const first = g.statements[0];
        return !e.solution && mode === 'statement' && !!first && first.word === e.word && first.id === e.id;
      }
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const { page, text } = lines[i];
    const h = heads[i];
    if (h) {
      const hasContent = !!group && (group.statements.length > 0 || group.solutions.length > 0);
      // A page header above the heading of another paper ("ELETTROTECNICA" under "Politecnico di Torino") belongs to no exercise.
      if (h.generic && cur && pos[i] <= 4) {
        let k = 1;
        while (k <= pos[i] && cur.lines.length > 1 && cur.lines[cur.lines.length - 1] === texts[i - k]) { cur.lines.pop(); k++; }
        if (k > 1) cur.endPage = Math.max(cur.startPage, lines[i - k]?.page ?? cur.startPage);
      }
      if (!group || group.key !== h.key) startGroup(h, i);
      // Same heading again after exercises: another copy of the paper (running headers carry a section number and are ignored).
      else if (hasContent && !h.numbered && (!h.generic || startsNewCopy(i, group))) startGroup(h, i);
      else if (!hasContent && mode === 'solution') mode = 'statement';
      continue;
    }
    const ex = parseExercise(text);
    if (!group) {
      if (!untitled || !ex) continue;
      startGroup({ key: label, date: null, numbered: false });
    }
    const g = group!;
    if (isSolutionMarker(text)) {
      mode = 'solution';
      cur = null;
      // "Soluzioni (Appello del 3 luglio 2024)" names its session: solutions printed after all the papers still reach their own.
      // Two papers of one day are told apart by the turn the heading names. A heading that names none, or one that fits several, redirects nowhere.
      const named = findDate(text);
      const sameDay = named ? groups.filter((x) => x.date === isoOf(named) && x.statements.length > 0) : [];
      const want = turnOf(text);
      const fits = sameDay.length <= 1 ? sameDay : sameDay.filter((x) => want !== null && (x.variant ?? turnOf(x.key)) === want);
      if (fits.length === 1) group = fits[0];
      continue;
    }
    if (ex) {
      // "Soluzione Esercizio 1" and "Esercizio 1 _soluzione" open a solution even without a SOLUZIONI line.
      if (ex.solution || /^\s*[_\-–:.]?\s*soluzion[ei]\b/i.test(ex.rest)) mode = 'solution';
      const e: Ex = { word: ex.word, id: ex.id, variant: variantOf(ex.rest) ?? g.variant, startPage: page, endPage: page, lines: [text] };
      const list = g[mode === 'statement' ? 'statements' : 'solutions'];
      const last = list[list.length - 1];
      // The same header repeated at the top of the next page continues the exercise.
      if (last && last === cur && last.word === e.word && last.id === e.id && last.variant === e.variant && page > last.endPage) { last.endPage = page; continue; }
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
    // A paper with problems and questions often numbers each from 1: then the number keeps its word ("Quesito 1").
    const bare = g.statements.map(numberLabel);
    const mixedWords = new Set(g.statements.map((s) => s.word)).size > 1 && new Set(bare).size < bare.length;
    const usedSolutions = new Set<Ex>();
    const same = (a: Ex, b: Ex) => a.id === b.id && (a.word === b.word || !a.word || !b.word);
    for (const st of g.statements) {
      let sol = g.solutions.find((s) => !usedSolutions.has(s) && same(s, st) && s.variant === st.variant);
      if (!sol) {
        const sameNum = g.statements.filter((s) => same(s, st)).length === 1;
        if (sameNum) sol = g.solutions.find((s) => !usedSolutions.has(s) && same(s, st));
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
        number: mixedWords ? `${st.word[0].toUpperCase()}${st.word.slice(1)} ${numberLabel(st)}` : numberLabel(st),
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
  return { rows, noHeading };
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
export function splitQuestions(ctx: AppContext, resourceId: string): ExamSplit & { role: string } {
  const res = ctx.db.get<{ role: string; filename: string }>('SELECT role, filename FROM resources WHERE id = ?', resourceId);
  if (!res) throw new ExtractError('That source was not found. It may have been deleted.', 404, 'not_found');
  const pages = ctx.db.all<PageText>('SELECT idx, text FROM pages WHERE resource_id = ? ORDER BY idx', resourceId);
  const label = res.filename.replace(/\.[^.]+$/, '').trim();
  const out = (rows: QuestionRow[], noHeading = false) => ({ rows, noHeading, role: res.role });
  if (res.role === 'exams') return { ...splitExams(resourceId, pages, { label, untitled: true }), role: res.role };
  if (!['exercises', 'mixed'].includes(res.role)) return out([]);
  const quiz = segmentQuiz(resourceId, pages);
  // Other quiz layout ("13) …" with options a) to e)), then exercise sheets ("Esercizio 1", "Esercizio 2", …) as one group per file.
  if (res.role === 'exercises') {
    if (quiz.length) return out(quiz);
    const numbered = segmentNumberedQuiz(resourceId, pages, label);
    return numbered.length ? out(numbered) : out(segmentExams(resourceId, pages, { label, kind: 'exercise', untitled: true }));
  }
  return out([...segmentExams(resourceId, pages, { label, untitled: !quiz.length }), ...quiz]);
}

export const segmentQuestions = (ctx: AppContext, resourceId: string): QuestionRow[] => splitQuestions(ctx, resourceId).rows;
