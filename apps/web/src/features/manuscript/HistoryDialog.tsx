import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk } from '../../lib/queries';
import { dateTime } from '../../lib/format';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';

const ORIGIN: Record<string, string> = { ai: 'AI', human: 'You', repair: 'Repair' };
const ORIGIN_TONE: Record<string, string> = { ai: 'info', human: 'primary', repair: 'warning' };

export function HistoryDialog({ open, onClose, pid, nodeId, currentId, onRestored }: { open: boolean; onClose: () => void; pid: string; nodeId: string; currentId: string | null; onRestored: (sv: SectionView) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const history = useQuery({ queryKey: qk.history(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId/history', { params: { id: pid, nodeId } }), enabled: open });
  const restore = useMutation({
    mutationFn: (revId: string) => api('POST /api/projects/:id/sections/:nodeId/restore', { params: { id: pid, nodeId }, body: { revId } }),
    onSuccess: (sv) => { toast('Revision restored'); void qc.invalidateQueries({ queryKey: qk.history(pid, nodeId) }); onRestored(sv); onClose(); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });
  const revs = [...(history.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Dialog open={open} onClose={onClose} title="History" variant="drawer">
      <p className="ui-muted">Every edit is kept. Restoring a revision adds it as a new revision, so nothing is lost.</p>
      {history.isLoading && <div className="ui-skeleton" style={{ height: 80 }} />}
      {history.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(history.error)}</div>}
      <ol className="hi-list">
        {revs.map((r) => (
          <li key={r.id} className="hi-item">
            <div className="ui-row">
              <span className={`ui-badge ui-badge--${ORIGIN_TONE[r.origin] ?? ''}`}>{ORIGIN[r.origin] ?? r.origin}</span>
              {r.status === 'current' && <span className="ui-badge ui-badge--success">Current</span>}
              {r.status === 'proposal' && <span className="ui-badge ui-badge--info">Proposal</span>}
              {r.status === 'rejected' && <span className="ui-badge">Rejected</span>}
              <span className="ui-muted hi-time">{dateTime(r.createdAt)}</span>
            </div>
            {r.model && <div className="ui-mono ui-muted">{r.model}</div>}
            <p className="hi-snippet">{r.markdown.replace(/\s+/g, ' ').slice(0, 180)}{r.markdown.length > 180 ? '…' : ''}</p>
            <div>
              <button type="button" className="ui-btn ui-btn--sm" disabled={r.id === currentId || restore.isPending} onClick={() => restore.mutate(r.id)}>Restore</button>
            </div>
          </li>
        ))}
      </ol>
      {!history.isLoading && revs.length === 0 && <p className="ui-muted">No revisions yet.</p>}
    </Dialog>
  );
}
