import type { Outline, OutlineChapter, OutlineSection, ProgramItem, Question, Topic } from '@smartbuilder/domain';
import { newId, slugify } from './format';

export function emptyOutline(): Outline {
  return { chapters: [], exclusions: [], programExclusions: [], notation: '' };
}

export function newChapter(n: number): OutlineChapter {
  const title = `Chapter ${n}`;
  return { id: newId('c'), slug: slugify(title), title, objectives: [], prerequisites: [], sections: [] };
}

export function newSection(): OutlineSection {
  return { id: newId('s'), title: 'New section', objectives: [], topicIds: [], depth: 'standard', subsections: [], programItems: [], role: 'content' };
}

export function move<T>(list: T[], from: number, dir: -1 | 1): T[] {
  const to = from + dir;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Merge section `from` into `into`: topics, objectives and subsections are kept, the title is kept from the target. */
export function mergeSections(sections: OutlineSection[], from: number, into: number): OutlineSection[] {
  const a = sections[into];
  const b = sections[from];
  if (!a || !b || from === into) return sections;
  const merged: OutlineSection = {
    ...a,
    objectives: [...a.objectives, ...b.objectives.filter((o) => !a.objectives.includes(o))],
    topicIds: [...new Set([...a.topicIds, ...b.topicIds])],
    programItems: [...new Set([...a.programItems, ...b.programItems])],
    depth: rank(a.depth) >= rank(b.depth) ? a.depth : b.depth,
    subsections: [...a.subsections, { id: newId('ss'), title: b.title, objectives: b.objectives }, ...b.subsections],
  };
  return sections.map((s, i) => (i === into ? merged : s)).filter((_, i) => i !== from);
}
const rank = (d: OutlineSection['depth']) => ({ brief: 0, standard: 1, deep: 2 })[d];

export interface TopicCoverage {
  topic: Topic;
  sections: { id: string; title: string; chapter: number; number: string }[];
  excludedReason: string | null;
}

export function coverage(outline: Outline, topics: Topic[]): TopicCoverage[] {
  const bySection = new Map<string, { id: string; title: string; chapter: number; number: string }[]>();
  outline.chapters.forEach((c, ci) => c.sections.forEach((s, si) => s.topicIds.forEach((t) => bySection.set(t, [...(bySection.get(t) ?? []), { id: s.id, title: s.title, chapter: ci + 1, number: `${ci + 1}.${si + 1}` }]))));
  const excl = new Map(outline.exclusions.map((e) => [e.topicId, e.reason]));
  return topics.map((topic) => ({ topic, sections: bySection.get(topic.id) ?? [], excludedReason: excl.get(topic.id) ?? null }));
}

/** Distinct authentic exam sessions in the book; the denominator for "appears in N of M". */
export function examSessionTotal(questions: Question[]): number {
  return new Set(questions.filter((q) => q.kind === 'exam' && q.examGroup).map((q) => q.examGroup)).size;
}

export function sessionsPhrase(n: number, total: number): string {
  if (n === 0) return 'Not in any exam session';
  if (total >= n) return `Appears in ${n} of ${total} exam sessions`;
  return `Appears in ${n} exam ${n === 1 ? 'session' : 'sessions'}`;
}

export interface ProgramItemCoverage {
  item: ProgramItem;
  sections: { id: string; title: string; number: string }[];
  excludedReason: string | null;
}

/** Where each program item is taught, and which items the outline leaves out on purpose. */
export function programCoverage(outline: Outline, items: ProgramItem[]): ProgramItemCoverage[] {
  const bySection = new Map<string, { id: string; title: string; number: string }[]>();
  outline.chapters.forEach((c, ci) => c.sections.forEach((s, si) => s.programItems.forEach((k) => bySection.set(k, [...(bySection.get(k) ?? []), { id: s.id, title: s.title, number: `${ci + 1}.${si + 1}` }]))));
  const excl = new Map(outline.programExclusions.map((e) => [e.item, e.reason]));
  return items.map((item) => ({ item, sections: bySection.get(item.key) ?? [], excludedReason: excl.get(item.key) ?? null }));
}
