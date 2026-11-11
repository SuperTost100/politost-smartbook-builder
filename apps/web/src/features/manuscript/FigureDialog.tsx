import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { FigureDetails, FigureKindName, SectionView } from '@smartbuilder/domain';
import { api, apiUrl, ApiRequestError, errorText } from '../../lib/api';
import { imageFilename } from '../../lib/blocks';
import { timeAgo } from '../../lib/format';
import { applySectionView, useAssets, useRun } from '../../lib/queries';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { SourceEditor } from '../../components/SourceEditor';
import { useToast } from '../../components/Toast';
import './figure-dialog.css';

/** Same limit as the service (figures/author.ts). */
export const FIGURE_UPLOAD_MAX = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp';
const UPLOAD_EXT = /\.(png|jpe?g|svg|webp)$/i;

/** Why a chosen file cannot be used, or null. The service checks again. */
export function uploadProblem(f: File): string | null {
  if (!UPLOAD_EXT.test(f.name)) return 'Choose a PNG, JPEG, SVG or WebP image.';
  if (f.size > FIGURE_UPLOAD_MAX) return `This image is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`;
  return null;
}

const KIND_LABEL: Record<FigureKindName, string> = { drawing: 'Drawn', photo: 'Photo', image: 'Uploaded image', plot: 'Plot', structure: 'Structure', diagram: 'Diagram' };
const MADE: Record<FigureKindName, string> = { drawing: 'Drawn', photo: 'Photo added', image: 'Uploaded', plot: 'Drawn by the builder', structure: 'Drawn by the builder', diagram: 'Drawn by the builder' };
const FINISHED = ['completed', 'failed', 'cancelled'];

/** "error at line 9, column 3: …" from the compiler: the line to mark in the editor. */
export const errorLineOf = (message: string | null): number | null => {
  const n = message ? /^error at line (\d+)/.exec(message)?.[1] : null;
  return n ? Number(n) : null;
};

/**
 * A text field that follows the service: when the stored value changes (a render writes new source, a save writes the caption) the
 * field takes it, unless the author changed the field since it was loaded. Text they typed is never replaced by a refresh.
 */
function useField(stored: string): [string, (v: string) => void] {
  const [value, setValue] = useState(stored);
  const last = useRef(stored);
  useEffect(() => {
    const before = last.current;
    last.current = stored;
    if (stored !== before) setValue((now) => (now === before ? stored : now));
  }, [stored]);
  return [value, setValue];
}

interface Props {
  open: boolean;
  onClose: () => void;
  pid: string;
  nodeId: string;
  section: SectionView | undefined;
  /** The figure block the dialog was opened on. */
  blockIndex: number | null;
  /** "4.3", from the compiled text. */
  number: string | null;
}

/**
 * The dialog of one figure in the section's text. The figure is found again from the block it sits in, because a render, a
 * redraw or a replacement gives the block a new picture (a new asset), and the earlier one stays in the section history.
 */
export function FigureDialog({ open, onClose, pid, nodeId, section, blockIndex, number }: Props) {
  const assets = useAssets(pid);
  const markdown = section?.current?.markdown ?? '';
  const filename = useMemo(() => (blockIndex === null ? null : imageFilename(splitBlocks(markdown)[blockIndex]?.text ?? '')), [markdown, blockIndex]);
  const asset = assets.data?.find((a) => a.filename === filename);
  const headId = section?.current?.id ?? null;
  const details = useQuery({
    queryKey: ['figure', pid, nodeId, asset?.id ?? '', headId ?? ''],
    queryFn: () => api('GET /api/projects/:id/sections/:nodeId/figures/:assetId', { params: { id: pid, nodeId, assetId: asset!.id } }),
    enabled: open && !!asset && !!headId,
    placeholderData: keepPreviousData,
  });
  const title = `Figure${number ? ` ${number}` : ''}`;
  if (!open) return null;
  if (details.data) return <FigureEditor key={nodeId} details={details.data} pid={pid} nodeId={nodeId} title={title} number={number} onClose={onClose} />;
  const gone = !!section && !filename && !!headId;
  return (
    <Dialog open onClose={onClose} title={title} footer={<button type="button" className="ui-btn" onClick={onClose}>Close</button>}>
      {gone || details.error || assets.error
        ? <div className="ui-banner ui-banner--warning" role="alert">{details.error || assets.error ? errorText(details.error ?? assets.error) : 'This figure is not in the section any more.'}</div>
        : <div className="ui-skeleton" style={{ height: 220 }} role="status" aria-label="Loading the figure" />}
    </Dialog>
  );
}

function FigureEditor({ details, pid, nodeId, title, number, onClose }: { details: FigureDetails; pid: string; nodeId: string; title: string; number: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const drawing = details.drawing;
  const route = { id: pid, nodeId, assetId: details.assetId };

  const [caption, setCaption] = useField(details.caption);
  const [shows, setShows] = useField(drawing?.shows ?? '');
  const [source, setSource] = useField(drawing?.source ?? '');
  const [instruction, setInstruction] = useState('');
  const [asked, setAsked] = useState('');
  const [srcOpen, setSrcOpen] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The compiler's message belongs to the source it was given, so it goes when the stored source changes.
  useEffect(() => setCompileError(null), [drawing?.source]);
  useEffect(() => { if (compileError) setSrcOpen(true); }, [compileError]);

  // ----- the redraw task -----
  const [runId, setRunId] = useState<string | null>(details.redrawRunId);
  const handled = useRef(new Set<string>());
  useEffect(() => { if (details.redrawRunId && !handled.current.has(details.redrawRunId)) setRunId(details.redrawRunId); }, [details.redrawRunId]);
  const run = useRun(runId ?? undefined, true);
  const finished = !!run.data && FINISHED.includes(run.data.status);
  const redrawing = !!runId && !finished;
  useEffect(() => {
    if (!runId || !run.data || !finished || handled.current.has(runId)) return;
    handled.current.add(runId);
    setRunId(null);
    if (run.data.status === 'completed') {
      toast('Redrawn. The earlier drawing is in the section history.');
      for (const key of [['section', pid, nodeId], ['figure', pid], ['assets', pid], ['preview', pid], ['history', pid, nodeId]]) void qc.invalidateQueries({ queryKey: key });
    } else if (run.data.status === 'failed') {
      const e = run.data.tasks.find((t) => t.error)?.error;
      setFailure(e ? `${e.message}${e.action ? ` ${e.action}` : ''}` : 'The drawing model could not redraw this figure.');
      setInstruction((now) => now || asked);
    }
  }, [runId, run.data, finished, toast, qc, pid, nodeId, asked]);

  // ----- writes -----
  const done = (sv: SectionView) => applySectionView(qc, pid, sv);
  const render = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/render', { params: route, body: { baseRevId: details.headRevId, source } }),
    onSuccess: (sv) => { setCompileError(null); setError(null); done(sv); toast('Rendered. The figure in the section is updated.'); },
    onError: (e) => { if (e instanceof ApiRequestError && e.code === 'does_not_compile') { setCompileError(e.message); setError(null); } else setError(errorText(e)); },
  });
  const redraw = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/redraw', { params: route, body: { baseRevId: details.headRevId, instruction: instruction.trim(), ...(drawing && shows.trim() && shows !== drawing.shows ? { shows } : {}) } }),
    onMutate: () => { setFailure(null); setError(null); setAsked(instruction.trim()); },
    onSuccess: (r) => { setRunId(r.id); setInstruction(''); },
    onError: (e) => setError(errorText(e)),
  });
  const cancelRedraw = useMutation({
    mutationFn: () => api('POST /api/runs/:runId/cancel', { params: { runId: runId! } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['run'] }); },
    onError: (e) => setError(errorText(e)),
  });
  const save = useMutation({
    mutationFn: () => api('PATCH /api/projects/:id/sections/:nodeId/figures/:assetId', {
      params: route, body: { baseRevId: details.headRevId, ...(caption !== details.caption ? { caption } : {}), ...(drawing && shows !== drawing.shows ? { shows } : {}) },
    }),
    onSuccess: (sv) => { done(sv); toast('Figure saved'); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  const replace = useMutation({
    mutationFn: (file: File) => { const form = new FormData(); form.set('baseRevId', details.headRevId); form.set('file', file, file.name); return api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/replace', { params: route, form }); },
    onSuccess: (sv) => { setError(null); done(sv); toast('Image replaced. The earlier figure is in the section history.'); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/remove', { params: route, body: { baseRevId: details.headRevId } }),
    onSuccess: (sv) => { done(sv); toast('Figure removed. It stays in the section history.'); onClose(); },
    onError: (e) => { setRemoving(false); setError(errorText(e)); },
  });

  const rendering = render.isPending;
  const busy = rendering || redrawing || save.isPending || replace.isPending || remove.isPending;
  const dirty = caption !== details.caption || (!!drawing && shows !== drawing.shows);
  const unrendered = !!drawing && source !== drawing.source;
  const errLine = errorLineOf(compileError);
  const preview = apiUrl('GET /api/assets/:assetId/file', { params: { assetId: details.assetId } });
  const showCaption = caption.trim();
  const showRedraw = redraw.isPending || redrawing;

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const problem = uploadProblem(file);
    if (problem) { setError(problem); return; }
    replace.mutate(file);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      holdEscape={redrawing}
      className="fd"
      title={<>{title} <span className={`ui-badge${details.kind === 'drawing' ? ' ui-badge--accent' : ''} fd-kind`}>{KIND_LABEL[details.kind]}</span></>}
      footer={(
        <>
          <div className="fd-foot-l">
            {removing ? (
              <span className="ui-row">
                <span className="ui-muted">Remove this figure from the section?</span>
                <button type="button" className="ui-btn ui-btn--danger-solid ui-btn--sm" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove figure</button>
                <button type="button" className="ui-btn ui-btn--sm" onClick={() => setRemoving(false)}>Keep</button>
              </span>
            ) : <button type="button" className="ui-btn ui-btn--ghost ui-btn--danger ui-btn--sm" onClick={() => setRemoving(true)} disabled={busy}><Icon name="trash" />Remove figure</button>}
          </div>
          <button type="button" className="ui-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ui-btn ui-btn--accent" onClick={() => save.mutate()} disabled={busy || !dirty}>{save.isPending ? <><span className="ui-spinner" />Saving…</> : 'Save figure'}</button>
        </>
      )}
    >
      <div className="fd-grid">
        <div className="fd-col">
          <div className={`sb-figure-frame fd-preview${rendering || showRedraw ? ' is-busy' : ''}${compileError ? ' is-stale' : ''}`}>
            <img src={preview} alt={details.alt || `Figure: ${details.caption}`} />
            {rendering && <div className="fd-over" role="status"><span className="fd-over__chip"><span className="ui-spinner" aria-hidden="true" />Rendering the source…</span></div>}
            {showRedraw && <div className="fd-over" role="status"><span className="fd-over__chip"><span className="ui-spinner" aria-hidden="true" />Redrawing with your instruction…</span></div>}
          </div>
          {!compileError && <p className="fd-meta">{MADE[details.kind]} {timeAgo(details.createdAt)}</p>}
          {compileError && <p className="fd-stale"><Icon name="alert" size={14} /><span>The source below does not compile. The book still shows the last drawing that did.</span></p>}
          <div className="ui-row">
            <button type="button" className="ui-btn ui-btn--sm" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name="upload" size={14} />Replace with an image…</button>
            <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="ui-sr" tabIndex={-1} aria-label="Choose an image to replace this figure" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <p className="ui-field__hint">PNG, JPEG, SVG or WebP, up to 2 MB.{drawing ? ' The figure then stops being a drawing and its source is removed from the section. The drawing stays in the section history.' : ' The new image takes the place of this one. This one stays in the section history.'}</p>
          {replace.isPending && <p className="fd-meta" role="status"><span className="ui-spinner" aria-hidden="true" /> Uploading…</p>}
        </div>

        <div className="fd-col">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="fd-caption">Caption</label>
            <input id="fd-caption" className="ui-input" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={redrawing} />
            <span className="ui-field__hint">{number && <><span className="fd-caption-id">Fig. {number}</span> is</>}{!number && 'The figure number is'} added in front of the caption automatically.{details.kind === 'photo' ? ' The credit line is part of the caption: keep it.' : ''}{!showCaption ? ' Without a caption the figure shows no text under it.' : ''}</span>
          </div>

          {drawing && (
            <>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="fd-shows">What it shows</label>
                <textarea id="fd-shows" className="ui-textarea fd-shows" rows={4} value={shows} onChange={(e) => setShows(e.target.value)} disabled={redrawing} />
                <span className="ui-field__hint">The writer's description of the drawing. Redraw with AI starts from it. Changing it does not change the picture until you redraw.</span>
              </div>

              <details className="fd-details" open={srcOpen} onToggle={(e) => setSrcOpen(e.currentTarget.open)}>
                <summary>
                  <Icon name="chevron-right" size={14} className="fd-chev" />Source
                  <span className="ui-badge ui-badge--mono">{drawing.engine === 'typst' ? 'Typst' : 'schemdraw'}</span>
                  {compileError && <span className="ui-badge ui-badge--danger">Does not compile</span>}
                </summary>
                <div className="fd-details__body">
                  {srcOpen && (
                    <div className="fd-code">
                      <SourceEditor code value={source} onChange={setSource} onSave={() => { if (source.trim() && !busy) render.mutate(); }} label="Drawing source" minRows={6} errorLine={errLine} />
                    </div>
                  )}
                  {compileError && (
                    <div className="fd-err" role="alert"><Icon name="alert" size={14} /><span>{compileError}</span></div>
                  )}
                  <div className="ui-row">
                    <button type="button" className="ui-btn ui-btn--sm" onClick={() => render.mutate()} disabled={busy || !source.trim()}>
                      {rendering ? <><span className="ui-spinner" />Rendering…</> : <><Icon name="play" size={14} />Render</>}
                    </button>
                    <span className="fd-ok" role="status">
                      {rendering ? 'Rendering…' : compileError ? 'Not rendered. Fix the line above, then press Render.' : unrendered ? 'Not rendered yet. The figure still shows the last render.' : `Rendered ${timeAgo(details.createdAt)}`}
                    </span>
                  </div>
                </div>
              </details>

              <div className="fd-redraw">
                <div>
                  <h3 className="fd-sub">Redraw with AI</h3>
                  <p className="ui-field__hint">The drawing model gets the description, the current source and your line, then the result is rendered. The earlier drawing stays in this section's history.{unrendered ? ' Render your changes to the source first: the redraw starts from the rendered source.' : ''}</p>
                </div>
                {showRedraw ? (
                  <div className="fd-redraw__prog" role="status">
                    <span className="ui-spinner" aria-hidden="true" />
                    <span className="ui-grow">Writing the new source, then rendering it.{asked ? ` “${asked}”` : ''}</span>
                    {runId && <button type="button" className="ui-btn ui-btn--sm" onClick={() => cancelRedraw.mutate()} disabled={cancelRedraw.isPending}>Cancel</button>}
                  </div>
                ) : (
                  <form className="fd-redraw__row" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) redraw.mutate(); }}>
                    <label className="ui-sr" htmlFor="fd-instr">Instruction for the redraw</label>
                    <input id="fd-instr" className="ui-input" placeholder="Move the labels off the wires" value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={busy} />
                    <button type="submit" className="ui-btn" disabled={busy || !instruction.trim()}><Icon name="sparkle" size={14} />Redraw with AI</button>
                  </form>
                )}
                {failure && (
                  <div className="ui-banner ui-banner--danger" role="alert">
                    <div className="ui-banner__body">
                      <span className="ui-banner__title">The redraw failed. The figure is unchanged.</span>
                      <span className="fd-failure">{failure}</span>
                      <div className="ui-banner__actions"><button type="button" className="ui-btn ui-btn--sm" onClick={() => setFailure(null)}>Dismiss</button></div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {error && <div className="ui-banner ui-banner--danger fd-error" role="alert">{error}</div>}
    </Dialog>
  );
}
