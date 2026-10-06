/** Small LCS diff for the proposal view. Fine for section-sized text. */
export type DiffOp<T> = { type: 'eq' | 'del' | 'add'; a?: T; b?: T };

export function diffSeq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { out.push({ type: 'eq', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', a: a[i++] });
    else out.push({ type: 'add', b: b[j++] });
  }
  while (i < n) out.push({ type: 'del', a: a[i++] });
  while (j < m) out.push({ type: 'add', b: b[j++] });
  return out;
}

export interface WordPart { type: 'eq' | 'del' | 'add'; text: string }

export function diffWords(a: string, b: string): WordPart[] {
  const tok = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
  const ops = diffSeq(tok(a), tok(b));
  const parts: WordPart[] = [];
  for (const op of ops) {
    const text = (op.type === 'add' ? op.b : op.a) as string;
    const last = parts[parts.length - 1];
    if (last && last.type === op.type) last.text += text;
    else parts.push({ type: op.type, text });
  }
  return parts;
}

export interface BlockRow { kind: 'same' | 'changed' | 'removed' | 'added'; before?: string; after?: string }

/** Aligns two block lists; a run of removed blocks followed by added blocks is shown as changed pairs. */
export function diffBlocks(before: string[], after: string[]): BlockRow[] {
  const ops = diffSeq(before, after);
  const rows: BlockRow[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'eq') { rows.push({ kind: 'same', before: ops[k].a, after: ops[k].b }); k++; continue; }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].type !== 'eq') { if (ops[k].type === 'del') dels.push(ops[k].a as string); else adds.push(ops[k].b as string); k++; }
    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const d = dels[p];
      const a = adds[p];
      if (d !== undefined && a !== undefined) rows.push({ kind: 'changed', before: d, after: a });
      else if (d !== undefined) rows.push({ kind: 'removed', before: d });
      else rows.push({ kind: 'added', after: a });
    }
  }
  return rows;
}
