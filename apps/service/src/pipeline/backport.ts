// Back-port: carries hand edits made in a published book folder (politost-books `books/<slug>`) back into the builder's
// sources, so the next export does not undo them. The folder is compared with the export it was published from (named by its
// .builder.json) one unit at a time (a section, an exercise, a graph, a figure caption): only units the folder changed are
// candidates, and one the builder also changed since the publish is refused. Each candidate is mapped to the row it comes
// from and rewritten there as an author edit, and the book is compiled again before anything is written. A unit is written
// only when the new compile reproduces it exactly and adds no blocker or major finding.
import { captionToPlain, checkFunctionGraph, compileBook, formatGraphPayload, formatLintKeys, graphLintCheck, lintKey, type BookInput, type CompiledBook, type LintFinding } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { bookFiles, exerciseQuestions, MANIFEST, publishedExport, readManifest } from './publish.ts';
import { countUnresolvedBlockers, currentHeads, loadBookInput, rewriteHead, updateEnrichmentPayload, updateQuestion } from '../repo/index.ts';
import { closeGoneCompileNotes } from '../routes/review.ts';
import { relint } from '../routes/views.ts';

export type UnitKind = 'section' | 'caption' | 'question' | 'graph' | 'file';
/**
 * mapped: written (or, in a dry run, would be). unmapped: the change has no source the back-port can write.
 * compiler-owned: the difference is the compiler's own output (a label, the version, caption symbols), not text of the book.
 * refused: mapped, but it did not compile back to the books text or it added a blocker or major finding.
 */
export type UnitStatus = 'mapped' | 'unmapped' | 'compiler-owned' | 'refused';

export interface BackportUnit {
  /** "chapters/03-x.md#p2", "esami.md#X3", "grafici.json#<id>", or a file path. */
  unit: string;
  kind: UnitKind;
  status: UnitStatus;
  reason?: string;
  /** The section, question, graph or asset row the unit was mapped to. */
  target?: string;
}

type Part = 'statement' | 'hint' | 'solution';
export type BackportChange =
  | { kind: 'section'; nodeId: string; markdown: string }
  | { kind: 'asset'; filename: string; caption: string; alt: string }
  | { kind: 'question'; questionId: string; parts: Partial<Record<Part, string>> }
  | { kind: 'graph'; enrichmentId: string; payload: Record<string, unknown> };

export interface BackportPlan {
  units: BackportUnit[];
  /** Changes of the mapped units, in unit order. */
  changes: BackportChange[];
  /** The compile of the builder's current sources, and the compile with the mapped changes applied. */
  base: CompiledBook;
  after: CompiledBook;
  /** Set when a new blocker or major finding cannot be tied to one unit: then nothing is written. */
  bookRefusal: string | null;
  /** Files of the books folder that the new compile still does not reproduce byte for byte, with the units that explain them. */
  residual: { file: string; causes: string[] }[];
}

// ---------- reading compiled files ----------

const text = (v: string | Uint8Array | undefined) => (v === undefined ? undefined : typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));

/** A chapter file split into its front matter, the `## pN | title` headings and the body under each. */
function sectionsOf(md: string): { front: string; titles: Record<string, string>; bodies: Record<string, string> } {
  const front = /^---\n[\s\S]*?\n---\n/.exec(md)?.[0] ?? '';
  const parts = md.slice(front.length).split(/^## (p\d+) \| (.*)$/m);
  const titles: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 3) {
    titles[parts[i]] = parts[i + 1];
    bodies[parts[i]] = (parts[i + 2] ?? '').trim();
  }
  return { front, titles, bodies };
}

interface ExerciseParts { attrs: string; statement: string; hint: string; solution: string }

/** The exercises of esercizi.md or esami.md by id, split into the attributes line, statement, hint and solution. */
function exercisesOf(md: string): Record<string, ExerciseParts> {
  const out: Record<string, ExerciseParts> = {};
  for (const m of md.matchAll(/^:::exercise\{([^\n]*)\}\n## Domanda\n([\s\S]*?)(?=^:::exercise\{|(?![\s\S]))/gm)) {
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
    if (!id) continue;
    const body = m[2].trimEnd().replace(/\n:::$/, '');
    const hint = /^:::hint\n([\s\S]*?)\n:::$/m.exec(body);
    const sol = /^:::solution\n([\s\S]*?)\n:::$/m.exec(body);
    const cut = Math.min(hint?.index ?? body.length, sol?.index ?? body.length);
    out[id] = { attrs: m[1], statement: body.slice(0, cut).trim(), hint: hint?.[1].trim() ?? '', solution: sol?.[1].trim() ?? '' };
  }
  return out;
}

const IMAGE_LINE = /^:::image\{(.*)\}\s*$/;
const attrOf = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
/** An image line as the current compiler writes it: captions get Unicode super- and subscripts ("x^2" becomes "x²"). */
const foldImageLine = (line: string) => line.replace(/\bcaption="([^"]*)"/, (_, c: string) => `caption="${captionToPlain(c)}"`);
const foldImages = (s: string) => s.split('\n').map((l) => (IMAGE_LINE.test(l) ? foldImageLine(l) : l)).join('\n');

/** Lines of `now` that pass `pick` and are not in `was`. */
const newLines = (was: string, now: string, pick: (l: string) => boolean) => {
  const old = new Set(was.split('\n'));
  return now.split('\n').filter((l) => pick(l) && !old.has(l));
};
const formulaIds = (s: string) => [...s.matchAll(/^:::formula\{[^}\n]*\bid="([^"]+)"/gm)].map((m) => m[1]);
/** Numbered formula ids in `now` that `was` does not have. */
const newFormulaIds = (was: string, now: string) => {
  const old = new Set(formulaIds(was));
  return formulaIds(now).filter((id) => !old.has(id)).map((id) => `formula ${id}`);
};

// ---------- line diff ----------

type Op = { a0: number; a1: number; b0: number; b1: number }; // a[a0..a1) is replaced by b[b0..b1)
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: Op[] = [];
  let op: Op | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (op) ops.push(op);
      op = null;
      i++;
      j++;
      continue;
    }
    op ??= { a0: i, a1: i, b0: j, b1: j };
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) op.b1 = ++j;
    else op.a1 = ++i;
  }
  if (op) ops.push(op);
  return ops;
}

// ---------- compiled text -> source text ----------

interface Inverse {
  /** Turns compiled references back into source ones: `{{formula:7.9}}` to `{{formula:@key}}`, `ref:chapter/9#p5` to `ref:section/<id>`. */
  toSource(line: string): string;
}

function inverseOf(base: CompiledBook): Inverse {
  const keyOf = new Map(Object.entries(base.formulaNumbers).map(([k, n]) => [n, k]));
  const nodeOf = new Map(Object.entries(base.sectionNumbers).map(([id, s]) => [`${s.chapter}#p${s.paragraph}`, id]));
  return {
    toSource: (line) => line
      .replace(/\{\{formula:(\d+\.\d+)\}\}/g, (all, n: string) => (keyOf.has(n) ? `{{formula:@${keyOf.get(n)}}}` : all))
      .replace(/\]\(ref:formula\/(\d+\.\d+)\)/g, (all, n: string) => (keyOf.has(n) ? `](ref:formula/@${keyOf.get(n)})` : all))
      .replace(/\]\(ref:chapter\/(\d+)#(p\d+)\)/g, (all, c: string, p: string) => (nodeOf.has(`${c}#${p}`) ? `](ref:section/${nodeOf.get(`${c}#${p}`)})` : all)),
  };
}

/** What the compiler adds to a line, removed so a compiled line can be found in its source. */
const normLine = (l: string) => l
  .replace(/\{\{formula:[^}]*\}\}/g, '{F}')
  .replace(/\]\(ref:[^)]*\)/g, '](R)')
  .replace(/\*\*([^*\d]+?) \d+\.\d+\*\*/g, '**$1**')
  .replace(/^:::formula\{.*$/, ':::formula')
  .replace(/\\lbrack /g, '[')
  .replace(/\\rbrack /g, ']')
  .replace(/^#{1,6}\s+/, '#')
  .replace(/\s+/g, ' ')
  .trim();
const unbracket = (x: string) => x.replace(/\\lbrack /g, '[').replace(/\\rbrack /g, ']');

/**
 * Applies the change from `base` to `target` (two compiled texts) to `src`, the source they were compiled from. Each changed
 * run of lines is placed in the source through the unchanged line next to it. Inside a changed line only the changed middle
 * is replaced (with a few characters of context to make it unique), so what the compiler adds elsewhere on the line, such as
 * statement numbers and references, stays in source form. Problems name the lines that could not be placed.
 */
function transfer(src: string, base: string, target: string, inv: Inverse): { text: string; problems: string[] } {
  if (!base.trim() && !src.trim()) return { text: target.split('\n').map(inv.toSource).join('\n'), problems: [] };
  const S = src.split('\n');
  const B = base.split('\n');
  const T = target.split('\n');
  const problems: string[] = [];
  const index = new Map<string, number[]>();
  S.forEach((l, i) => index.set(normLine(l), [...(index.get(normLine(l)) ?? []), i]));
  const srcLineOf = B.map((l) => { const hits = index.get(normLine(l)); return hits?.length === 1 ? hits[0] : -1; });
  const splices: { at: number; del: number; ins: string[] }[] = [];
  for (const op of diffLines(B, T)) {
    const oldL = B.slice(op.a0, op.a1);
    const newL = T.slice(op.b0, op.b1);
    if (oldL.length === newL.length) {
      for (let k = 0; k < oldL.length; k++) {
        if (!replaceMiddle(S, srcLineOf[op.a0 + k], oldL[k], newL[k], inv)) problems.push(`line not found in the source: ${oldL[k].slice(0, 80)}`);
      }
      continue;
    }
    // Whole lines inserted or deleted: placed by the source line of the base line before (or after) the run.
    const olds = oldL.map((_, k) => srcLineOf[op.a0 + k]);
    if (olds.some((x) => x < 0) || olds.some((x, k) => k > 0 && x !== olds[0] + k)) { problems.push(`deleted lines not found in the source: ${oldL[0].slice(0, 60)}`); continue; }
    const before = op.a0 > 0 ? srcLineOf[op.a0 - 1] : -1;
    const after = op.a1 < B.length ? srcLineOf[op.a1] : -1;
    const at = oldL.length ? olds[0] : before >= 0 ? before + 1 : after;
    if (at < 0) { problems.push(`no place in the source for: ${newL[0]?.slice(0, 60)}`); continue; }
    splices.push({ at, del: oldL.length, ins: newL.map(inv.toSource) });
  }
  for (const s of splices.sort((x, y) => y.at - x.at)) S.splice(s.at, s.del, ...s.ins);
  return { text: S.join('\n'), problems };
}

function replaceMiddle(S: string[], mapped: number, oldLine: string, newLine: string, inv: Inverse): boolean {
  // The compiler may have written [ ] in math as \lbrack \rbrack: try the line as compiled, then without them.
  for (const undo of [inv.toSource, (x: string) => unbracket(inv.toSource(x))]) {
    const o = undo(oldLine);
    const t = undo(newLine);
    let p = 0;
    while (p < o.length && p < t.length && o[p] === t[p]) p++;
    let s = 0;
    while (s < o.length - p && s < t.length - p && o[o.length - 1 - s] === t[t.length - 1 - s]) s++;
    for (const pad of [12, 6, 0]) {
      const p2 = Math.max(0, p - pad);
      const s2 = Math.max(0, s - pad);
      const oldMid = o.slice(p2, o.length - s2);
      if (!oldMid) continue;
      const newMid = t.slice(p2, t.length - s2);
      const once = (i: number) => S[i].split(oldMid).length === 2;
      const at = mapped >= 0 && once(mapped) ? mapped : (() => { const all = S.flatMap((_, i) => (once(i) ? [i] : [])); return all.length === 1 ? all[0] : -1; })();
      if (at < 0) continue;
      S[at] = S[at].replace(oldMid, () => newMid);
      return true;
    }
  }
  return false;
}

// ---------- the plan ----------

export interface PlanOptions {
  /**
   * The export the folder was published from. A unit the folder holds as in that export is left alone, so a change made in
   * the builder since the publish stays; a unit both changed is refused. Without it every difference is a candidate.
   */
  published?: Record<string, string | Uint8Array>;
  /** The question each exercise number of the published export stood for (the manifest's `exercises`). */
  publishedExercises?: Record<string, string>;
  /** The number of each formula key in the published export (the manifest's `formulas`). */
  publishedFormulas?: Record<string, string>;
  /** Write a graph whose graph lint has blocking findings, accepting them as the author's "Accept anyway". */
  acceptGraphLint?: boolean;
}

/**
 * Works out what a back-port of the books folder `target` (file path -> contents) would change in `input`, and checks it by
 * compiling. Pure: nothing is written.
 */
export function planBackport(input: BookInput, target: Record<string, string | Uint8Array>, opts: PlanOptions = {}): BackportPlan {
  const pub = opts.published;
  const base = compileBook(input);
  const inv = inverseOf(base);
  const units: BackportUnit[] = [];
  /** Graphs written in the builder's format, so grafici.json keeps differing from the folder by that formatting. */
  const formatted = new Set<string>();
  const pending: { unit: BackportUnit; changes: BackportChange[]; check: (after: CompiledBook) => boolean; owns: (file: string, quote?: string) => boolean }[] = [];
  // What already matches the books must still match after the changes: a caption on a figure two sections share, or a
  // renumbered formula, changes text no unit is about.
  const stable: { name: string; check: (after: CompiledBook) => boolean }[] = [];
  const same = (a: string | Uint8Array | undefined, b: string | Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array));
  const nodeOfParagraph = new Map(Object.entries(base.sectionNumbers).map(([id, s]) => [`${s.chapter}#p${s.paragraph}`, id]));
  const sourceOf = (nodeId: string) => {
    for (const ch of input.chapters) {
      if (ch.id === nodeId) return ch.intro;
      const s = ch.sections.find((x) => x.id === nodeId);
      if (s) return s.markdown;
    }
    return undefined;
  };
  const add = (u: BackportUnit) => { units.push(u); return u; };
  let numberingDiff: string | null = null;

  // Sections are numbered pN by their place in the outline. If the chapter files or their headings differ from the books,
  // the outline is not the one the books were exported with (an older revision approved again keeps its date), so pN
  // may be another section and nothing is mapped.
  const outlineOf = (f: Record<string, string | Uint8Array>) => Object.keys(f).filter((x) => /^chapters\/.*\.md$/.test(x)).sort()
    .map((x) => { const c = sectionsOf(text(f[x])!); return `${x}\n${c.front}${Object.entries(c.titles).map(([k, v]) => `${k} | ${v}`).join('\n')}`; });
  const [outlineBase, outlineBooks] = [outlineOf(base.files), outlineOf(target)];
  const outlineDiff = outlineBase.find((x, i) => x !== outlineBooks[i]) ?? (outlineBase.length !== outlineBooks.length ? 'the number of chapters' : undefined);
  // The books' formula references are numbers, which the builder's numbering must still give the same formulas.
  // A formula is told apart by its label: two formulas swapped in the builder keep the sequence of numbers but not the labels.
  const formulaBindings = (md: string) => [...md.matchAll(/^:::formula\{([^}\n]*)\}/gm)].map((m) => `${attrOf(m[1], 'id') ?? ''}=${attrOf(m[1], 'label') ?? ''}`);
  const numbering = (f: Record<string, string | Uint8Array>) => Object.keys(f).filter((x) => /^chapters\/.*\.md$/.test(x)).sort().map((x) => `${x}: ${formulaBindings(text(f[x])!).join(' | ')}`).join('\n');
  // With the manifest's key-to-number binding the check is exact; without it, the labels tell most swaps apart.
  const sameFormulas = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, n]) => b[k] === n);
  const formulaDiff = pub && (opts.publishedFormulas ? !sameFormulas(opts.publishedFormulas, base.formulaNumbers) : numbering(pub) !== numbering(base.files));
  const files = outlineDiff || formulaDiff ? new Set<string>() : new Set([...Object.keys(base.files), ...Object.keys(target)]);
  // Units the books left as published but the builder changed since: the back-port must leave them as the builder has them,
  // including through a figure caption that two sections share.
  const kept: { name: string; check: (after: CompiledBook) => boolean }[] = [];
  // Exercises are numbered by their place, so one added or removed in the builder since the publish shifts the numbers of
  // the others, also when the books did not touch the exercise files.
  const exerciseIds = (md: string | undefined) => Object.keys(exercisesOf(md ?? '')).sort().join();
  for (const file of ['esercizi.md', 'esami.md']) {
    if (files.has(file) && exerciseIds(text(base.files[file])) !== exerciseIds(text(target[file]))) numberingDiff ??= file;
  }
  // The same numbers can stand for other questions (one deleted and one added in the builder), so the binding is compared too.
  if (opts.publishedExercises && files.size) {
    const now = exerciseQuestions(input);
    const moved = [...new Set([...Object.keys(now), ...Object.keys(opts.publishedExercises)])].sort().find((k) => now[k] !== opts.publishedExercises![k]);
    if (moved) numberingDiff ??= moved.split('#')[0];
  }
  for (const file of [...files].sort()) {
    const was = base.files[file];
    const now = target[file];
    if (same(was, now)) { stable.push({ name: file, check: (after) => same(after.files[file], now) }); continue; }
    // The folder left this file as published: what differs was changed in the builder since, and stays. The package header
    // and smartbook.json are still listed below, as the compiler's.
    if (pub && file !== 'ptsb.json' && file !== 'smartbook.json' && (same(pub[file], now) || (pub[file] === undefined && now === undefined))) {
      kept.push({ name: file, check: (after) => (was === undefined ? after.files[file] === undefined : same(after.files[file], was)) });
      continue;
    }
    if (file === 'ptsb.json') { add({ unit: file, kind: 'file', status: 'compiler-owned', reason: 'package header, written at export' }); continue; }
    if (was === undefined || now === undefined) { add({ unit: file, kind: 'file', status: 'unmapped', reason: was === undefined ? 'only in the books folder' : 'missing from the books folder' }); continue; }
    if (file === 'smartbook.json') {
      const [a, b] = [JSON.parse(text(was)!), JSON.parse(text(now)!)];
      const same = JSON.stringify({ ...a, version: null }) === JSON.stringify({ ...b, version: null });
      add({ unit: file, kind: 'file', status: same ? 'compiler-owned' : 'unmapped', reason: same ? `version ${b.version} is set when the book is published` : 'book settings differ' });
      continue;
    }
    if (/^chapters\/\d+-.*\.md$/.test(file)) { chapterUnits(file, text(was)!, text(now)!, text(pub?.[file])); continue; }
    if (file === 'esercizi.md' || file === 'esami.md') { questionUnits(file, text(was)!, text(now)!, text(pub?.[file])); continue; }
    if (file === 'grafici.json') { graphUnits(text(was)!, text(now)!, text(pub?.[file])); continue; }
    add({ unit: file, kind: 'file', status: 'unmapped', reason: file.startsWith('assets/') ? 'the figure file itself changed' : 'the back-port does not read this file' });
  }

  function chapterUnits(file: string, was: string, now: string, published?: string) {
    const b = sectionsOf(was);
    const t = sectionsOf(now);
    const e = published === undefined ? undefined : sectionsOf(published);
    const number = Number(/^chapters\/(\d+)/.exec(file)![1]);
    for (const key of new Set([...Object.keys(b.bodies), ...Object.keys(t.bodies)])) {
      const unit = `${file}#${key}`;
      if (!(key in b.bodies) || !(key in t.bodies)) { add({ unit, kind: 'section', status: 'unmapped', reason: key in b.bodies ? 'section removed in the books' : 'section added in the books' }); continue; }
      if (b.bodies[key] === t.bodies[key]) { stable.push({ name: unit, check: (after) => sectionsOf(text(after.files[file]) ?? '').bodies[key] === t.bodies[key] }); continue; }
      if (e) {
        const was = e.bodies[key];
        if (was === t.bodies[key]) { // not edited in the books: the builder's text since the publish stays
          kept.push({ name: unit, check: (after) => sectionsOf(text(after.files[file]) ?? '').bodies[key] === b.bodies[key] });
          continue;
        }
        if (was === undefined) { add({ unit, kind: 'section', status: 'unmapped', reason: 'section added in the books' }); continue; }
        if (foldImages(b.bodies[key]) !== foldImages(was)) {
          add({ unit, kind: 'section', status: 'refused', reason: 'changed in the builder since the publish, and in the books' });
          kept.push({ name: unit, check: (after) => sectionsOf(text(after.files[file]) ?? '').bodies[key] === b.bodies[key] });
          continue;
        }
        const added = [...newLines(was, t.bodies[key], (l) => /^#{1,6}\s/.test(l)), ...newFormulaIds(was, t.bodies[key])];
        if (added.length) { add({ unit, kind: 'section', status: 'refused', reason: `adds what the export does not have, which shifts numbers or headings: ${added.join(', ')}` }); continue; }
      }
      if (foldImages(b.bodies[key]) === foldImages(t.bodies[key])) {
        add({ unit, kind: 'caption', status: 'compiler-owned', reason: 'the compiler now writes super- and subscripts in captions' });
        continue;
      }
      const nodeId = nodeOfParagraph.get(`${number}#${key}`);
      const src = nodeId === undefined ? undefined : sourceOf(nodeId);
      if (nodeId === undefined || src === undefined) { add({ unit, kind: 'section', status: 'unmapped', reason: 'no section of the outline has this number' }); continue; }
      // Image lines are written from the asset row, not from the text: a changed caption or alt goes to the asset.
      const changes: BackportChange[] = [];
      const problems: string[] = [];
      const baseImages = new Map(b.bodies[key].split('\n').filter((l) => IMAGE_LINE.test(l)).map((l) => [attrOf(l, 'src') ?? '', l]));
      const tBody = t.bodies[key].split('\n').map((l) => {
        if (!IMAGE_LINE.test(l)) return l;
        const old = baseImages.get(attrOf(l, 'src') ?? '');
        if (old === undefined) { problems.push(`figure added: ${attrOf(l, 'src')}`); return l; }
        if (foldImageLine(old) !== foldImageLine(l)) {
          const filename = (attrOf(l, 'src') ?? '').replace(/^assets\//, '');
          changes.push({ kind: 'asset', filename, caption: (attrOf(l, 'caption') ?? '').replace(/^Fig\.\s*[\d.]+\s*[—-]\s*/, ''), alt: attrOf(l, 'alt') ?? '' });
        }
        return old;
      }).join('\n');
      const r = transfer(src, b.bodies[key], tBody, inv);
      problems.push(...r.problems);
      if (problems.length) { add({ unit, kind: 'section', status: 'unmapped', reason: problems.join('; '), target: nodeId }); continue; }
      if (r.text !== src) changes.unshift({ kind: 'section', nodeId, markdown: r.text });
      const onlyCaption = changes.every((c) => c.kind === 'asset');
      const u = add({ unit, kind: onlyCaption ? 'caption' : 'section', status: 'mapped', target: nodeId });
      pending.push({
        unit: u, changes,
        check: (after) => foldImages(sectionsOf(text(after.files[file]) ?? '').bodies[key] ?? '') === foldImages(t.bodies[key]),
        owns: (f) => f === nodeId || f === file,
      });
    }
  }

  function questionUnits(file: string, was: string, now: string, published?: string) {
    const b = exercisesOf(was);
    const t = exercisesOf(now);
    const e = published === undefined ? undefined : exercisesOf(published);
    // Exercises are numbered by their place, so a question added or removed since the export shifts every number after it.
    if (Object.keys(b).sort().join() !== Object.keys(t).sort().join()) { numberingDiff = file; return; }
    // Exercise id -> question id: the book compiled once more with each statement replaced by its question id.
    const questionOf = new Map(Object.entries(exerciseQuestions(input)).filter(([k]) => k.startsWith(`${file}#`)).map(([k, q]) => [k.slice(file.length + 1), q]));
    for (const id of new Set([...Object.keys(b), ...Object.keys(t)])) {
      const unit = `${file}#${id}`;
      if (JSON.stringify(b[id]) === JSON.stringify(t[id])) { stable.push({ name: unit, check: (after) => JSON.stringify(exercisesOf(text(after.files[file]) ?? '')[id]) === JSON.stringify(t[id]) }); continue; }
      if (e) {
        if (JSON.stringify(e[id]) === JSON.stringify(t[id])) { // not edited in the books
          kept.push({ name: unit, check: (after) => JSON.stringify(exercisesOf(text(after.files[file]) ?? '')[id]) === JSON.stringify(b[id]) });
          continue;
        }
        if (JSON.stringify(b[id]) !== JSON.stringify(e[id])) {
          add({ unit, kind: 'question', status: 'refused', reason: 'changed in the builder since the publish, and in the books' });
          kept.push({ name: unit, check: (after) => JSON.stringify(exercisesOf(text(after.files[file]) ?? '')[id]) === JSON.stringify(b[id]) });
          continue;
        }
      }
      const q = input.questions.find((x) => x.id === questionOf.get(id));
      if (!q) { add({ unit, kind: 'question', status: 'unmapped', reason: 'no question compiles to this exercise' }); continue; }
      if (b[id].attrs !== t[id].attrs) add({ unit: `${unit} attributes`, kind: 'question', status: 'unmapped', reason: 'difficulty or chapter changed', target: q.id });
      // The bold line above an exam statement is the compiler's: its label for a generated question, or the exam session.
      const header = (s: string) => (file === 'esami.md' && (q.origin === 'generated' || q.examGroup) ? /^(\*\*[^\n]*\*\*)\n\n/.exec(s)?.[1] ?? '' : '');
      const strip = (s: string) => s.slice(header(s) ? header(s).length + 2 : 0);
      const [hb, ht] = [header(b[id].statement), header(t[id].statement)];
      if (hb !== ht) {
        add(q.origin === 'generated'
          ? { unit: `${unit} label`, kind: 'question', status: 'compiler-owned', reason: `the compiler writes ${hb || 'no label'} above a generated exam question`, target: q.id }
          : { unit: `${unit} session`, kind: 'question', status: 'unmapped', reason: "the session line comes from the question's exam group", target: q.id });
      }
      const parts: Partial<Record<Part, string>> = {};
      const problems: string[] = [];
      for (const part of ['statement', 'hint', 'solution'] as const) {
        const [pb, pt] = part === 'statement' ? [strip(b[id][part]), strip(t[id][part])] : [b[id][part], t[id][part]];
        if (pb === pt) continue;
        const r = transfer(q[part] ?? '', pb, pt, inv);
        problems.push(...r.problems.map((p) => `${part}: ${p}`));
        if (r.text !== (q[part] ?? '')) parts[part] = r.text;
      }
      if (problems.length) { add({ unit, kind: 'question', status: 'unmapped', reason: problems.join('; '), target: q.id }); continue; }
      if (!Object.keys(parts).length) continue; // only the label or the attributes differ, listed above
      const u = add({ unit, kind: 'question', status: 'mapped', target: q.id });
      const comparable = (e: ExerciseParts | undefined) => (e ? JSON.stringify([strip(e.statement), e.hint, e.solution]) : '');
      pending.push({
        unit: u, changes: [{ kind: 'question', questionId: q.id, parts }],
        check: (after) => comparable(exercisesOf(text(after.files[file]) ?? '')[id]) === comparable(t[id]),
        owns: (f) => f === `question:${q.id}`,
      });
    }
  }

  function graphUnits(was: string, now: string, published?: string) {
    const byId = (s: string) => new Map((JSON.parse(s) as Record<string, unknown>[]).map((g) => [String(g.id), g]));
    const [b, t] = [byId(was), byId(now)];
    const e = published === undefined ? undefined : byId(published);
    for (const id of new Set([...b.keys(), ...t.keys()])) {
      const unit = `grafici.json#${id}`;
      if (JSON.stringify(b.get(id)) === JSON.stringify(t.get(id))) { stable.push({ name: unit, check: (after) => JSON.stringify(byId(text(after.files['grafici.json']) ?? '[]').get(id)) === JSON.stringify(t.get(id)) }); continue; }
      if (e) {
        if (JSON.stringify(e.get(id)) === JSON.stringify(t.get(id))) { // not edited in the books
          kept.push({ name: unit, check: (after) => JSON.stringify(byId(text(after.files['grafici.json']) ?? '[]').get(id)) === JSON.stringify(b.get(id)) });
          continue;
        }
        // A builder change that is only the graph formatter's (normalize-graphs) is no conflict with an edit in the books.
        const asFormatted = (g: Record<string, unknown> | undefined) => JSON.stringify(g && formatGraphPayload(g, { language: input.meta.language }));
        if (asFormatted(b.get(id)) !== asFormatted(e.get(id))) {
          add({ unit, kind: 'graph', status: 'refused', reason: 'changed in the builder since the publish, and in the books' });
          kept.push({ name: unit, check: (after) => JSON.stringify(byId(text(after.files['grafici.json']) ?? '[]').get(id)) === JSON.stringify(b.get(id)) });
          continue;
        }
      }
      // The builder formats every graph it saves (updateEnrichmentPayload), so the plan writes and checks the formatted one.
      const folder = t.get(id);
      const payload = folder && formatGraphPayload(folder, { language: input.meta.language });
      if (folder && JSON.stringify(payload) !== JSON.stringify(folder)) formatted.add(unit);
      // A graph whose check failed is held out of the export, so it can be in the books folder and missing from `b`.
      const row = input.enrichments.find((x) => x.kind === 'graph' && String(x.payload.id) === id);
      if (!payload || !row) { add({ unit, kind: 'graph', status: 'unmapped', reason: payload ? 'graph added in the books' : 'graph removed in the books' }); continue; }
      const check = checkFunctionGraph(payload);
      if (!check.ok) { add({ unit, kind: 'graph', status: 'refused', reason: `the builder's graph check fails on the books version: ${check.detail}`, target: row.id }); continue; }
      // A blocking graph lint finding is written only when the run accepts it, as an author's "Accept anyway".
      // The acceptances follow the trace names the formatter writes, as updateEnrichmentPayload carries them.
      const acceptedKeys = formatLintKeys(row.lintAccepted, { language: input.meta.language });
      const blocking = graphLintCheck(payload, acceptedKeys).findings.filter((f) => f.severity === 'block' && !acceptedKeys.includes(lintKey(f)));
      if (blocking.length && !opts.acceptGraphLint) {
        add({ unit, kind: 'graph', status: 'refused', reason: `the graph lint blocks it: ${blocking.map(lintKey).join(', ')} (add --accept-graph-lint to write it anyway)`, target: row.id });
        continue;
      }
      const u = add({ unit, kind: 'graph', status: 'mapped', target: row.id, ...(blocking.length ? { reason: `graph lint accepted: ${blocking.map(lintKey).join(', ')}` } : {}) });
      const title = typeof payload.title === 'string' ? payload.title : row.id;
      pending.push({
        unit: u, changes: [{ kind: 'graph', enrichmentId: row.id, payload }],
        check: (after) => JSON.stringify(byId(text(after.files['grafici.json']) ?? '[]').get(id)) === JSON.stringify(payload),
        owns: (f, quote) => f === 'grafici.json' && quote === title,
      });
    }
  }

  // Compile with every mapped change; refuse the units that do not come out as in the books or that add a serious finding,
  // and compile again without them, until every unit left passes.
  const baseSerious = serious(base.findings);
  let after = base;
  let bookRefusal: string | null = outlineDiff ? `the outline differs from the one the books were exported with, at ${outlineDiff.split('\n')[0]}`
    : formulaDiff ? 'the builder numbers its formulas differently from the export the books were published from, so a formula number in the books may point at another formula'
    : numberingDiff ? `${numberingDiff} does not hold the same exercises as the books, so their numbers may point at other questions` : null;
  for (;;) {
    const live = pending.filter((p) => p.unit.status === 'mapped');
    after = compileBook(applyChanges(input, live.flatMap((p) => p.changes)));
    let refusedNow = 0;
    for (const p of live) {
      if (!p.check(after)) { Object.assign(p.unit, { status: 'refused', reason: 'the new compile does not reproduce the books text' }); refusedNow++; }
    }
    for (const [key, f] of serious(after.findings)) {
      if (f.length <= (baseSerious.get(key)?.length ?? 0)) continue;
      const owners = live.filter((p) => p.unit.status === 'mapped' && p.owns(f[0].file, f[0].quote));
      for (const p of owners) { Object.assign(p.unit, { status: 'refused', reason: `adds a ${f[0].severity} finding: ${f[0].rule}: ${f[0].message}` }); refusedNow++; }
      if (!owners.length && !live.some((p) => p.unit.status === 'refused' && p.owns(f[0].file, f[0].quote))) bookRefusal ??= `${f[0].severity} finding with no unit to blame: ${f[0].rule} in ${f[0].file}: ${f[0].message}`;
    }
    if (bookRefusal || !refusedNow) break;
  }
  const broken = stable.find((x) => !x.check(after));
  if (broken) bookRefusal ??= `${broken.name} matches the books now and would no longer match`;
  const changed = kept.find((x) => !x.check(after));
  if (changed) bookRefusal ??= `${changed.name} was changed in the builder since the publish, and the back-port would change it too`;
  if (bookRefusal) {
    for (const p of pending) if (p.unit.status === 'mapped') Object.assign(p.unit, { status: 'refused', reason: 'the book was refused as a whole' });
    after = base;
  }

  const changes = pending.filter((p) => p.unit.status === 'mapped').flatMap((p) => p.changes);
  const residual: BackportPlan['residual'] = [];
  for (const file of [...new Set([...Object.keys(after.files), ...Object.keys(target)])].sort()) {
    const [a, b] = [after.files[file], target[file]];
    if (a !== undefined && b !== undefined && Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array))) continue;
    const causes = units.filter((u) => u.status !== 'mapped' && (u.unit === file || u.unit.startsWith(`${file}#`))).map((u) => `${u.unit}: ${u.status}${u.reason ? ` (${u.reason})` : ''}`);
    // A section that was back-ported can still hold a caption the compiler now writes with super- and subscripts.
    const captionsOnly = a !== undefined && b !== undefined && foldImages(text(a)!) === foldImages(text(b)!);
    if (captionsOnly && !causes.length) causes.push('captions: the compiler now writes super- and subscripts');
    for (const u of units) if (u.status === 'mapped' && formatted.has(u.unit) && u.unit.startsWith(`${file}#`)) causes.push(`${u.unit}: written as the graph formatter writes it (Unicode maths, decimal commas, colours, ticks)`);
    residual.push({ file, causes: causes.length ? causes : ['unexplained'] });
  }
  return { units, changes, base, after, bookRefusal, residual };
}

/** Blocker and major findings grouped by the file they are in and their rule, as the fix guard counts them. */
function serious(findings: LintFinding[]): Map<string, LintFinding[]> {
  const out = new Map<string, LintFinding[]>();
  for (const f of findings) {
    if (f.severity !== 'blocker' && f.severity !== 'major') continue;
    // Findings on a generated file are told apart by their passage (for a graph, its title).
    const key = `${f.file}${f.file.endsWith('.json') ? `#${f.quote ?? ''}` : ''}|${f.rule}:${f.severity}`;
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

export function applyChanges(input: BookInput, changes: BackportChange[]): BookInput {
  const next = structuredClone(input);
  for (const c of changes) {
    if (c.kind === 'section') {
      for (const ch of next.chapters) {
        if (ch.id === c.nodeId) ch.intro = c.markdown;
        for (const s of ch.sections) if (s.id === c.nodeId) s.markdown = c.markdown;
      }
    } else if (c.kind === 'asset') {
      const a = next.assets.find((x) => x.filename === c.filename);
      if (a) Object.assign(a, { caption: c.caption, alt: c.alt });
    } else if (c.kind === 'question') {
      const q = next.questions.find((x) => x.id === c.questionId);
      if (q) Object.assign(q, c.parts);
    } else {
      const e = next.enrichments.find((x) => x.id === c.enrichmentId);
      // As updateEnrichmentPayload with acceptLint does: the lint's findings are accepted and the numeric check decides, together
      // with the graph's other checks when the payload is the one the builder has.
      const fresh = graphLintCheck(c.payload).findings.map(lintKey);
      const format = (p: Record<string, unknown>) => JSON.stringify(formatGraphPayload(p, { language: input.meta.language }));
      const kept = e && format(c.payload) === format(e.payload) ? e.checks.filter((k) => k.method !== 'numeric' && k.method !== 'lint') : [];
      if (e) Object.assign(e, { payload: c.payload, status: checkFunctionGraph(c.payload).ok && kept.every((k) => k.ok) ? 'verified' : 'issue', lintAccepted: [...new Set([...formatLintKeys(e.lintAccepted, { language: input.meta.language }), ...fresh])] });
    }
  }
  return next;
}

// ---------- writing the plan ----------

export interface BackportResult extends BackportPlan {
  written: boolean;
  /** Open blocker review issues of the project before and after (equal in a dry run). */
  openBlockers: { before: number; after: number };
}

/**
 * Back-ports the books folder `fromDir` into the project. The folder must have been published with `npm run publish-book`:
 * its .builder.json names the export it came from, which is the baseline, and a folder without one is refused. The units are
 * checked as in `planBackport`; then, unless `dryRun`, the mapped changes are written in one transaction as author edits:
 * sections as human revisions (`rewriteHead`), questions through `updateQuestion` as the back-port's (which marks them
 * edited, so no AI fix overwrites them), graphs through `updateEnrichmentPayload` (which runs the graph check) and captions on
 * the asset row. Inside the same transaction the book is compiled from the database again and must equal the checked
 * compile, or nothing is written.
 */
export function backportProject(ctx: AppContext, projectId: string, fromDir: string, opts: { dryRun?: boolean; acceptGraphLint?: boolean } = {}): BackportResult {
  const manifest = readManifest(fromDir);
  if (!manifest) throw new Error(`${fromDir} has no ${MANIFEST}, so the export it came from is unknown. Publish the book with npm run publish-book first, then make the fix on top of that.`);
  const published = publishedExport(ctx, projectId, manifest);
  if (typeof published === 'string') throw new Error(`${fromDir} cannot be back-ported: ${published}.`);
  const input = loadBookInput(ctx, projectId, { approvedOnly: true });
  const heads = currentHeads(ctx, projectId);
  const questions = new Map(input.questions.map((q) => [q.id, q]));
  if (!manifest.exercises || !manifest.formulas) throw new Error(`${fromDir}/${MANIFEST} does not say which question or formula each number stood for (it was written by an earlier publish-book). Publish the book again first.`);
  const plan = planBackport(input, bookFiles(fromDir), { published, publishedExercises: manifest.exercises, publishedFormulas: manifest.formulas, acceptGraphLint: opts.acceptGraphLint });
  const before = countUnresolvedBlockers(ctx, projectId);
  if (opts.dryRun || !plan.changes.length) return { ...plan, written: false, openBlockers: { before, after: before } };

  ctx.db.tx(() => {
    for (const c of plan.changes) {
      if (c.kind === 'section') {
        rewriteHead(ctx, projectId, c.nodeId, () => c.markdown, { origin: 'human', expectedHeadId: heads.get(c.nodeId)?.id ?? null });
      } else if (c.kind === 'question') {
        updateQuestion(ctx, c.questionId, questions.get(c.questionId)!.rev, c.parts, { origin: 'backport' });
      } else if (c.kind === 'graph') {
        updateEnrichmentPayload(ctx, c.enrichmentId, c.payload, { acceptLint: !!opts.acceptGraphLint });
      } else {
        // In place, not on a copy as the figure editor does: a copy gets a new file name, and the books name the old one.
        const rows = ctx.db.all<{ id: string; node_id: string | null }>('SELECT id, node_id FROM assets WHERE project_id = ? AND filename = ?', projectId, c.filename);
        if (rows.length !== 1) throw new Error(`Figure ${c.filename} is stored ${rows.length} times; its caption was not changed.`);
        ctx.db.update('assets', rows[0].id, { caption: c.caption, alt: c.alt });
        ctx.events.emit('asset.updated', { assetId: rows[0].id, nodeId: rows[0].node_id }, { projectId });
      }
    }
    const stored = loadBookInput(ctx, projectId, { approvedOnly: true });
    const again = compileBook(stored);
    for (const file of new Set([...Object.keys(again.files), ...Object.keys(plan.after.files)])) {
      const [a, b] = [again.files[file], plan.after.files[file]];
      if (a === undefined || b === undefined || !Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array))) {
        throw new Error(`After writing, ${file} does not compile as checked; nothing was written.`);
      }
    }
    for (const c of plan.changes) if (c.kind === 'section') relint(ctx, projectId, c.nodeId);
    closeGoneCompileNotes(ctx, projectId, stored, again.findings);
  });
  return { ...plan, written: true, openBlockers: { before, after: countUnresolvedBlockers(ctx, projectId) } };
}
