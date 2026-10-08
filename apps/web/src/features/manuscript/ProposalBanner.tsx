import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText, isConflict } from '../../lib/api';
import { qk } from '../../lib/queries';
import { timeAgo } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { DiffList, countChanged } from './DiffList';

export function ProposalBanner({ pid, nodeId, section, onResolved }: { pid: string; nodeId: string; section: SectionView; onResolved: (sv: SectionView) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'inline' | 'side'>('inline');
  const [open, setOpen] = useState(true);
  const [stale, setStale] = useState<string | null>(null);
  const proposal = section.proposal!;
  // The head the diff below is computed against. It is sent with the decision, so the service can refuse
  // to apply the proposal over text that changed after the author looked at it.
  const headRevId = section.current?.id ?? null;
  const before = useMemo(() => splitBlocks(section.current?.markdown ?? '').map((b) => b.text), [section.current?.markdown]);
  const after = useMemo(() => splitBlocks(proposal.markdown).map((b) => b.text), [proposal.markdown]);
  const changed = useMemo(() => countChanged(before, after), [before, after]);

  const decide = useMutation({
    mutationFn: (action: 'accept' | 'reject') => api('POST /api/projects/:id/sections/:nodeId/proposal', { params: { id: pid, nodeId }, body: { action, revId: proposal.id, headRevId } }),
    onSuccess: (sv, action) => { setStale(null); toast(action === 'accept' ? 'Proposal accepted' : 'Proposal rejected'); onResolved(sv); },
    onError: (e) => { if (isConflict(e)) setStale(errorText(e)); else toast(errorText(e), { tone: 'danger' }); },
  });
  const reload = useMutation({
    mutationFn: () => qc.fetchQuery({ queryKey: qk.section(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId } }), staleTime: 0 }),
    onSuccess: () => { setStale(null); void qc.invalidateQueries({ queryKey: qk.manuscript(pid) }); },
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
          <button type="button" className="ui-btn ui-btn--accent ui-btn--sm" onClick={() => decide.mutate('accept')} disabled={decide.isPending || !!stale}>Accept</button>
        </div>
      </div>
      {stale && (
        <div className="ui-banner ui-banner--warning" role="alert">
          <div className="ui-banner__body">
            <span className="ui-banner__title">The text changed after this comparison was shown</span>
            <span>{stale}</span>
            <div className="ui-banner__actions"><button type="button" className="ui-btn ui-btn--sm" onClick={() => reload.mutate()} disabled={reload.isPending}>Reload</button></div>
          </div>
        </div>
      )}
      {open && <DiffList before={before} after={after} mode={mode} headLabels={['Current', 'Proposal']} />}
    </section>
  );
}
