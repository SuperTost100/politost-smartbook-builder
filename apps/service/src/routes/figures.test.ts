// The figure dialog and "Add figure" routes: real database and renderer, the model-calling collaborators replaced.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ensureFigurePackages, missingFigurePackages } from '../../../../scripts/fetch-figure-packages.mjs';
import { assetPath, currentHead, getAsset, listAssets, saveHuman, storeAsset } from '../repo/index.ts';
import { commitAiRevision } from '../pipeline/draft.ts';
import { compileBook } from '@smartbuilder/content';
import { loadBookInput } from '../repo/index.ts';
import { fakeRun, installFakes, multipart, projectWithOutline, startApp, type TestApp } from './testkit.ts';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, usageOf } from '../llm/testkit.ts';
import { newId, now } from '../db/db.ts';
import { figureRedraw } from '../pipeline/figureEdit.ts';

let t: TestApp;
let restore: () => void;
const calls = { redraw: [] as unknown[], draw: [] as unknown[], search: [] as unknown[], fetch: 0 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const SOURCE = '#circle(radius: 8pt)';
const TEXT = ['### Intro', 'First paragraph.', 'Second paragraph.'].join('\n\n');

before(async () => {
  if (missingFigurePackages().length) await ensureFigurePackages();
  t = await startApp();
  ({ restore } = installFakes({
    startRedraw: (_ctx, projectId, o) => { calls.redraw.push(o); return fakeRun(projectId, 'figure'); },
    startDraw: (_ctx, projectId, o) => { calls.draw.push(o); return fakeRun(projectId, 'figure'); },
    searchStockPhotos: async (_ctx, o) => {
      calls.search.push(o);
      return o.query === 'nothing' ? { ok: false, reason: 'No stock photos found for "nothing".' } : {
        ok: true, search: { candidates: [{ c: { provider: 'commons', id: 'File:Board.jpg', author: 'Ada', pageUrl: 'https://commons.wikimedia.org/wiki/File:Board.jpg', license: 'CC BY 4.0', drawing: false, previewUrl: '', largeUrl: '' }, preview: { bytes: PNG, mime: 'image/png' } }] },
      };
    },
    fetchChosenPhoto: async (hit) => {
      calls.fetch++;
      await new Promise((r) => setTimeout(r, 25)); // a download takes time: two requests can be in it together
      return { ok: true, photo: { bytes: PNG, ext: '.png', mime: 'image/png', provider: hit.c.provider, author: hit.c.author, pageUrl: hit.c.pageUrl, id: hit.c.id, license: hit.c.license, credit: 'Foto: Ada / Wikimedia Commons, CC BY 4.0', check: 'ok' } };
    },
  }));
});
after(async () => { restore(); await t.close(); });

interface Seed { projectId: string; nodeId: string; drawn: string; drawnFile: string; headId: string }
let n = 0;

/** A project whose section s1 has two paragraphs, and a drawn figure between them. */
async function seed(): Promise<Seed> {
  const { projectId } = await projectWithOutline(t, `figures-${++n}`);
  const drawn = storeAsset(t.ctx, projectId, {
    filename: 'figura.svg', bytes: Buffer.from(SVG), origin: 'generated-svg', nodeId: 's1', caption: 'Un cerchio', alt: 'Un cerchio',
    spec: { kind: 'drawing', engine: 'typst', source: SOURCE, shows: 'A circle.', family: 'sketch', symbols: 'european' },
  });
  const md = ['### Intro', 'First paragraph.', `:::image{src="assets/${drawn.filename}" alt="Un cerchio" caption="Un cerchio"}\n:::`, 'Second paragraph.'].join('\n\n');
  const head = saveHuman(t.ctx, projectId, 's1', md, null);
  return { projectId, nodeId: 's1', drawn: drawn.id, drawnFile: drawn.filename, headId: head.id };
}
const url = (s: Seed, tail = '') => `/api/projects/${s.projectId}/sections/${s.nodeId}/figures${tail}`;
const headOf = (s: Seed) => currentHead(t.ctx, s.projectId, s.nodeId)!;
beforeEach(() => { calls.redraw.length = 0; calls.draw.length = 0; calls.search.length = 0; calls.fetch = 0; });

describe('figure details', () => {
  it('reads a drawn figure with its description, engine and source, and the head it was read from', async () => {
    const s = await seed();
    const r = await t.req('GET', url(s, `/${s.drawn}`));
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'drawing');
    assert.deepEqual(r.body.drawing, { shows: 'A circle.', engine: 'typst', source: SOURCE, family: 'sketch' });
    assert.equal(r.body.caption, 'Un cerchio');
    assert.equal(r.body.headRevId, s.headId);
    assert.equal(r.body.redrawRunId, null);
  });

  it('names the kind of an uploaded image and a photo, with no drawing', async () => {
    const s = await seed();
    const up = storeAsset(t.ctx, s.projectId, { filename: 'a.png', bytes: PNG, origin: 'imported', nodeId: 's1' });
    const ph = storeAsset(t.ctx, s.projectId, { filename: 'b.png', bytes: PNG, origin: 'stock', nodeId: 's1', spec: { provider: 'pexels', id: '1' } });
    saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\n:::image{src="assets/a.png" alt="A"}\n:::\n\n:::image{src="assets/b.png" alt="B"}\n:::`, s.headId);
    for (const [asset, kind] of [[up, 'image'], [ph, 'photo']] as const) {
      const r = await t.req('GET', url(s, `/${asset.id}`));
      assert.equal(r.body.kind, kind);
      assert.equal(r.body.drawing, null);
    }
  });

  it('is 404 for a figure the text does not show, and for another project', async () => {
    const s = await seed();
    const loose = storeAsset(t.ctx, s.projectId, { filename: 'loose.png', bytes: PNG, origin: 'imported', nodeId: 's1' });
    assert.equal((await t.req('GET', url(s, `/${loose.id}`))).status, 404);
    const other = await seed();
    assert.equal((await t.req('GET', url(s, `/${other.drawn}`))).status, 404);
  });

  it('reports the redraw that is running', async () => {
    const s = await seed();
    const runId = t.ctx.queue.createRun(s.projectId, 'figure', [{ kind: 'figure.redraw', key: 'redraw:x', label: 'Redraw', input: { nodeId: 's1', assetId: s.drawn, instruction: 'x' } }]);
    assert.equal((await t.req('GET', url(s, `/${s.drawn}`))).body.redrawRunId, runId);
    t.ctx.queue.cancel(runId);
  });
});

describe('save caption and description', () => {
  it('a caption change is a new asset and a new revision, so the earlier revision keeps the earlier caption', async () => {
    const s = await seed();
    const r = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Figura 2: Un cerchio nuovo' });
    assert.equal(r.status, 200);
    const head = headOf(s);
    assert.notEqual(head.id, s.headId);
    assert.equal(head.origin, 'human');
    assert.match(head.markdown, /caption="Un cerchio nuovo"/, 'the number is the builder\'s');
    assert.ok(!head.markdown.includes(`assets/${s.drawnFile}"`), 'the text points at the copy');
    const fresh = listAssets(t.ctx, s.projectId).find((a) => head.markdown.includes(`assets/${a.filename}"`))!;
    assert.notEqual(fresh.id, s.drawn);
    assert.equal(fresh.caption, 'Un cerchio nuovo');
    assert.equal((fresh.spec as { source: string }).source, SOURCE, 'the copy is the same drawing');
    // What a restore of the first revision shows: the first asset, with the first caption.
    assert.equal(getAsset(t.ctx, s.drawn).caption, 'Un cerchio');
    assert.ok(t.ctx.db.get('SELECT 1 FROM content_revisions WHERE id = ? AND markdown LIKE ?', s.headId, `%assets/${s.drawnFile}"%`));
  });

  it('a failure after the revision was committed does not delete the asset the revision names', async () => {
    const s = await seed();
    const emit = t.ctx.events.emit.bind(t.ctx.events);
    t.ctx.events.emit = ((type: Parameters<typeof emit>[0], ...rest: unknown[]) => {
      if (type === 'content.saved') throw new Error('the event stream broke');
      return (emit as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof emit;
    try {
      assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Figura 2: Un cerchio nuovo' })).status, 200);
    } finally {
      t.ctx.events.emit = emit;
    }
    const head = headOf(s);
    assert.notEqual(head.id, s.headId, 'the revision is committed');
    const fresh = listAssets(t.ctx, s.projectId).find((a) => head.markdown.includes(`assets/${a.filename}"`));
    assert.ok(fresh, 'the asset the head names still exists');
    assert.ok(existsSync(assetPath(t.ctx, t.ctx.db.get<{ path: string; project_id: string }>('SELECT path, project_id FROM assets WHERE id = ?', fresh.id)!)), 'and so does its file');
  });

  it('a description change is a new asset and a new revision too, and the picture stays', async () => {
    const s = await seed();
    const r = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, shows: 'A bigger circle.' });
    assert.equal(r.status, 200);
    const head = headOf(s);
    assert.notEqual(head.id, s.headId);
    const fresh = listAssets(t.ctx, s.projectId).find((a) => head.markdown.includes(`assets/${a.filename}"`))!;
    const spec = fresh.spec as { shows: string; source: string };
    assert.equal(spec.shows, 'A bigger circle.');
    assert.equal(spec.source, SOURCE);
    assert.equal((getAsset(t.ctx, s.drawn).spec as { shows: string }).shows, 'A circle.');
  });

  it('saving what is already stored makes no copy and no revision', async () => {
    const s = await seed();
    const before = listAssets(t.ctx, s.projectId).length;
    const r = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Un cerchio', shows: 'A circle.' });
    assert.equal(r.status, 200);
    assert.equal(headOf(s).id, s.headId);
    assert.equal(listAssets(t.ctx, s.projectId).length, before);
  });

  it('a caption with braces in the alt text of the block is saved and removed whole', async () => {
    const s = await seed();
    const md = headOf(s).markdown.replace('alt="Un cerchio"', 'alt="Radius $r_{1}$"');
    const head = saveHuman(t.ctx, s.projectId, 's1', md, s.headId);
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: head.id, caption: 'Nuova' })).status, 200);
    const saved = headOf(s).markdown;
    assert.match(saved, /alt="Radius \$r_\{1\}\$"/);
    assert.equal(saved.match(/caption="/g)?.length, 1);
    assert.match(saved, /caption="Nuova"/);
    const fresh = listAssets(t.ctx, s.projectId).find((a) => saved.includes(`assets/${a.filename}"`))!;
    assert.equal((await t.req('POST', url(s, `/${fresh.id}/remove`), { baseRevId: headOf(s).id })).status, 200);
    assert.equal(headOf(s).markdown, ['### Intro', 'First paragraph.', 'Second paragraph.'].join('\n\n'));
  });

  it('answers 409 when the text moved on, and 400 for a description on a figure that is not drawn', async () => {
    const s = await seed();
    saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\nThird.`, s.headId);
    const stale = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'X' });
    assert.equal(stale.status, 409);
    assert.equal(listAssets(t.ctx, s.projectId).length, 1, 'nothing was saved');
    const up = storeAsset(t.ctx, s.projectId, { filename: 'a.png', bytes: PNG, origin: 'imported', nodeId: 's1' });
    const head = saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\n:::image{src="assets/a.png" alt="A"}\n:::`, headOf(s).id);
    assert.equal((await t.req('PATCH', url(s, `/${up.id}`), { baseRevId: head.id, shows: 'x' })).status, 400);
  });
});

describe('save alt text', () => {
  const previewAlts = (s: Seed) => {
    const files = compileBook(loadBookInput(t.ctx, s.projectId)).files;
    return Object.entries(files).filter(([name]) => name.startsWith('chapters/')).flatMap(([, text]) => [...String(text).matchAll(/:::image\{[^}]*alt="([^"]*)"/g)].map((m) => m[1]));
  };

  it('an alt text change is a new asset and a new revision, the block and the asset agree, and Restore brings back the earlier alt text', async () => {
    const s = await seed();
    const r = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, alt: 'A circle with its radius marked' });
    assert.equal(r.status, 200);
    const head = headOf(s);
    assert.notEqual(head.id, s.headId);
    assert.match(head.markdown, /alt="A circle with its radius marked"/);
    assert.match(head.markdown, /caption="Un cerchio"/, 'the caption is untouched');
    const fresh = listAssets(t.ctx, s.projectId).find((a) => head.markdown.includes(`assets/${a.filename}"`))!;
    assert.notEqual(fresh.id, s.drawn);
    assert.equal(fresh.alt, 'A circle with its radius marked');
    assert.equal(getAsset(t.ctx, s.drawn).alt, 'Un cerchio', 'the earlier asset keeps the earlier alt text');
    assert.deepEqual(previewAlts(s), ['A circle with its radius marked']);
    const details = await t.req('GET', url(s, `/${fresh.id}`));
    assert.equal(details.body.alt, 'A circle with its radius marked');
    assert.equal((await t.req('POST', `/api/projects/${s.projectId}/sections/${s.nodeId}/restore`, { revId: s.headId })).status, 200);
    assert.deepEqual(previewAlts(s), ['Un cerchio']);
  });

  it('a double quote in the alt text is saved as the typographic quote a caption gets, whole and not as a single quote', async () => {
    const s = await seed();
    const r = await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, alt: 'Doppie "quote" e città {x} $' });
    assert.equal(r.status, 200);
    const shown = listAssets(t.ctx, s.projectId).find((a) => headOf(s).markdown.includes(`assets/${a.filename}"`))!;
    assert.equal(shown.alt, 'Doppie ”quote” e città {x} $');
    assert.match(headOf(s).markdown, /alt="Doppie ”quote” e città \{x\} \$"/);
    assert.equal((await t.req('GET', url(s, `/${shown.id}`))).body.alt, 'Doppie ”quote” e città {x} $');
    // The caption in the block takes the same quote, which is what the compiler prints for a caption.
    await t.req('PATCH', url(s, `/${shown.id}`), { baseRevId: headOf(s).id, caption: 'Un "cerchio"' });
    assert.match(headOf(s).markdown, /caption="Un ”cerchio”"/);
  });

  it('caption and alt text saved together make one copy and one revision', async () => {
    const s = await seed();
    const before = listAssets(t.ctx, s.projectId).length;
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Nuova', alt: 'Nuovo alt' })).status, 200);
    assert.equal(listAssets(t.ctx, s.projectId).length, before + 1);
    assert.match(headOf(s).markdown, /alt="Nuovo alt" caption="Nuova"|caption="Nuova" alt="Nuovo alt"/);
  });

  it('the alt text of the block wins nowhere: a block whose alt text differs from the asset is brought in line', async () => {
    const s = await seed();
    const md = headOf(s).markdown.replace('alt="Un cerchio"', 'alt="Old block alt"');
    const head = saveHuman(t.ctx, s.projectId, 's1', md, s.headId);
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: head.id, alt: 'Chosen alt' })).status, 200);
    assert.deepEqual(previewAlts(s), ['Chosen alt']);
    assert.ok(!headOf(s).markdown.includes('Old block alt'));
  });

  it('refuses an empty alt text, because the lint blocks an image without one, and saving what is stored makes no revision', async () => {
    const s = await seed();
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, alt: '   ' })).status, 400);
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, alt: 'Un cerchio' })).status, 200);
    assert.equal(headOf(s).id, s.headId);
    assert.equal(listAssets(t.ctx, s.projectId).length, 1);
  });

  it('shows the alt text of the block when the asset stores none', async () => {
    const s = await seed();
    t.ctx.db.update('assets', s.drawn, { alt: '' });
    const details = await t.req('GET', url(s, `/${s.drawn}`));
    assert.equal(details.body.alt, 'Un cerchio');
  });
});

describe('render edited source', () => {
  it('a source that compiles gives the figure a new picture, and the old asset stays for the revision that names it', async () => {
    const s = await seed();
    const r = await t.req('POST', url(s, `/${s.drawn}/render`), { baseRevId: s.headId, source: '#rect(width: 20pt, height: 10pt)' });
    assert.equal(r.status, 200, r.raw);
    const head = headOf(s);
    assert.equal(head.origin, 'human');
    assert.ok(!head.markdown.includes(`assets/${s.drawnFile}"`), 'the text points at the new picture');
    const fresh = listAssets(t.ctx, s.projectId).find((a) => head.markdown.includes(`assets/${a.filename}"`))!;
    assert.notEqual(fresh.id, s.drawn);
    assert.equal((fresh.spec as { source: string }).source, '#rect(width: 20pt, height: 10pt)');
    assert.match(readFileSync(assetPath(t.ctx, { path: (t.ctx.db.get<{ path: string }>('SELECT path FROM assets WHERE id = ?', fresh.id))!.path, project_id: s.projectId }), 'utf8'), /data-sb-ink="dark"/);
    // The first revision still shows the first drawing.
    assert.equal((getAsset(t.ctx, s.drawn).spec as { source: string }).source, SOURCE);
    assert.ok(t.ctx.db.get('SELECT 1 FROM content_revisions WHERE id = ? AND markdown LIKE ?', s.headId, `%assets/${s.drawnFile}"%`));
    assert.equal(r.body.current.id, head.id);
  });

  it('a source that does not compile answers 422 with the compiler\'s line, and changes nothing', async () => {
    const s = await seed();
    const before = listAssets(t.ctx, s.projectId).length;
    const r = await t.req('POST', url(s, `/${s.drawn}/render`), { baseRevId: s.headId, source: '#circle(radius: 8pt' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'does_not_compile');
    assert.match(r.body.error.message, /error at line 1/);
    assert.equal(headOf(s).id, s.headId);
    assert.equal(listAssets(t.ctx, s.projectId).length, before, 'the working copy is gone');
    assert.equal((getAsset(t.ctx, s.drawn).spec as { source: string }).source, SOURCE);
  });

  it('answers 409 when the text moved on, before rendering', async () => {
    const s = await seed();
    saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\nThird.`, s.headId);
    const r = await t.req('POST', url(s, `/${s.drawn}/render`), { baseRevId: s.headId, source: SOURCE });
    assert.equal(r.status, 409);
  });
});

describe('redraw', () => {
  it('starts the task for a drawn figure with the instruction, and 409s a stale dialog', async () => {
    const s = await seed();
    const r = await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: s.headId, instruction: '  Move the labels  ' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.redraw, [{ nodeId: 's1', assetId: s.drawn, caption: 'Un cerchio', instruction: 'Move the labels' }]);
    assert.equal((await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: 'old', instruction: 'x' })).status, 409);
    assert.equal((await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: s.headId, instruction: '  ' })).status, 400);
    assert.equal(calls.redraw.length, 1);
  });

  it('after a Render, a redraw sent the way the dialog sends it starts from the rendered source, and a request for the figure it replaced is refused with 409', async () => {
    const s = await seed();
    const EDITED = '#rect(width: 20pt, height: 10pt) // R_1';
    const rendered = await t.req('POST', url(s, `/${s.drawn}/render`), { baseRevId: s.headId, source: EDITED });
    assert.equal(rendered.status, 200);
    // The dialog finds the figure the new text shows in the asset list, reads its details, and sends what they name.
    const filename = /src="assets\/([^"]+)"/.exec(rendered.body.current.markdown)![1];
    const shown = listAssets(t.ctx, s.projectId).find((a) => a.filename === filename)!;
    assert.notEqual(shown.id, s.drawn, 'a render gives the figure a new asset');
    const details = (await t.req('GET', url(s, `/${shown.id}`))).body;
    assert.equal(details.drawing.source, EDITED);
    // The old id is refused, never run: 409, as for a stale head.
    const old = await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: details.headRevId, instruction: 'Make C bigger' });
    assert.equal(old.status, 409);
    assert.equal(calls.redraw.length, 0);
    for (const call of ['render', 'remove']) assert.equal((await t.req('POST', url(s, `/${s.drawn}/${call}`), { baseRevId: details.headRevId, source: EDITED })).status, 409, call);
    assert.equal((await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: details.headRevId, caption: 'x' })).status, 409);
    assert.equal(headOf(s).id, details.headRevId, 'nothing was written');
    // The id the dialog sends starts the task, and the model is given the rendered source.
    assert.equal((await t.req('POST', url(s, `/${shown.id}/redraw`), { baseRevId: details.headRevId, instruction: 'Make C bigger' })).status, 200);
    const input = calls.redraw[0] as { nodeId: string; assetId: string; instruction: string };
    assert.equal(input.assetId, shown.id);
    const fake = new FakeFunnel();
    setFunnel(fake);
    resetLlmState();
    resetConnectionsCache();
    t.ctx.saveSettings({ routes: DEFAULT_ROUTES });
    try {
      const runId = newId();
      t.ctx.db.insert('runs', { id: runId, project_id: s.projectId, kind: 'figure', status: 'running', snapshot: {}, created_at: now() });
      const id = newId();
      t.ctx.db.insert('tasks', { id, run_id: runId, project_id: s.projectId, kind: 'figure.redraw', label: 'x', key: `figure.redraw:${id}`, input, state: 'running', pool: 'illustrator', attempts: 1, max_attempts: 2, created_at: now() });
      const say = (text: string) => () => ({ text, usage: usageOf(10, 10) });
      fake.next(say('#circle(radius: 8pt) // R_1 bigger C'), say('OK'));
      await figureRedraw(t.ctx, {
        task: { id, runId, projectId: s.projectId, kind: 'figure.redraw', key: `figure.redraw:${id}`, label: 'x', input, attempts: 1 }, signal: new AbortController().signal,
        deps: {}, enqueue: () => [], progress: () => undefined, setProvider: () => undefined,
      });
      assert.ok(fake.calls[0].prompt.includes(`The figure is drawn by this source now:\n${EDITED}\n`), 'the model is given the rendered source');
      assert.ok(!fake.calls[0].prompt.includes(SOURCE), 'and not the source the figure had before');
    } finally {
      setFunnel(null);
    }
  });

  it('passes an edited description on to the task, and nothing when it is unchanged', async () => {
    const s = await seed();
    await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: s.headId, instruction: 'Bigger', shows: '  A bigger circle.  ' });
    await t.req('POST', url(s, `/${s.drawn}/redraw`), { baseRevId: s.headId, instruction: 'Same', shows: 'A circle.' });
    assert.deepEqual(calls.redraw, [
      { nodeId: 's1', assetId: s.drawn, caption: 'Un cerchio', instruction: 'Bigger', shows: 'A bigger circle.' },
      { nodeId: 's1', assetId: s.drawn, caption: 'Un cerchio', instruction: 'Same' },
    ]);
  });

  it('refuses a figure that is not a drawing', async () => {
    const s = await seed();
    storeAsset(t.ctx, s.projectId, { filename: 'a.png', bytes: PNG, origin: 'imported', nodeId: 's1' });
    const head = saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\n:::image{src="assets/a.png" alt="A"}\n:::`, s.headId);
    const id = listAssets(t.ctx, s.projectId).find((a) => a.filename === 'a.png')!.id;
    assert.equal((await t.req('POST', url(s, `/${id}/redraw`), { baseRevId: head.id, instruction: 'x' })).status, 400);
  });
});

describe('replace with an image', () => {
  const send = (s: Seed, assetId: string, file: { filename: string; type: string; data: Buffer | string }, baseRevId = s.headId) => {
    const m = multipart({ baseRevId }, [{ name: 'file', ...file }]);
    return t.req('POST', url(s, `/${assetId}/replace`), m.payload, m.headers);
  };

  it('an upload takes the place of the drawing: an uploaded image without source, the old asset kept', async () => {
    const s = await seed();
    const r = await send(s, s.drawn, { filename: 'mia.png', type: 'image/png', data: PNG });
    assert.equal(r.status, 200, r.raw);
    const head = headOf(s);
    assert.ok(!head.markdown.includes(`assets/${s.drawnFile}"`));
    const fresh = listAssets(t.ctx, s.projectId).find((a) => a.filename.startsWith('mia'))!;
    assert.equal(fresh.origin, 'imported');
    assert.equal(fresh.spec, null);
    assert.equal(fresh.caption, 'Un cerchio', 'the caption stays');
    assert.ok(head.markdown.includes(`assets/${fresh.filename}"`));
    assert.equal(getAsset(t.ctx, s.drawn).origin, 'generated-svg');
  });

  it('refuses an image over 2 MB with 413, and writes nothing', async () => {
    const s = await seed();
    const before = listAssets(t.ctx, s.projectId).length;
    const r = await send(s, s.drawn, { filename: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) });
    assert.equal(r.status, 413);
    assert.equal(headOf(s).id, s.headId);
    assert.equal(listAssets(t.ctx, s.projectId).length, before);
  });

  it('refuses an SVG with a script, a file that only pretends to be a PNG, and another format', async () => {
    const s = await seed();
    const bad = await send(s, s.drawn, { filename: 'x.svg', type: 'image/svg+xml', data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /script/);
    assert.equal((await send(s, s.drawn, { filename: 'x.png', type: 'image/png', data: '<html>not an image</html>' })).status, 400);
    assert.equal((await send(s, s.drawn, { filename: 'x.gif', type: 'image/gif', data: 'GIF89a' })).status, 400);
    assert.equal(headOf(s).id, s.headId);
  });

  it('accepts a plain SVG, JPEG and WebP', async () => {
    const s = await seed();
    const svg = await send(s, s.drawn, { filename: 'p.svg', type: 'image/svg+xml', data: SVG });
    assert.equal(svg.status, 200, svg.raw);
    const jpeg = await send(s, listAssets(t.ctx, s.projectId).find((a) => a.filename.startsWith('p'))!.id, { filename: 'q.jpg', type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }, headOf(s).id);
    assert.equal(jpeg.status, 200, jpeg.raw);
    const webp = await send(s, listAssets(t.ctx, s.projectId).find((a) => a.filename.startsWith('q'))!.id, { filename: 'w.webp', type: 'image/webp', data: Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]) }, headOf(s).id);
    assert.equal(webp.status, 200, webp.raw);
  });

  it('answers 409 when the text moved on', async () => {
    const s = await seed();
    saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\nThird.`, s.headId);
    const r = await send(s, s.drawn, { filename: 'mia.png', type: 'image/png', data: PNG });
    assert.equal(r.status, 409);
    assert.equal(listAssets(t.ctx, s.projectId).filter((a) => a.filename.startsWith('mia')).length, 0, 'the upload is not kept');
  });
});

describe('remove', () => {
  it('takes the block out of the text and keeps the asset for the older revisions', async () => {
    const s = await seed();
    const r = await t.req('POST', url(s, `/${s.drawn}/remove`), { baseRevId: s.headId });
    assert.equal(r.status, 200);
    assert.ok(!headOf(s).markdown.includes(':::image'));
    assert.ok(existsSync(assetPath(t.ctx, t.ctx.db.get<{ path: string; project_id: string }>('SELECT path, project_id FROM assets WHERE id = ?', s.drawn)!)));
    assert.ok(t.ctx.db.get('SELECT 1 FROM content_revisions WHERE id = ? AND markdown LIKE ?', s.headId, '%:::image%'));
  });
  it('answers 409 when the text moved on', async () => {
    const s = await seed();
    saveHuman(t.ctx, s.projectId, 's1', `${headOf(s).markdown}\n\nThird.`, s.headId);
    assert.equal((await t.req('POST', url(s, `/${s.drawn}/remove`), { baseRevId: s.headId })).status, 409);
  });
});

describe('add a figure', () => {
  it('describe a drawing starts the task with the block it goes after and that block\'s text', async () => {
    const s = await seed();
    const r = await t.req('POST', url(s, '/draw'), { baseRevId: s.headId, afterBlock: 1, description: 'An op-amp with R1 and R2.', caption: 'Amplificatore' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.draw, [{ nodeId: 's1', afterBlock: 1, anchor: 'First paragraph.', blocks: 4, description: 'An op-amp with R1 and R2.', caption: 'Amplificatore' }]);
    assert.equal((await t.req('POST', url(s, '/draw'), { baseRevId: 'old', afterBlock: 1, description: 'x', caption: '' })).status, 409);
    assert.equal((await t.req('POST', url(s, '/draw'), { baseRevId: s.headId, afterBlock: 9, description: 'x', caption: '' })).status, 400);
    assert.equal((await t.req('POST', url(s, '/draw'), { baseRevId: s.headId, afterBlock: 1, description: ' ', caption: '' })).status, 400);
    assert.equal(calls.draw.length, 1);
  });

  it('describe a drawing is refused with 409 when the book has figures off', async () => {
    const s = await seed();
    await t.req('PATCH', `/api/projects/${s.projectId}`, { options: { figures: false } });
    const r = await t.req('POST', url(s, '/draw'), { baseRevId: s.headId, afterBlock: 1, description: 'x', caption: '' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'figures_off');
    assert.equal(calls.draw.length, 0);
  });

  it('upload puts the image block after the chosen block and the caption', async () => {
    const s = await seed();
    const m = multipart({ baseRevId: s.headId, afterBlock: '1', caption: 'Schema di prova' }, [{ name: 'file', filename: 'Schema di prova.png', type: 'image/png', data: PNG }]);
    const r = await t.req('POST', url(s, '/upload'), m.payload, m.headers);
    assert.equal(r.status, 200, r.raw);
    const blocks = headOf(s).markdown.split('\n\n');
    assert.equal(blocks[1], 'First paragraph.');
    assert.match(blocks[2], /^:::image\{src="assets\/Schema-di-prova\.png" alt="Schema di prova" caption="Schema di prova"\}\n:::$/);
    assert.equal(headOf(s).origin, 'human');
    const asset = listAssets(t.ctx, s.projectId).find((a) => a.filename === 'Schema-di-prova.png')!;
    assert.equal(asset.origin, 'imported');
    assert.equal(asset.nodeId, 's1');
  });

  it('upload refuses 409, 413, an unsafe SVG and a bad block, and leaves no asset behind', async () => {
    const s = await seed();
    const before = listAssets(t.ctx, s.projectId).length;
    const post = (fields: Record<string, string>, file: { filename: string; type: string; data: Buffer | string }) => {
      const m = multipart(fields, [{ name: 'file', ...file }]);
      return t.req('POST', url(s, '/upload'), m.payload, m.headers);
    };
    assert.equal((await post({ baseRevId: 'old', afterBlock: '0' }, { filename: 'a.png', type: 'image/png', data: PNG })).status, 409);
    assert.equal((await post({ baseRevId: s.headId, afterBlock: '0' }, { filename: 'a.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) })).status, 413);
    assert.equal((await post({ baseRevId: s.headId, afterBlock: '0' }, { filename: 'a.svg', type: 'image/svg+xml', data: '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>' })).status, 400);
    assert.equal((await post({ baseRevId: s.headId, afterBlock: '40' }, { filename: 'a.png', type: 'image/png', data: PNG })).status, 400);
    assert.equal(listAssets(t.ctx, s.projectId).length, before);
    assert.equal(headOf(s).id, s.headId);
  });

  it('a photo search lists its results and serves their previews; no result is a 404 with advice', async () => {
    const s = await seed();
    const r = await t.req('POST', `/api/projects/${s.projectId}/figure-photos/search`, { query: 'scheda elettronica' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.photos, [{ index: 0, provider: 'commons', author: 'Ada', license: 'CC BY 4.0', pageUrl: 'https://commons.wikimedia.org/wiki/File:Board.jpg' }]);
    const img = await t.req('GET', `/api/projects/${s.projectId}/figure-photos/${r.body.searchId}/0`);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal((await t.req('GET', `/api/projects/${s.projectId}/figure-photos/${r.body.searchId}/7`)).status, 404);
    assert.equal((await t.req('GET', `/api/projects/${s.projectId}/figure-photos/nope/0`)).status, 404);
    const none = await t.req('POST', `/api/projects/${s.projectId}/figure-photos/search`, { query: 'nothing' });
    assert.equal(none.status, 404);
    assert.ok(none.body.error.action);
  });

  it('inserting a photo ends the caption with the service\'s credit and records the photo like the pipeline does', async () => {
    const s = await seed();
    const found = (await t.req('POST', `/api/projects/${s.projectId}/figure-photos/search`, { query: 'scheda' })).body;
    const r = await t.req('POST', url(s, '/photo'), { baseRevId: s.headId, afterBlock: 0, searchId: found.searchId, index: 0, caption: 'Una scheda' });
    assert.equal(r.status, 200, r.raw);
    const asset = listAssets(t.ctx, s.projectId).find((a) => a.origin === 'stock')!;
    assert.equal(asset.caption, 'Una scheda. Foto: Ada / Wikimedia Commons, CC BY 4.0');
    assert.deepEqual(asset.spec, { provider: 'commons', id: 'File:Board.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Board.jpg', author: 'Ada', license: 'CC BY 4.0', query: 'scheda', mustShow: 'Una scheda' });
    assert.equal(headOf(s).markdown.split('\n\n')[1].startsWith(':::image{src="assets/'), true);
    // The same photo is not added twice.
    const again = await t.req('POST', url(s, '/photo'), { baseRevId: headOf(s).id, afterBlock: 0, searchId: found.searchId, index: 0, caption: 'Ancora' });
    assert.equal(again.status, 409);
    assert.equal(calls.fetch, 1);
  });

  it('the same photo inserted into two sections at once is added once', async () => {
    const s = await seed();
    const found = (await t.req('POST', `/api/projects/${s.projectId}/figure-photos/search`, { query: 'scheda' })).body;
    const two = saveHuman(t.ctx, s.projectId, 's2', 'Other section.', null);
    const body = (baseRevId: string) => ({ baseRevId, afterBlock: 0, searchId: found.searchId, index: 0, caption: 'Una scheda' });
    const [a, b] = await Promise.all([t.req('POST', url(s, '/photo'), body(s.headId)), t.req('POST', url({ ...s, nodeId: 's2' }, '/photo'), body(two.id))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(listAssets(t.ctx, s.projectId).filter((x) => x.origin === 'stock').length, 1);
  });

  it('a photo needs a live search, and 409s a stale dialog', async () => {
    const s = await seed();
    assert.equal((await t.req('POST', url(s, '/photo'), { baseRevId: s.headId, afterBlock: 0, searchId: 'gone', index: 0, caption: '' })).status, 404);
    const found = (await t.req('POST', `/api/projects/${s.projectId}/figure-photos/search`, { query: 'scheda' })).body;
    assert.equal((await t.req('POST', url(s, '/photo'), { baseRevId: 'old', afterBlock: 0, searchId: found.searchId, index: 0, caption: '' })).status, 409);
    // A search of another book is not usable.
    const other = await seed();
    assert.equal((await t.req('POST', url(other, '/photo'), { baseRevId: other.headId, afterBlock: 0, searchId: found.searchId, index: 0, caption: '' })).status, 404);
  });
});

describe('an inserted figure counts as an author edit', () => {
  it('model output that started before the insert arrives as a proposal, and the figure stays in the text', async () => {
    const s = await seed();
    const m = multipart({ baseRevId: s.headId, afterBlock: '1', caption: 'Mia' }, [{ name: 'file', filename: 'mia.png', type: 'image/png', data: PNG }]);
    assert.equal((await t.req('POST', url(s, '/upload'), m.payload, m.headers)).status, 200);
    const withFigure = headOf(s);
    const late = commitAiRevision(t.ctx, { projectId: s.projectId, nodeId: s.nodeId, kind: 'section', markdown: TEXT, baseRevId: s.headId, model: 'x' });
    assert.equal(late.status, 'proposal');
    assert.equal(headOf(s).id, withFigure.id);
    assert.ok(headOf(s).markdown.includes('assets/mia.png'));
  });
});

describe('history notes', () => {
  it('the History list says what each figure action did, including a replacement and a removal', async () => {
    const s = await seed();
    await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Nuova didascalia' });
    const afterCaption = headOf(s);
    const shown = () => listAssets(t.ctx, s.projectId).find((a) => headOf(s).markdown.includes(`assets/${a.filename}"`))!;
    const form = multipart({ baseRevId: headOf(s).id }, [{ name: 'file', filename: 'foto.png', type: 'image/png', data: PNG }]);
    await t.req('POST', url(s, `/${shown().id}/replace`), form.payload, form.headers);
    const afterReplace = headOf(s);
    await t.req('POST', url(s, `/${shown().id}/remove`), { baseRevId: afterReplace.id });
    const afterRemove = headOf(s);
    const history = (await t.req('GET', `/api/projects/${s.projectId}/sections/${s.nodeId}/history`)).body as { id: string; figureNote: string | null }[];
    const note = (id: string) => history.find((r) => r.id === id)?.figureNote;
    assert.equal(note(s.headId), null);
    assert.equal(note(afterCaption.id), 'Figure "Un cerchio": caption changed to "Nuova didascalia"');
    assert.equal(note(afterReplace.id), 'Figure "Nuova didascalia": the drawing was replaced with an image');
    assert.equal(note(afterRemove.id), 'Figure "Nuova didascalia" removed');
  });

  it('a version made by Restore says which version it restored and gets no figure note, whatever differs from the version before it', async () => {
    const s = await seed();
    await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Nuova didascalia' });
    const afterCaption = headOf(s);
    const shown = () => listAssets(t.ctx, s.projectId).find((a) => headOf(s).markdown.includes(`assets/${a.filename}"`))!;
    await t.req('POST', url(s, `/${shown().id}/render`), { baseRevId: afterCaption.id, source: '#rect(width: 20pt, height: 10pt)' });
    const afterRender = headOf(s);
    const restore = async (revId: string) => { assert.equal((await t.req('POST', `/api/projects/${s.projectId}/sections/${s.nodeId}/restore`, { revId })).status, 200); return headOf(s); };
    const first = await restore(afterCaption.id);
    const second = await restore(s.headId);
    const history = (await t.req('GET', `/api/projects/${s.projectId}/sections/${s.nodeId}/history`)).body as { id: string; figureNote: string | null; restoredFromId: string | null }[];
    const row = (id: string) => history.find((r) => r.id === id)!;
    assert.equal(row(first.id).restoredFromId, afterCaption.id);
    assert.equal(row(first.id).figureNote, null, 'restoring the caption version is not "source rendered"');
    assert.equal(row(second.id).restoredFromId, s.headId);
    assert.equal(row(second.id).figureNote, null);
    // The versions the author made by hand are labelled as before, and say nothing about a restore.
    assert.equal(row(afterRender.id).restoredFromId, null);
    assert.equal(row(afterRender.id).figureNote, 'Figure "Nuova didascalia": source rendered');
    assert.equal(row(afterCaption.id).restoredFromId, null);
  });

  it('a long caption is quoted only when the part that changed is in the quote, and otherwise the note just says the caption changed', async () => {
    const s = await seed();
    const long = 'Circuito RC serie: la sorgente V0 è collegata a R e C attraverso un interruttore che si chiude al tempo zero.';
    await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: long });
    const shown = () => listAssets(t.ctx, s.projectId).find((a) => headOf(s).markdown.includes(`assets/${a.filename}"`))!;
    await t.req('PATCH', url(s, `/${shown().id}`), { baseRevId: headOf(s).id, caption: `${long} (v2)` });
    const atEnd = headOf(s);
    await t.req('PATCH', url(s, `/${shown().id}`), { baseRevId: atEnd.id, caption: `Schema RC serie: ${long.slice(19)}` });
    const atStart = headOf(s);
    const history = (await t.req('GET', `/api/projects/${s.projectId}/sections/${s.nodeId}/history`)).body as { id: string; figureNote: string | null }[];
    const note = (id: string) => history.find((r) => r.id === id)!.figureNote;
    assert.equal(note(atEnd.id), 'Figure "Circuito RC serie: la sorgente V0 è col…": caption changed');
    assert.match(note(atStart.id)!, /caption changed to "Schema RC serie: la sorgente V0 è collegata a R e C attrave…"$/);
  });

  it('says an alt text changed, also on an uploaded image, where a new copy with the same caption is otherwise a replacement', async () => {
    const s = await seed();
    const form = multipart({ baseRevId: headOf(s).id }, [{ name: 'file', filename: 'foto.png', type: 'image/png', data: PNG }]);
    await t.req('POST', url(s, `/${s.drawn}/replace`), form.payload, form.headers);
    const afterReplace = headOf(s);
    const shown = () => listAssets(t.ctx, s.projectId).find((a) => headOf(s).markdown.includes(`assets/${a.filename}"`))!;
    await t.req('PATCH', url(s, `/${shown().id}`), { baseRevId: afterReplace.id, alt: 'Una foto della scheda' });
    const afterAlt = headOf(s);
    const history = (await t.req('GET', `/api/projects/${s.projectId}/sections/${s.nodeId}/history`)).body as { id: string; figureNote: string | null }[];
    assert.equal(history.find((r) => r.id === afterAlt.id)?.figureNote, 'Figure "Un cerchio": alt text changed');
  });
});

describe('a figure is changed only through its section', () => {
  const exportedCaptions = (s: Seed) => {
    const files = compileBook(loadBookInput(t.ctx, s.projectId)).files;
    return Object.entries(files).filter(([name]) => name.startsWith('chapters/')).flatMap(([, text]) => [...String(text).matchAll(/caption="([^"]+)"/g)].map((m) => m[1]));
  };

  it('no route edits an asset in place, so a copy the text does not use cannot change what a Restore brings back or what is exported', async () => {
    const s = await seed();
    await t.req('PATCH', url(s, `/${s.drawn}`), { baseRevId: s.headId, caption: 'Didascalia nuova' });
    // The first asset is the copy an older revision shows. Extras used to write to it directly.
    const r = await t.req('PATCH', `/api/assets/${s.drawn}`, { caption: 'Scritta da Extras', alt: 'Alt da Extras' });
    assert.equal(r.status, 404, 'the in-place edit is gone');
    assert.equal(getAsset(t.ctx, s.drawn).caption, 'Un cerchio');
    assert.deepEqual(exportedCaptions(s), ['Fig. 1.1 — Didascalia nuova']);
    // Restoring the first revision brings back its own caption.
    assert.equal((await t.req('POST', `/api/projects/${s.projectId}/sections/${s.nodeId}/restore`, { revId: s.headId })).status, 200);
    assert.deepEqual(exportedCaptions(s), ['Fig. 1.1 — Un cerchio']);
  });
});
