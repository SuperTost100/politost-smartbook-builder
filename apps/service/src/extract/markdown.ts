// Markdown (uploaded or derived from HTML) -> page units split at H1/H2 headings, plus a heading index.
import type { SourceIndexEntry } from '@smartbuilder/domain';

export interface Unit { label: string; text: string }

const MAX_UNIT_CHARS = 8000;
const TARGET_CHARS = 5000;

interface Heading { level: number; title: string; line: number }

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (f) { fence = fence ? (l.trim().startsWith(fence[0] ?? '') ? null : fence) : f[1]; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2].replace(/[*_`]/g, '').trim(), line: i });
  });
  return out;
}

export function splitMarkdown(markdown: string, fallbackLabel: string): { units: Unit[]; entries: SourceIndexEntry[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const hs = headings(lines);
  const cuts = hs.filter((h) => h.level <= 2);
  const units: Unit[] = [];
  /** First unit index of each section: sections[0] is the intro (may be empty), then one per cut. */
  const startUnit: number[] = [];

  const push = (label: string, text: string) => {
    startUnit.push(units.length);
    const t = text.trim();
    if (!t) return;
    if (t.length <= MAX_UNIT_CHARS) { units.push({ label, text: t }); return; }
    // Long sections are cut at blank lines so no unit is too big to read in one go.
    const parts: string[] = [];
    let buf = '';
    for (const para of t.split(/\n{2,}/)) {
      if (buf && buf.length + para.length > TARGET_CHARS) { parts.push(buf.trim()); buf = ''; }
      buf += (buf ? '\n\n' : '') + para;
    }
    if (buf.trim()) parts.push(buf.trim());
    parts.forEach((part, i) => units.push({ label: parts.length > 1 ? `${label} (${i + 1})` : label, text: part }));
  };

  const firstCut = cuts[0]?.line ?? lines.length;
  push(fallbackLabel, lines.slice(0, firstCut).join('\n'));
  cuts.forEach((c, i) => push(c.title, lines.slice(c.line, cuts[i + 1]?.line ?? lines.length).join('\n')));
  if (!units.length) push(fallbackLabel, markdown);

  const sectionOfLine = (line: number) => {
    let sec = 0;
    cuts.forEach((c, i) => { if (c.line <= line) sec = i + 1; });
    return sec;
  };
  const entries: SourceIndexEntry[] = hs
    .filter((h) => h.level <= 3)
    .map((h) => ({ title: h.title, level: h.level, page: Math.min(units.length - 1, startUnit[sectionOfLine(h.line)] ?? 0) }));
  return { units, entries };
}
