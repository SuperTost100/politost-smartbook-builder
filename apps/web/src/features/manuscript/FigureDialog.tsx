import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router-dom';
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

/** A value shown in a notice: long ones are cut. */
const shorten = (v: string) => (!v.trim() ? '(empty)' : v.length > 240 ? `${v.slice(0, 240)}…` : v);

/** "error at line 9, column 3: …" from the compiler: the line to mark in the editor. */
export const errorLineOf = (message: string | null): number | null => {
  const n = message ? /^error at line (\d+)/.exec(message)?.[1] : null;
  return n ? Number(n) : null;
};

/** A field of the dialog and what happened to its stored value while the author was typing. */
interface Field {
  value: string;
  set: (v: string) => void;
  /** The stored value, when it changed to something else after the author started editing the field: someone else saved it. */
  theirs: string | null;
  keepMine: () => void;
  takeTheirs: () => void;
}

/**
 * A text field that follows the service: when the stored value changes (a render writes new source, a save writes the caption) the
 * field takes it, unless the author changed the field since it was loaded. Text they typed is never replaced by a refresh. When the
 * stored value then differs from both what they started from and what they typed, `theirs` holds it until they choose.
 */
function useField(stored: string): Field {
  const [s, setS] = useState({ value: stored, base: stored });
  useEffect(() => setS((cur) => {
    if (cur.base === stored) return cur;
    if (cur.value === cur.base || cur.value === stored) return { value: stored, base: stored };
    return cur;
  }), [stored]);
  return {
    value: s.value,
    set: (v) => setS((cur) => ({ ...cur, value: v })),
    theirs: s.base !== stored && s.value !== stored ? stored : null,
    keepMine: () => setS((cur) => ({ ...cur, base: stored })),
    takeTheirs: () => setS({ value: stored, base: stored }),
  };
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
  });
  // While the dialog stays open, the figure it showed stays on screen when a Render or a save gives the figure a new asset, so the editor is not blanked. It is held (`stale`) because it names an asset and a head the book has left.
  // A dialog that was closed keeps nothing: the figure it last showed may have been replaced, so it opens on the loading state until the current one is read.
  const lastShown = useRef<FigureDetails | null>(null);
  const shown = open ? details.data ?? lastShown.current : null;
  lastShown.current = shown;
  const title = `Figure${number ? ` ${number}` : ''}`;
  if (!open) return null;
  if (shown) return <FigureEditor key={nodeId} details={shown} stale={!details.data} pid={pid} nodeId={nodeId} title={title} number={number} onClose={onClose} />;
  // The block no longer holds an image, or the image it names is not among the book's figures: nothing will ever load.
  const gone = !!section && !!headId && (!filename || (!!assets.data && !asset));
  const failed = details.error ?? assets.error;
  const retry = () => { void assets.refetch(); if (asset) void details.refetch(); };
  return (
    <Dialog open onClose={onClose} title={title} footer={<button type="button" className="ui-btn" onClick={onClose}>Close</button>}>
      {failed
        ? <div className="ui-banner ui-banner--warning" role="alert">{errorText(failed)} <button type="button" className="ui-btn ui-btn--link" onClick={retry}>Try again</button></div>
        : gone
          ? <div className="ui-banner ui-banner--warning" role="alert">{filename ? 'The picture of this figure is not among the book\'s figures any more.' : 'This figure is not in the section any more.'}</div>
          : <div className="ui-skeleton" style={{ height: 220 }} role="status" aria-label="Loading the figure" />}
    </Dialog>
  );
}

function FigureEditor({ details, stale, pid, nodeId, title, number, onClose }: { details: FigureDetails; stale: boolean; pid: string; nodeId: string; title: string; number: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const drawing = details.drawing;
  const route = { id: pid, nodeId, assetId: details.assetId };

  const captionField = useField(details.caption);
  const altField = useField(details.alt);
  const showsField = useField(drawing?.shows ?? '');
  const sourceField = useField(drawing?.source ?? '');
  const { value: caption, set: setCaption } = captionField;
  const { value: alt, set: setAlt } = altField;
  const { value: shows, set: setShows } = showsField;
  const { value: source, set: setSource } = sourceField;
  const [instruction, setInstruction] = useState('');
  const [asked, setAsked] = useState('');
  const [srcOpen, setSrcOpen] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  /** The author asked to close with unsaved fields and is being asked whether to discard them. */
  const [leaving, setLeaving] = useState(false);
  /** A Render or a Replace already changed the figure in the book, so closing the dialog undoes nothing. */
  const [applied, setApplied] = useState(false);
  const [redrawn, setRedrawn] = useState(false);
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
      setRedrawn(true);
      // No ['figure'] here: the figure's details are keyed by the section head and the asset, so the new picture is fetched under its own key, and asking again for the one the text left would answer 404.
      for (const key of [['section', pid, nodeId], ['assets', pid], ['preview', pid], ['history', pid, nodeId]]) void qc.invalidateQueries({ queryKey: key });
    } else if (run.data.status === 'failed') {
      const e = run.data.tasks.find((t) => t.error)?.error;
      setFailure(e ? `${e.message}${e.action ? ` ${e.action}` : ''}` : 'The drawing model could not redraw this figure.');
      setInstruction((now) => now || asked);
    }
  }, [runId, run.data, finished, qc, pid, nodeId, asked]);

  // ----- writes -----
  const done = (sv: SectionView) => applySectionView(qc, pid, sv);
  const render = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/render', { params: route, body: { baseRevId: details.headRevId, source } }),
    onSuccess: (sv) => { setCompileError(null); setError(null); setApplied(true); done(sv); toast('Rendered. The figure in the section is updated.'); },
    onError: (e) => { if (e instanceof ApiRequestError && e.code === 'does_not_compile') { setCompileError(e.message); setError(null); } else setError(errorText(e)); },
  });
  const redraw = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/redraw', { params: route, body: { baseRevId: details.headRevId, instruction: instruction.trim(), ...(drawing && shows.trim() && shows !== drawing.shows ? { shows } : {}) } }),
    onMutate: () => { setFailure(null); setError(null); setRedrawn(false); setAsked(instruction.trim()); },
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
      params: route, body: { baseRevId: details.headRevId, ...(caption !== details.caption ? { caption } : {}), ...(alt !== details.alt ? { alt } : {}), ...(drawing && shows !== drawing.shows ? { shows } : {}) },
    }),
    onSuccess: (sv) => {
      done(sv); toast('Figure saved'); setError(null);
      // A source the author has not rendered is not part of this save. Closing would drop it without the question, so the dialog stays.
      if (unrendered) { setApplied(true); setSrcOpen(true); } else onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const replace = useMutation({
    mutationFn: (file: File) => { const form = new FormData(); form.set('baseRevId', details.headRevId); form.set('file', file, file.name); return api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/replace', { params: route, form }); },
    onSuccess: (sv) => { setError(null); setApplied(true); done(sv); toast('Image replaced. The earlier figure is in the section history.'); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api('POST /api/projects/:id/sections/:nodeId/figures/:assetId/remove', { params: route, body: { baseRevId: details.headRevId } }),
    onSuccess: (sv) => { done(sv); toast('Figure removed. It stays in the section history.'); onClose(); },
    onError: (e) => { setRemoving(false); setError(errorText(e)); },
  });

  const rendering = render.isPending;
  const busy = rendering || redrawing || stale || save.isPending || replace.isPending || remove.isPending;
  const dirty = caption !== details.caption || alt !== details.alt || (!!drawing && shows !== drawing.shows);
  // The lint blocks an image without alt text, so an empty one is not saved.
  const altMissing = !alt.trim();
  const unrendered = !!drawing && source !== drawing.source;
  // Someone else saved a field the author has edited: nothing is written until they choose which text stays.
  const conflicts = [
    { field: captionField, what: 'caption', code: false },
    { field: altField, what: 'alt text', code: false },
    ...(drawing ? [{ field: showsField, what: 'description', code: false }, { field: sourceField, what: 'source', code: true }] : []),
  ].filter((c) => c.field.theirs !== null);
  const held = busy || conflicts.length > 0;
  const unsaved = dirty || unrendered;
  const requestClose = () => { if (unsaved) setLeaving(true); else onClose(); };
  // Leaving the page (reload, closing the tab) cannot wait for a question: the browser asks. A move inside the app (browser Back) gets the dialog's own question.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { if (blocker.state === 'blocked') setLeaving(true); }, [blocker.state]);
  const keepEditing = () => { setLeaving(false); if (blocker.state === 'blocked') blocker.reset(); };
  const discard = () => { if (blocker.state === 'blocked') blocker.proceed(); else onClose(); };
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
      onClose={requestClose}
      holdEscape={redrawing}
      className="fd"
      title={<>{title} <span className={`ui-badge${details.kind === 'drawing' ? ' ui-badge--accent' : ''} fd-kind`}>{KIND_LABEL[details.kind]}</span></>}
      footer={leaving ? (
        <>
          <div className="fd-foot-l"><span role="alert">Discard your changes to this figure?</span></div>
          <button type="button" className="ui-btn" onClick={keepEditing} autoFocus>Keep editing</button>
          <button type="button" className="ui-btn ui-btn--danger-solid" onClick={discard}>Discard</button>
        </>
      ) : (
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
          <button type="button" className="ui-btn" onClick={requestClose}>{applied ? 'Close' : 'Cancel'}</button>
          <button type="button" className="ui-btn ui-btn--accent" onClick={() => save.mutate()} disabled={held || !dirty || altMissing}>{save.isPending ? <><span className="ui-spinner" />Saving…</> : 'Save figure'}</button>
        </>
      )}
    >
      {conflicts.map(({ field, what, code }) => (
        <div key={what} className="ui-banner ui-banner--warning fd-conflict" role="alert">
          <div className="ui-banner__body">
            <span className="ui-banner__title">The {what} changed while you were editing</span>
            <span>
              It is now: {code ? <code className="fd-conflict__code">{shorten(field.theirs!)}</code> : <>“{shorten(field.theirs!)}”</>}. Your unsaved text is still in the field and nothing was overwritten. Keeping your version saves it over the new one.
            </span>
            <div className="ui-banner__actions">
              <button type="button" className="ui-btn ui-btn--accent ui-btn--sm" onClick={field.keepMine}>Keep my version</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={field.takeTheirs}>Use the other version</button>
            </div>
          </div>
        </div>
      ))}
      <p className="ui-field__hint fd-note">Render and Replace change the figure in the book at once, and the earlier one stays in the section history. A caption, alt text or description is saved with Save figure.</p>
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

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="fd-alt">Alt text</label>
            <textarea id="fd-alt" className="ui-textarea fd-alt" rows={2} value={alt} onChange={(e) => setAlt(e.target.value)} disabled={redrawing} aria-invalid={altMissing} aria-describedby="fd-alt-hint" />
            <span id="fd-alt-hint" className={`ui-field__hint${altMissing ? ' fd-alt-missing' : ''}`}>{altMissing ? 'Alt text is needed: a figure without it does not pass the check. ' : ''}What a reader who cannot see the figure is told in its place.</span>
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
                      <SourceEditor code value={source} onChange={setSource} onSave={() => { if (source.trim() && !held) render.mutate(); }} label="Drawing source" minRows={6} errorLine={errLine} />
                    </div>
                  )}
                  {compileError && (
                    <div className="fd-err" role="alert"><Icon name="alert" size={14} /><span>{compileError}</span></div>
                  )}
                  <div className="ui-row">
                    <button type="button" className="ui-btn ui-btn--sm" onClick={() => render.mutate()} disabled={held || !source.trim()}>
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
                  <form className="fd-redraw__row" onSubmit={(e) => { e.preventDefault(); if (instruction.trim() && shows.trim() && !held) redraw.mutate(); }}>
                    <label className="ui-sr" htmlFor="fd-instr">Instruction for the redraw</label>
                    <input id="fd-instr" className="ui-input" placeholder="Move the labels off the wires" value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={busy} />
                    <button type="submit" className="ui-btn" disabled={held || !instruction.trim() || !shows.trim()}><Icon name="sparkle" size={14} />Redraw with AI</button>
                  </form>
                )}
                {redrawn && !failure && <p className="fd-ok" role="status">Redrawn. The earlier drawing is in the section history.</p>}
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
