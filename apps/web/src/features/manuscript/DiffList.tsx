import { useMemo } from 'react';
import { diffBlocks, diffWords, type BlockRow } from '../../lib/diff';

function Words({ before, after, side }: { before: string; after: string; side: 'before' | 'after' | 'inline' }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === 'eq') return <span key={i}>{p.text}</span>;
        if (p.type === 'del') return side === 'after' ? null : <del key={i} className="pp-del">{p.text}</del>;
        return side === 'before' ? null : <ins key={i} className="pp-add">{p.text}</ins>;
      })}
    </>
  );
}

/** Block-level diff of two block lists: changed blocks only, with runs of unchanged blocks collapsed. */
export function DiffList({ before, after, mode, headLabels }: { before: string[]; after: string[]; mode: 'inline' | 'side'; headLabels?: [string, string] }) {
  const rows = useMemo(() => diffBlocks(before, after), [before, after]);
  const items = useMemo(() => {
    const out: ({ row: BlockRow } | { skipped: number })[] = [];
    for (const r of rows) {
      if (r.kind !== 'same') { out.push({ row: r }); continue; }
      const last = out[out.length - 1];
      if (last && 'skipped' in last) last.skipped++; else out.push({ skipped: 1 });
    }
    return out;
  }, [rows]);
  const changed = rows.filter((r) => r.kind !== 'same').length;
  return (
    <div className={`pp-diff pp-diff--${mode}`}>
      {mode === 'side' && headLabels && <div className="pp-cols pp-cols--head"><span className="ui-meta">{headLabels[0]}</span><span className="ui-meta">{headLabels[1]}</span></div>}
      {changed === 0 && <div className="pp-skip ui-muted">No differences</div>}
      {changed > 0 && items.map((it, i) => {
        if ('skipped' in it) return <div key={i} className="pp-skip ui-muted">{it.skipped} unchanged {it.skipped === 1 ? 'block' : 'blocks'}</div>;
        const r = it.row;
        return mode === 'inline' ? (
          <div key={i} className={`pp-row pp-row--${r.kind}`}>
            {r.kind === 'changed' && <Words before={r.before!} after={r.after!} side="inline" />}
            {r.kind === 'removed' && <del className="pp-del">{r.before}</del>}
            {r.kind === 'added' && <ins className="pp-add">{r.after}</ins>}
          </div>
        ) : (
          <div key={i} className={`pp-cols pp-row pp-row--${r.kind}`}>
            <div>{r.kind === 'changed' ? <Words before={r.before!} after={r.after!} side="before" /> : r.kind === 'removed' ? <del className="pp-del">{r.before}</del> : null}</div>
            <div>{r.kind === 'changed' ? <Words before={r.before!} after={r.after!} side="after" /> : r.kind === 'added' ? <ins className="pp-add">{r.after}</ins> : null}</div>
          </div>
        );
      })}
    </div>
  );
}

export function countChanged(before: string[], after: string[]): number {
  return diffBlocks(before, after).filter((r) => r.kind !== 'same').length;
}
