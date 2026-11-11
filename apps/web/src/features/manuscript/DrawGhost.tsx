import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { useRun } from '../../lib/queries';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import './add-figure.css';

const FINISHED = ['completed', 'failed', 'cancelled'];

/**
 * The placeholder after a block while the illustrator draws a described figure (a task that can take about a minute). When the
 * task ends the figure is in the text and the placeholder goes; when it fails the placeholder says why until it is dismissed.
 */
export function DrawGhost({ pid, nodeId, runId, afterBlock, onDone }: { pid: string; nodeId: string; runId: string; afterBlock: number; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const run = useRun(runId, true);
  const [failure, setFailure] = useState<string | null>(null);
  const handled = useRef(false);
  const cancel = useMutation({
    mutationFn: () => api('POST /api/runs/:runId/cancel', { params: { runId } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['run'] }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  const status = run.data?.status;
  useEffect(() => {
    if (!status || !FINISHED.includes(status) || handled.current) return;
    handled.current = true;
    for (const key of [['section', pid, nodeId], ['manuscript', pid], ['preview', pid], ['assets', pid], ['history', pid, nodeId]]) void qc.invalidateQueries({ queryKey: key });
    if (status === 'completed') {
      toast(`Figure added after block ${afterBlock + 1}. Select it and choose Edit figure to change the drawing.`);
      onDone();
    } else if (status === 'failed') {
      const e = run.data?.tasks.find((t) => t.error)?.error;
      setFailure(e ? `${e.message}${e.action ? ` ${e.action}` : ''}` : 'The illustrator could not draw this figure.');
    } else onDone();
  }, [status, run.data, qc, pid, nodeId, afterBlock, toast, onDone]);

  if (failure) {
    return (
      <div className="ms-ghost-fig ms-ghost-fig--failed" role="alert">
        <Icon name="alert" size={16} />
        <span className="ms-ghost-fig__text"><strong>The figure could not be drawn.</strong> {failure}</span>
        <button type="button" className="ui-btn ui-btn--sm" onClick={onDone}>Dismiss</button>
      </div>
    );
  }
  return (
    <div className="ms-ghost-fig" role="status">
      <span className="ui-spinner" aria-hidden="true" />
      <span className="ui-grow">Drawing the figure from your description, then rendering it.</span>
      <button type="button" className="ui-btn ui-btn--sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel</button>
    </div>
  );
}
