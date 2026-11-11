/** In-browser API mock of the figure dialog and Add figure (figures.spec.ts). Registered after mockApi, so its routes win. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

// ---------- Figure dialog and Add figure (figures.spec.ts) ----------
// A section with one drawn figure, kept in memory like the service would: every write makes a new head, and a render, redraw or
// replacement gives the figure a new picture. Registered after mockApi, so these routes win.

const DRAWING_SVG = readFileSync(join(import.meta.dirname, 'fixtures', 'drawing.svg'), 'utf8');
const FIG_CAPTION = 'Amplificatore invertente con resistenze R₁ e R₂.';
const FIG_SHOWS = 'An inverting amplifier built around an op-amp. The input voltage Vin goes through resistor R1 to the inverting input, the feedback resistor R2 connects the output back to the inverting input, and the non-inverting input is grounded.';
const FIG_SOURCE = ['#import "@preview/cetz:0.3.4": canvas, draw', '#import "@preview/zap:0.3.0": opamp, resistor, ground', '#set page(width: auto, height: auto, margin: 8pt)', '', '#canvas({', '  import draw: *', '  opamp("U1", (0, 0))', '  resistor("R1", (-5, 0.6), (-1.4, 0.6), label: $R_1$)', '  resistor("R2", (-3.2, 2.6), (1.6, 2.6), label: $R_2$)', '  ground((-1.4, -0.6))', '})'].join('\n');
export const FIG_COMPILE_ERROR = 'error at line 9, column 31: unknown variable: Rf\n  9 |   resistor("R2", (-3.2, 2.6), (1.6, 2.6), label: $Rf$)';

interface MockFigure { id: string; filename: string; caption: string; origin: 'generated-svg' | 'imported' | 'stock'; shows: string; source: string; createdAt: string }

export interface FigureMock {
  /** "METHOD path" of every write the page made, with its JSON body. */
  writes: { call: string; body: unknown }[];
  /** How long a render takes, so the rendering state can be looked at. */
  renderMs: number;
  /** The status the redraw or draw run reports. */
  runStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  runError: string;
  /** Every write answers 409, as when the text moved on. */
  stale: boolean;
  /** How long a save of the section text (PUT) takes to answer. The text is written when the request arrives, as in the service. */
  putMs: number;
  head: () => string;
  figures: () => MockFigure[];
  /** The running task ends well: the redraw gives the figure a new picture, the described drawing is put into the text. */
  complete: () => void;
}

export async function mockFigureApi(page: Page, o: { stock?: boolean; assetsFail?: boolean } = {}): Promise<FigureMock> {
  let n = 1;
  let headId = 'rvf1';
  const figs = new Map<string, MockFigure>([['a1', { id: 'a1', filename: 'fig-opamp.svg', caption: FIG_CAPTION, origin: 'generated-svg', shows: FIG_SHOWS, source: FIG_SOURCE, createdAt: ago(40) }]]);
  // Block texts of the section; an entry that is a figure id is that figure's block.
  let blocks: string[] = ['### Amplificatore invertente', 'Poiché la tensione tra i due morsetti è nulla (massa virtuale), la corrente in $R_1$ vale $V_{in}/R_1$.', 'fig:a1', 'Ne segue la relazione tra uscita e ingresso:'];
  let pending: { kind: 'redraw'; id: string; shows?: string } | { kind: 'draw'; afterBlock: number; caption: string } | null = null;
  const fm: FigureMock = {
    writes: [], renderMs: 0, runStatus: 'running', runError: '', stale: false, putMs: 0, head: () => headId, figures: () => [...figs.values()],
    complete: () => {
      fm.runStatus = 'completed';
      if (pending?.kind === 'redraw') swap(pending.id, { source: `${figs.get(pending.id)!.source}\n// redrawn`, ...(pending.shows ? { shows: pending.shows } : {}) });
      if (pending?.kind === 'draw') {
        const id = `a${++n}`;
        figs.set(id, { id, filename: `drawn-${n}.svg`, caption: pending.caption, origin: 'generated-svg', shows: 'A drawing.', source: '#circle(radius: 8pt)', createdAt: new Date().toISOString() });
        blocks.splice(pending.afterBlock + 1, 0, `fig:${id}`); newHead();
      }
      pending = null;
    },
  };

  const src = (f: MockFigure) => `:::image{src="assets/${f.filename}" alt="Schema" caption="${f.caption}"}\n:::`;
  const markdown = () => blocks.map((b) => (b.startsWith('fig:') ? src(figs.get(b.slice(4))!) : b)).join('\n\n');
  const compiled = () => ['## p1 | Definizione di limite', ...blocks.map((b, i) => (b.startsWith('fig:') ? `:::image{src="assets/${figs.get(b.slice(4))!.filename}" alt="Schema" caption="Fig. 1.${i} — ${figs.get(b.slice(4))!.caption}"}\n:::` : b))].join('\n\n');
  const sectionView = () => ({
    chapterId: 'c1', sectionId: 's1', title: 'Definizione di limite', proposal: null, evidence: null, issues: [], compiled: compiled(),
    current: { id: headId, projectId: 'p1', nodeId: 's1', kind: 'section', markdown: markdown(), origin: 'human', model: null, parentRevId: null, status: 'current', citations: {}, createdAt: ago(1) },
  });
  const newHead = () => { headId = `rvf${++n}`; };
  const assetRows = () => [...figs.values()].map((f) => ({ id: f.id, projectId: 'p1', nodeId: 's1', filename: f.filename, mime: 'image/svg+xml', origin: f.origin, spec: f.origin === 'generated-svg' ? { kind: 'drawing', engine: 'typst', source: f.source, shows: f.shows, family: 'circuit', symbols: 'european' } : null, caption: f.caption, alt: 'Schema', checks: [], createdAt: f.createdAt }));
  const details = (f: MockFigure) => ({
    assetId: f.id, filename: f.filename, kind: f.origin === 'generated-svg' ? 'drawing' : f.origin === 'stock' ? 'photo' : 'image', caption: f.caption, alt: 'Schema', createdAt: f.createdAt,
    drawing: f.origin === 'generated-svg' ? { shows: f.shows, engine: 'typst', source: f.source, family: 'circuit' } : null, headRevId: headId, redrawRunId: null,
  });
  const run = (status: string) => ({ id: 'r-fig', projectId: 'p1', kind: 'figure', status, createdAt: new Date().toISOString(), finishedAt: status === 'running' ? null : new Date().toISOString(), counts: status === 'running' ? { running: 1 } : { [status === 'completed' ? 'succeeded' : 'failed']: 1 }, waiting: null, warnings: [] });
  const swap = (id: string, make: Partial<MockFigure>) => {
    const old = figs.get(id)!;
    const fresh: MockFigure = { ...old, ...make, id: `a${++n}`, filename: `fig-r${n}.svg`, createdAt: make.createdAt ?? new Date().toISOString() };
    figs.set(fresh.id, fresh);
    blocks = blocks.map((b) => (b === `fig:${id}` ? `fig:${fresh.id}` : b));
    newHead();
  };

  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = (): any => { try { return request.postDataJSON() ?? {}; } catch { return {}; } };
    const write = (b: unknown = null) => { fm.writes.push({ call: `${method} ${path}`, body: b }); };
    const stale = () => json({ error: { code: 'conflict', message: 'This text changed since you opened it.', action: 'Reload to see the latest version, then reapply your edit.' } }, 409);

    if (method === 'GET' && path === '/api/projects/p1/sections/s1') return json(sectionView());
    if (method === 'GET' && path === '/api/projects/p1/assets') return o.assetsFail ? json({ error: { code: 'internal', message: 'The asset list could not be read.' } }, 500) : json(assetRows());
    if (method === 'GET' && path === '/api/projects/p1/chapters/c1/preview') return json({ markdown: compiled(), number: 1, assets: Object.fromEntries([...figs.values()].flatMap((f) => [[`assets/${f.filename}`, `/api/assets/${f.id}/file`], [f.filename, `/api/assets/${f.id}/file`]])) });
    if (method === 'GET' && /^\/api\/assets\/[^/]+\/file$/.test(path)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: DRAWING_SVG });
    if (method === 'GET' && path === '/api/runs/r-fig') return json({ ...run(fm.runStatus), tasks: [{ id: 'tk-fig', runId: 'r-fig', kind: 'figure.redraw', label: 'Redraw', state: fm.runStatus === 'completed' ? 'succeeded' : fm.runStatus === 'running' ? 'running' : 'failed', attempts: 1, provider: 'codex', error: fm.runStatus === 'failed' ? { message: fm.runError, action: 'The figure is unchanged. Change the instruction and try again.' } : null, waitReason: null, startedAt: ago(1), finishedAt: null }], usage: [] });
    if (method === 'POST' && path === '/api/runs/r-fig/cancel') { fm.writes.push({ call: 'cancel', body: null }); fm.runStatus = 'cancelled'; return json(run('cancelled')); }

    const fig = /^\/api\/projects\/p1\/sections\/s1\/figures\/([^/]+)(?:\/(render|redraw|replace|remove))?$/.exec(path);
    if (fig && fig[1] !== 'draw' && fig[1] !== 'upload' && fig[1] !== 'photo') {
      const f = figs.get(fig[1]);
      if (!f) return json({ error: { code: 'not_found', message: 'This figure was not found.' } }, 404);
      if (method === 'GET') return json(details(f));
      const b = body();
      write(fig[2] === 'replace' ? { name: 'upload' } : b);
      if (fm.stale) return stale();
      if (method === 'PATCH') {
        // A caption or description change is a copy of the figure and a new revision, as in the service.
        if ((b.caption !== undefined && b.caption !== f.caption) || (b.shows !== undefined && b.shows !== f.shows)) {
          swap(f.id, { caption: b.caption ?? f.caption, shows: b.shows ?? f.shows, createdAt: f.createdAt });
        }
        return json(sectionView());
      }
      if (fig[2] === 'render') {
        if (fm.renderMs) await new Promise((r) => setTimeout(r, fm.renderMs));
        if (String(b.source).includes('$Rf$')) return json({ error: { code: 'does_not_compile', message: FIG_COMPILE_ERROR, action: 'Fix the source and render again. The figure in the section is unchanged.' } }, 422);
        swap(f.id, { source: b.source });
        return json(sectionView());
      }
      if (fig[2] === 'redraw') { fm.runStatus = 'running'; pending = { kind: 'redraw', id: f.id, shows: b.shows }; return json(run('running')); }
      if (fig[2] === 'replace') { swap(f.id, { origin: 'imported', source: '', shows: '' }); return json(sectionView()); }
      if (fig[2] === 'remove') { blocks = blocks.filter((x) => x !== `fig:${f.id}`); newHead(); return json(sectionView()); }
    }
    if (method === 'POST' && path === '/api/projects/p1/sections/s1/figures/draw') {
      const b = body(); write(b);
      if (fm.stale) return stale();
      fm.runStatus = 'running';
      pending = { kind: 'draw', afterBlock: b.afterBlock, caption: b.caption };
      return json(run('running'));
    }
    if (method === 'POST' && path === '/api/projects/p1/sections/s1/figures/upload') {
      write({ name: 'upload' });
      if (fm.stale) return stale();
      const at = Number(/name="afterBlock"\r\n\r\n(\d+)/.exec(request.postData() ?? '')?.[1] ?? 0);
      const id = `a${++n}`;
      figs.set(id, { id, filename: `upload-${n}.svg`, caption: 'Schema del circuito di prova', origin: 'imported', shows: '', source: '', createdAt: new Date().toISOString() });
      blocks.splice(at + 1, 0, `fig:${id}`); newHead();
      return json(sectionView());
    }
    if (method === 'POST' && path === '/api/projects/p1/figure-photos/search') {
      write(body());
      if (!o.stock) return json({ error: { code: 'no_photos', message: 'No stock photos found for "x".', action: 'Try other words.' } }, 404);
      return json({ searchId: 'sr1', photos: [0, 1, 2, 3].map((index) => ({ index, provider: (['commons', 'pixabay', 'pexels', 'commons'] as const)[index], author: 'Ada', license: index % 3 === 0 ? 'CC BY 4.0' : null, pageUrl: 'https://example.org' })) });
    }
    if (method === 'GET' && /^\/api\/projects\/p1\/figure-photos\/sr1\/\d+$/.test(path)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#274690"/><path d="M10 20h30v20h25M65 40v25h45" stroke="#a9bdf0" stroke-width="2" fill="none"/></svg>` });
    if (method === 'POST' && path === '/api/projects/p1/sections/s1/figures/photo') {
      const b = body(); write(b);
      if (fm.stale) return stale();
      const id = `a${++n}`;
      figs.set(id, { id, filename: `photo-${n}.jpg`, caption: `${b.caption || 'Una scheda'}. Foto: Ada / Wikimedia Commons, CC BY 4.0`, origin: 'stock', shows: '', source: '', createdAt: new Date().toISOString() });
      blocks.splice(Number(b.afterBlock) + 1, 0, `fig:${id}`); newHead();
      return json(sectionView());
    }
    if (method === 'PUT' && path === '/api/projects/p1/sections/s1') {
      const b = body(); write(b);
      if (b.baseRevId !== headId) return stale();
      blocks = (b.markdown as string).split('\n\n').map((t) => { const m = /src="assets\/([^"]+)"/.exec(t); const f = m && [...figs.values()].find((x) => x.filename === m[1]); return f ? `fig:${f.id}` : t; });
      newHead();
      const out = sectionView();
      if (fm.putMs) await new Promise((r) => setTimeout(r, fm.putMs));
      return json(out);
    }
    return route.fallback();
  });
  return fm;
}
