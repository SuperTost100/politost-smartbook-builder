import { splitBlocks, type Block } from '@smartbuilder/content/blocks';
import type { ReviewIssue, SectionView } from '@smartbuilder/domain';

export interface MappedBlock {
  index: number;
  kind: Block['kind'];
  /** Source dialect text, what the author edits. */
  source: string;
  /** Compiled reader Markdown for the same block, or null when the compiler output does not line up. */
  compiled: string | null;
}

export interface MappedSection {
  blocks: MappedBlock[];
  /** "p3" and the title from the compiler's heading, when present. */
  heading: { id: string; title: string } | null;
  aligned: boolean;
}

const HEADING = /^## (p\d+) \| (.+)$/;

/** Source block i maps to compiled block i+1: the compiler adds one heading first. */
export function mapSection(section: SectionView): MappedSection {
  const src = splitBlocks(section.current?.markdown ?? '');
  const comp = splitBlocks(section.compiled ?? '');
  const h = comp[0] && HEADING.exec(comp[0].text.trim());
  const offset = h ? 1 : 0;
  const aligned = comp.length - offset === src.length;
  return {
    heading: h ? { id: h[1], title: h[2] } : null,
    aligned,
    blocks: src.map((b, i) => ({ index: i, kind: b.kind, source: b.text, compiled: comp[i + offset]?.text ?? null })),
  };
}

const norm = (s: string) => s.replace(/[\s*_`$\\]+/g, ' ').trim().toLowerCase();

/** Finds the block an issue's verbatim quote sits in. */
export function blockOfIssue(issue: ReviewIssue, blocks: MappedBlock[]): number | null {
  const q = norm(issue.quote);
  if (!q) return null;
  const probes = [q, q.slice(0, 48)];
  for (const probe of probes) {
    if (probe.length < 6) continue;
    const hit = blocks.find((b) => norm(b.source).includes(probe) || (b.compiled && norm(b.compiled).includes(probe)));
    if (hit) return hit.index;
  }
  return null;
}

export const OPEN_ISSUE = new Set(['open', 'proposed']);

export const BLOCK_LABEL: Record<Block['kind'], string> = {
  heading: 'heading', paragraph: 'paragraph', formula: 'numbered formula', math: 'display math', image: 'figure', list: 'list', other: 'block',
};

export function superscript(n: number): string {
  const map = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  return `⁽${String(n).split('').map((d) => map[Number(d)]).join('')}⁾`;
}
