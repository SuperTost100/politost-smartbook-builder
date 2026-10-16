import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { qk } from '../../lib/queries';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';

type Scope = 'section' | 'chapter' | 'book';

/** Adds figures to the open section, its chapter or the whole book. The text itself never changes. */
export function FiguresDialog({ open, onClose, pid, nodeId, sectionTitle, chapter }: {
  open: boolean; onClose: () => void; pid: string; nodeId: string | null; sectionTitle: string; chapter: { chapterId: string; number: number; title: string } | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>(nodeId ? 'section' : 'chapter');
  const [missingOnly, setMissingOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Each opening starts from the open section; the dialog is mounted before the section has loaded.
  useEffect(() => { if (open) { setScope(nodeId ? 'section' : 'chapter'); setError(null); } }, [open, nodeId]);
  const go = useMutation({
    mutationFn: () => scope === 'section'
      ? api('POST /api/projects/:id/sections/:nodeId/figures', { params: { id: pid, nodeId: nodeId! } })
      : api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'figures', scope: { ...(scope === 'chapter' ? { chapterIds: [chapter!.chapterId] } : {}), missingOnly } } }),
    onSuccess: (run) => {
      const n = run.counts ? Object.values(run.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;
      toast(scope === 'section' ? 'Adding figures to this section' : `Adding figures to ${n} section${n === 1 ? '' : 's'}`, { action: { label: 'Open run', to: `/books/${pid}/run` } });
      setError(null);
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const options: { id: Scope; label: string; detail: string; disabled?: boolean }[] = [
    { id: 'section', label: 'This section', detail: sectionTitle || 'The open section', disabled: !nodeId },
    { id: 'chapter', label: 'This chapter', detail: chapter ? `Chapter ${chapter.number}: ${chapter.title}` : 'No chapter open', disabled: !chapter },
    { id: 'book', label: 'Whole book', detail: 'Every written section. Each section is one model run.' },
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add figures"
      footer={<><button type="button" className="ui-btn" onClick={onClose}>Cancel</button><button type="submit" form="fg-form" className="ui-btn ui-btn--accent" disabled={go.isPending}>{go.isPending ? 'Starting…' : 'Add figures'}</button></>}
    >
      <form id="fg-form" className="ui-stack" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <fieldset className="fg-scope">
          <legend className="ui-field__label">Where</legend>
          {options.map((o) => (
            <label key={o.id} className={`fg-radio${o.disabled ? ' is-disabled' : ''}`}>
              <input type="radio" name="fg-scope" checked={scope === o.id} disabled={o.disabled} onChange={() => setScope(o.id)} autoFocus={scope === o.id} />
              <span><strong>{o.label}</strong><br /><span className="ui-muted ui-wrap">{o.detail}</span></span>
            </label>
          ))}
        </fieldset>
        {scope !== 'section' && (
          <label className="ui-check"><input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />Only sections without a figure</label>
        )}
        <p className="ui-field__hint">Figures go in after the paragraphs they illustrate; the text stays as it is. A section gets at most 3 figures, and no picture appears twice in the book.</p>
        {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}
