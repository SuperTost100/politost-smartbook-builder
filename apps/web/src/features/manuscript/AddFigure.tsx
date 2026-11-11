import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PhotoCandidate, RunSummary } from '@smartbuilder/domain';
import { api, apiUrl, errorText } from '../../lib/api';
import { applySectionView } from '../../lib/queries';
import { Icon, type IconName } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { IMAGE_ACCEPT, uploadProblem } from './FigureDialog';
import './add-figure.css';

type Mode = 'describe' | 'upload' | 'search';
const SERVICE: Record<PhotoCandidate['provider'], string> = { commons: 'Wikimedia Commons', pixabay: 'Pixabay', pexels: 'Pexels' };

export interface FigureTarget { baseRevId: string; afterBlock: number }

interface Props {
  pid: string;
  nodeId: string;
  /** Drawing needs the figures option of the book. */
  drawing: boolean;
  /** Saves the block's unsaved text, then says which text the figure is added to and which block it goes after. */
  prepare: () => Promise<FigureTarget>;
  /** A drawing was started: the page shows a placeholder after the block until the task ends. */
  onDrawing: (run: RunSummary, afterBlock: number) => void;
}

/** "Add figure" in the action row of the block editor: a small chooser under the button, with the three ways in. */
export function AddFigure({ pid, nodeId, drawing, prepare, onDrawing }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const [description, setDescription] = useState('');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [query, setQuery] = useState('');
  const [photoCaption, setPhotoCaption] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const close = (focusButton = true) => { setOpen(false); setMode(null); setError(null); if (focusButton) button.current?.focus(); };
  const choose = (m: Mode) => { setMode(m); setError(null); };

  // Click outside closes the chooser; Escape closes it first and the editor only afterwards.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { if (open && !mode) root.current?.querySelector<HTMLElement>('.ins-opt')?.focus(); }, [open, mode]);

  const finished = (sv: Parameters<typeof applySectionView>[2], what: string, afterBlock: number) => {
    applySectionView(qc, pid, sv);
    toast(`${what} added after block ${afterBlock + 1}`);
    close();
    setFile(null); setCaption(''); setDescription(''); setPhotoCaption(''); setPicked(null);
  };

  const draw = useMutation({
    mutationFn: async () => {
      const t = await prepare();
      const run = await api('POST /api/projects/:id/sections/:nodeId/figures/draw', { params: { id: pid, nodeId }, body: { ...t, description: description.trim(), caption: caption.trim() } });
      return { run, at: t.afterBlock };
    },
    onSuccess: ({ run, at }) => { onDrawing(run, at); close(false); setDescription(''); setCaption(''); },
    onError: (e) => setError(errorText(e)),
  });
  const upload = useMutation({
    mutationFn: async () => {
      const t = await prepare();
      const form = new FormData();
      form.set('baseRevId', t.baseRevId); form.set('afterBlock', String(t.afterBlock)); form.set('caption', caption.trim()); form.set('file', file!, file!.name);
      return { sv: await api('POST /api/projects/:id/sections/:nodeId/figures/upload', { params: { id: pid, nodeId }, form }), at: t.afterBlock };
    },
    onSuccess: ({ sv, at }) => finished(sv, 'Image', at),
    onError: (e) => setError(errorText(e)),
  });
  const search = useMutation({
    mutationFn: () => api('POST /api/projects/:id/figure-photos/search', { params: { id: pid }, body: { query: query.trim() } }),
    onMutate: () => { setError(null); setPicked(null); },
    onError: (e) => setError(errorText(e)),
  });
  const photo = useMutation({
    mutationFn: async () => {
      const t = await prepare();
      return { sv: await api('POST /api/projects/:id/sections/:nodeId/figures/photo', { params: { id: pid, nodeId }, body: { ...t, searchId: search.data!.searchId, index: picked!, caption: photoCaption.trim() } }), at: t.afterBlock };
    },
    onSuccess: ({ sv, at }) => finished(sv, 'Photo', at),
    onError: (e) => setError(errorText(e)),
  });

  // The chooser opens below the button: bring all of it into view, also when a panel or an error line makes it taller.
  useEffect(() => { if (open) pop.current?.scrollIntoView({ block: 'nearest' }); }, [open, mode, search.data, error]);

  const chooseFile = (f: File | undefined) => {
    if (!f) return;
    const problem = uploadProblem(f);
    setError(problem);
    setFile(problem ? null : f);
  };

  const opts: { id: Mode; icon: IconName; title: string; text: string; hidden?: boolean }[] = [
    { id: 'describe', icon: 'sparkle', title: 'Describe a drawing', text: 'Say what the figure shows. The AI draws it and you can edit the drawing.', hidden: !drawing },
    { id: 'upload', icon: 'upload', title: 'Upload an image', text: 'PNG, JPEG, SVG or WebP from this computer.' },
    { id: 'search', icon: 'search', title: 'Search photos', text: 'Wikimedia Commons, and Pixabay or Pexels when you added a key.' },
  ];
  const busy = draw.isPending || upload.isPending || photo.isPending;
  const hint = (id: string) => `${popId}-${id}`;

  return (
    <span className="ins-anchor" ref={root} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}>
      <button ref={button} type="button" className="ui-btn ui-btn--sm" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="image" />Add figure<Icon name="chevron-down" />
      </button>
      {open && (
        <div className="ins-pop" id={popId} ref={pop} role="dialog" aria-label="Add a figure">
          <p className="ins-where">The figure goes after this block. Unsaved changes to the block are saved first.</p>
          {opts.filter((o) => !o.hidden).map((o) => (
            <button key={o.id} type="button" className="ins-opt" aria-pressed={mode === o.id} onClick={() => choose(o.id)}>
              <Icon name={o.icon} size={18} /><span><strong>{o.title}</strong><span>{o.text}</span></span>
            </button>
          ))}

          {mode === 'describe' && (
            <form className="ins-panel" onSubmit={(e) => { e.preventDefault(); if (description.trim()) draw.mutate(); }}>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={hint('desc')}>What should the drawing show?</label>
                <textarea id={hint('desc')} className="ui-textarea" rows={3} autoFocus value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby={hint('desc-hint')} placeholder="An inverting amplifier with an op-amp. Vin goes through R1 to the inverting input, R2 goes from the output back to that input." />
                <span id={hint('desc-hint')} className="ui-field__hint">Name the parts and the labels you want.</span>
              </div>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={hint('cap')}>Caption <span className="ui-muted">(optional)</span></label>
                <input id={hint('cap')} className="ui-input ui-input--sm" value={caption} onChange={(e) => setCaption(e.target.value)} />
              </div>
              {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
              <div className="ins-actions">
                <button type="button" className="ui-btn ui-btn--sm" onClick={() => close()}>Cancel</button>
                <button type="submit" className="ui-btn ui-btn--accent ui-btn--sm" disabled={busy || !description.trim()}>{draw.isPending ? <><span className="ui-spinner" />Starting…</> : <><Icon name="sparkle" size={14} />Draw it</>}</button>
              </div>
            </form>
          )}

          {mode === 'upload' && (
            <form className="ins-panel" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
              <div
                className={`ins-drop${over ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); chooseFile(e.dataTransfer.files[0]); }}
              >
                <Icon name="upload" size={22} />
                <p><strong>Drop an image here</strong> or choose a file.</p>
                <p>PNG, JPEG, SVG or WebP, up to 2 MB</p>
                <button type="button" className="ui-btn ui-btn--sm" onClick={() => fileRef.current?.click()}>Choose image…</button>
                <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="ui-sr" tabIndex={-1} aria-label="Choose an image" onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
              </div>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor={hint('ucap')}>Caption <span className="ui-muted">(optional)</span></label>
                <input id={hint('ucap')} className="ui-input ui-input--sm" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="For example: Schema del circuito di prova" />
              </div>
              {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
              <div className="ins-actions">
                <span className="ui-muted" role="status">{file ? file.name : 'No file chosen'}</span>
                <button type="button" className="ui-btn ui-btn--sm" onClick={() => close()}>Cancel</button>
                <button type="submit" className="ui-btn ui-btn--accent ui-btn--sm" disabled={busy || !file}>{upload.isPending ? <><span className="ui-spinner" />Adding…</> : 'Add figure'}</button>
              </div>
            </form>
          )}

          {mode === 'search' && (
            <div className="ins-panel">
              <form className="ins-search" onSubmit={(e) => { e.preventDefault(); if (query.trim().length >= 2) search.mutate(); }}>
                <label className="ui-sr" htmlFor={hint('q')}>Search photos</label>
                <input id={hint('q')} className="ui-input ui-input--sm" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="scheda elettronica" />
                <button type="submit" className="ui-btn ui-btn--sm" disabled={search.isPending || query.trim().length < 2}>{search.isPending ? <span className="ui-spinner" /> : <Icon name="search" size={14} />}Search</button>
              </form>
              {search.data && (
                <div className="ins-results" role="group" aria-label="Photo results">
                  {search.data.photos.map((p) => (
                    <button key={p.index} type="button" className="ins-photo" aria-pressed={picked === p.index} aria-label={`Photo ${p.index + 1} from ${SERVICE[p.provider]}${p.author ? `, by ${p.author}` : ''}`} onClick={() => setPicked(p.index)}>
                      <img src={apiUrl('GET /api/projects/:id/figure-photos/:searchId/:index', { params: { id: pid, searchId: search.data!.searchId, index: p.index } })} alt="" loading="lazy" />
                      <span className="ins-photo__src">{SERVICE[p.provider]}</span>
                    </button>
                  ))}
                </div>
              )}
              {picked !== null && (
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={hint('pcap')}>Caption <span className="ui-muted">(optional)</span></label>
                  <input id={hint('pcap')} className="ui-input ui-input--sm" value={photoCaption} onChange={(e) => setPhotoCaption(e.target.value)} aria-describedby={hint('pcap-hint')} />
                  <span id={hint('pcap-hint')} className="ui-field__hint">The credit line of the service and the licence go after your caption.</span>
                </div>
              )}
              {error && <div className="ui-banner ui-banner--danger" role="alert">{error}</div>}
              <div className="ins-actions">
                <span className="ui-muted">Only photos with a licence a book can credit are listed.</span>
                <button type="button" className="ui-btn ui-btn--sm" onClick={() => close()}>Cancel</button>
                <button type="button" className="ui-btn ui-btn--accent ui-btn--sm" disabled={busy || picked === null} onClick={() => photo.mutate()}>{photo.isPending ? <><span className="ui-spinner" />Adding…</> : 'Add photo'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
