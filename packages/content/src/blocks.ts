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
