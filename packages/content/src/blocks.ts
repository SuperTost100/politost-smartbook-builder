/**
 * Editor blocks: a section split at blank lines, keeping ::: fenced blocks (including nested
 * hint/solution fences) and $$ display math whole. joinBlocks(splitBlocks(md)) returns md with
 * line endings normalized to \n, runs of blank lines collapsed to one, and no trailing blank lines.
 */
export interface Block {
  kind: 'heading' | 'paragraph' | 'formula' | 'math' | 'image' | 'list' | 'other';
  text: string;
}

const FENCE_OPEN = /^:::([a-z]+)(\{.*\})?\s*$/;
const FENCE_CLOSE = /^:::\s*$/;

export function splitBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];

  const flush = () => {
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) blocks.push({ kind: classify(buf), text: buf.join('\n') });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_OPEN.test(line.trim())) {
      flush();
      // Consume until the matching close, counting nested fences.
      const fenced = [line];
      let depth = 1;
      while (++i < lines.length) {
        fenced.push(lines[i]);
        const t = lines[i].trim();
        if (FENCE_OPEN.test(t)) depth++;
        else if (FENCE_CLOSE.test(t) && --depth === 0) break;
      }
      buf = fenced;
      flush();
      continue;
    }
    if (line.trim().startsWith('$$') && !buf.length) {
      // Display math: keep until the closing $$, even across blank lines.
      const math = [line];
      const single = line.trim().length > 2 && line.trim().endsWith('$$');
      if (!single) {
        while (++i < lines.length) {
          math.push(lines[i]);
          if (lines[i].trim().endsWith('$$')) break;
        }
      }
      buf = math;
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line) && !buf.length) {
      buf = [line];
      flush();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

export function joinBlocks(blocks: Block[]): string {
  return blocks.map((b) => b.text.replace(/\s+$/, '')).filter((t) => t.trim()).join('\n\n');
}

function classify(lines: string[]): Block['kind'] {
  const first = lines[0].trim();
  if (/^#{1,6}\s/.test(first)) return 'heading';
  if (first.startsWith(':::formula')) return 'formula';
  if (first.startsWith(':::image')) return 'image';
  if (first.startsWith(':::')) return 'other';
  if (first.startsWith('$$')) return 'math';
  if (/^([-*+]|\d+[.)])\s/.test(first)) return 'list';
  return 'paragraph';
}

/**
 * One flag per line: true for plain Markdown, false for code fences and ::: directive blocks (their fence lines included).
 * Text that must stay byte-identical (code, formulas, hints, figures) is the false lines.
 */
export function proseLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let code: string | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const fence = /^(```|~~~)(.*)$/.exec(t);
    if (code !== null) {
      if (fence && fence[1] === code) code = null;
      out.push(false);
    } else if (fence && !fence[2].includes('`')) {
      code = fence[1];
      out.push(false);
    } else if (/^:::[A-Za-z]/.test(t)) {
      out.push(false);
      // A figure is :::image{...} plus its closing ::: on the next line (see scan.ts).
      if (/^:::image\b/.test(t)) {
        if (lines[i + 1]?.trim() === ':::') { out.push(false); i++; }
      } else depth++;
    } else if (depth > 0 || /^:::\s*$/.test(t)) {
      if (/^:::\s*$/.test(t) && depth > 0) depth--;
      out.push(false);
    } else out.push(true);
  }
  return out;
}
