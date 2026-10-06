import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { diffBlocks, diffWords, type BlockRow } from '../../lib/diff';
import { timeAgo } from '../../lib/format';
import { useToast } from '../../components/Toast';

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

export function ProposalBanner({ pid, nodeId, section, onResolved }: { pid: string; nodeId: string; section: SectionView; onResolved: (sv: SectionView) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'inline' | 'side'>('inline');
  const [open, setOpen] = useState(true);
  const proposal = section.proposal!;
  const rows = useMemo(
    () => diffBlocks(splitBlocks(section.current?.markdown ?? '').map((b) => b.text), splitBlocks(proposal.markdown).map((b) => b.text)),
    [section.current?.markdown, proposal.markdown],
  );
  const changed = rows.filter((r) => r.kind !== 'same').length;
  const items = useMemo(() => {
    const out: ({ row: BlockRow } | { skipped: number })[] = [];
    for (const r of rows) {
      if (r.kind !== 'same') { out.push({ row: r }); continue; }
      const last = out[out.length - 1];
      if (last && 'skipped' in last) last.skipped++; else out.push({ skipped: 1 });
    }
    return out;
  }, [rows]);

  const decide = useMutation({
    mutationFn: (action: 'accept' | 'reject') => api('POST /api/projects/:id/sections/:nodeId/proposal', { params: { id: pid, nodeId }, body: { action, revId: proposal.id } }),
    onSuccess: (sv, action) => { toast(action === 'accept' ? 'Proposal accepted' : 'Proposal rejected'); onResolved(sv); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  return (
    <section className="pp-banner" aria-label="AI proposal">
      <div className="pp-head">
        <div className="ui-grow">
          <div className="pp-title">AI proposal ready</div>
          <div className="ui-muted pp-sub">{changed} {changed === 1 ? 'block differs' : 'blocks differ'} from the current text{proposal.model ? ` · ${proposal.model}` : ''} · {timeAgo(proposal.createdAt)}. The current text stays until you accept.</div>
        </div>
        <div className="ui-row">
          <div className="ui-tabs pp-mode" role="group" aria-label="Diff layout">
            <button type="button" className="ui-tab" aria-selected={mode === 'inline'} onClick={() => setMode('inline')}>Inline</button>
            <button type="button" className="ui-tab" aria-selected={mode === 'side'} onClick={() => setMode('side')}>Side by side</button>
          </div>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide changes' : 'Show changes'}</button>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => decide.mutate('reject')} disabled={decide.isPending}>Reject</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => decide.mutate('accept')} disabled={decide.isPending}>Accept</button>
        </div>
      </div>
      {open && (
        <div className={`pp-diff pp-diff--${mode}`}>
          {mode === 'side' && <div className="pp-cols pp-cols--head"><span className="ui-meta">Current</span><span className="ui-meta">Proposal</span></div>}
          {items.map((it, i) => {
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
      )}
    </section>
  );
}
