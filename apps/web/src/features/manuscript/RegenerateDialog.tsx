import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';

export function RegenerateDialog({ open, onClose, pid, nodeId, selection, label }: { open: boolean; onClose: () => void; pid: string; nodeId: string; selection?: string; label: string }) {
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/regenerate', { params: { id: pid, nodeId }, body: { instruction: instruction.trim() || undefined, selection } }),
    onSuccess: () => { toast(selection ? 'Regenerating selection' : 'Regenerating section', { action: { label: 'Open run', to: `/books/${pid}/run` } }); setInstruction(''); setError(null); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={label}
      footer={<><button type="button" className="ui-btn" onClick={onClose}>Cancel</button><button type="submit" form="rg-form" className="ui-btn ui-btn--accent" disabled={go.isPending}>{go.isPending ? 'Starting…' : label}</button></>}
    >
      <form id="rg-form" className="ui-stack" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        {selection && <blockquote className="rg-sel ui-serif">{selection.length > 320 ? `${selection.slice(0, 320)}…` : selection}</blockquote>}
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="rg-inst">Instruction <span className="ui-muted">(optional)</span></label>
          <textarea id="rg-inst" className="ui-textarea" rows={3} autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Explain the limit with an example before the definition" />
          <span className="ui-field__hint">The new text arrives as a proposal. Your current text stays until you accept it.</span>
        </div>
        {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}
