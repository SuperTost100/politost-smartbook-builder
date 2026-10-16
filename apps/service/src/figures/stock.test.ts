import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { setStockDeps, findStockPhoto, hasStockKeys, photosAvailable, saveStockKeys, stockKeys, toPng } from './stock.ts';
import { startApp, type TestApp } from '../routes/testkit.ts';

let t: TestApp;
before(async () => { t = await startApp(); });
after(async () => { setStockDeps(); await t.close(); });
beforeEach(() => { saveStockKeys(t.ctx, { pixabay: null, pexels: null }); setStockDeps({ commons: false }); });

const KEY_A = 'pixabay-secret-123';
const KEY_B = 'pexels-secret-456';

// Tiny real images: the preview/large bodies below are these bytes.
function tinyImage(kind: 'jpeg' | 'png'): Buffer {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pix.clear(200);
  return Buffer.from(kind === 'jpeg' ? pix.asJPEG(80) : pix.asPNG());
}
const JPEG = tinyImage('jpeg');

interface FakeOpts { pixabay?: unknown; pexels?: unknown; commons?: unknown; images?: Record<string, { type?: string; body?: Buffer; redirect?: string }> }
function fakeFetch(o: FakeOpts) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://pixabay.com/api/')) {
      if (o.pixabay === 'fail') return new Response('nope', { status: 500 });
      return Response.json(o.pixabay ?? { hits: [] });
    }
    if (url.startsWith('https://commons.wikimedia.org/w/api.php')) return Response.json(o.commons ?? { query: { pages: [] } });
    if (url.startsWith('https://api.pexels.com/')) {
      if (o.pexels === 'fail') throw new Error('boom');
      return Response.json(o.pexels ?? { photos: [] });
    }
    const img = o.images?.[url];
    if (img?.redirect) return new Response(null, { status: 302, headers: { location: img.redirect } });
    return new Response(new Uint8Array(img?.body ?? JPEG), { headers: { 'content-type': img?.type ?? 'image/jpeg' } });
  }) as typeof fetch;
  return { fn, calls };
}

const pixabayHit = (id: number, type = 'photo') => ({ id, pageURL: `https://pixabay.com/photos/${id}/`, type, webformatURL: `https://cdn.pixabay.com/photo/x/img-${id}_640.jpg`, user: 'Anna' });
const pexelsHit = (id: number) => ({ id, url: `https://www.pexels.com/photo/${id}/`, photographer: 'Mario Rossi', src: { medium: `https://images.pexels.com/photos/${id}/m.jpeg`, large: `https://images.pexels.com/photos/${id}/l.jpeg` } });

const commonsPage = (n: number, license = 'CC BY-SA 4.0', mime = 'image/jpeg') => ({
  title: `File:Precipitate ${n}.jpg`, index: n,
  imageinfo: [{
    mime, width: 3000, descriptionurl: `https://commons.wikimedia.org/wiki/File:Precipitate_${n}.jpg`,
    url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/Precipitate_${n}.jpg`,
    thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Precipitate_${n}.jpg/960px-Precipitate_${n}.jpg`,
    extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ada">Ada &amp; Bea</a>' } },
  }],
});

const find = (language = 'it') => findStockPhoto(t.ctx, { query: 'copper sulfate crystals', mustShow: 'blue crystals', language, projectId: 'p1' });
const model = (pick: number | null, reason = 'Shows blue crystals.') => ({ runRole: (async (_ctx: unknown, opts: { images?: Buffer[] }) => { seen.images = opts.images?.length ?? 0; return { data: { pick, reason }, text: '', route: { provider: 'x', model: 'y' }, usage: { inputTokens: null, outputTokens: null } }; }) as never });
const seen = { images: 0 };

describe('stock keys', () => {
  it('round-trips, keeps untouched keys and clears on empty or null', () => {
    assert.equal(hasStockKeys(t.ctx), false);
    saveStockKeys(t.ctx, { pixabay: ` ${KEY_A} ` });
    assert.deepEqual(stockKeys(t.ctx), { pixabay: KEY_A, pexels: null });
    saveStockKeys(t.ctx, { pexels: KEY_B });
    assert.deepEqual(stockKeys(t.ctx), { pixabay: KEY_A, pexels: KEY_B });
    saveStockKeys(t.ctx, { pixabay: '' });
    assert.deepEqual(stockKeys(t.ctx), { pixabay: null, pexels: KEY_B });
    saveStockKeys(t.ctx, { pexels: null });
    assert.equal(hasStockKeys(t.ctx), false);
  });
  it('are not part of the settings', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A, pexels: KEY_B });
    assert.ok(!JSON.stringify(t.ctx.settings()).includes(KEY_A));
    const res = await t.req('GET', '/api/settings');
    assert.ok(!res.raw.includes(KEY_A) && !res.raw.includes(KEY_B));
  });
  it('PUT /api/stock-keys saves, answers with booleans only and shows up in connections', async () => {
    const put = await t.req('PUT', '/api/stock-keys', { pixabay: KEY_A });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { pixabay: true, pexels: false });
    assert.ok(!put.raw.includes(KEY_A));
    assert.equal(stockKeys(t.ctx).pixabay, KEY_A);
    const cleared = await t.req('PUT', '/api/stock-keys', { pixabay: null, pexels: KEY_B });
    assert.deepEqual(cleared.body, { pixabay: false, pexels: true });
    assert.equal((await t.req('PUT', '/api/stock-keys', { pexels: 'x'.repeat(201) })).status, 400);
    assert.equal((await t.app.inject({ method: 'PUT', url: '/api/stock-keys', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode, 403);
  });
});

describe('toPng', () => {
  it('turns JPEG and PNG bytes into PNG', () => {
    for (const kind of ['jpeg', 'png'] as const) {
      const out = toPng(tinyImage(kind));
      assert.deepEqual([...out.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
  });
});

describe('findStockPhoto', () => {
  it('returns ok:false without any network call when no key is set', async () => {
    const f = fakeFetch({});
    setStockDeps({ commons: false, fetch: f.fn });
    const r = await find();
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 0);
  });

  it('keeps going when one service fails, and sends only the other one\'s candidates', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A, pexels: KEY_B });
    const f = fakeFetch({ pixabay: 'fail', pexels: { photos: [pexelsHit(7), pexelsHit(8)] } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(2) });
    const r = await find('en');
    assert.equal(seen.images, 2);
    assert.ok(r.ok);
    assert.equal(r.photo.provider, 'pexels');
    assert.equal(r.photo.id, '8');
    assert.ok(f.calls.some((u) => u.endsWith('/8/l.jpeg')));
  });

  it('interleaves both services and caps the list at 10', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A, pexels: KEY_B });
    const f = fakeFetch({ pixabay: { hits: Array.from({ length: 10 }, (_, i) => pixabayHit(i + 1)) }, pexels: { photos: Array.from({ length: 10 }, (_, i) => pexelsHit(i + 1)) } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(2) });
    const r = await find();
    assert.equal(seen.images, 10);
    assert.ok(r.ok && r.photo.provider === 'pexels' && r.photo.id === '1', 'candidate 2 is the first Pexels photo');
  });

  it('refuses a candidate on a foreign host and a redirect to one', async () => {
    saveStockKeys(t.ctx, { pexels: KEY_B });
    const evil = { ...pexelsHit(1), src: { medium: 'https://evil.example/m.jpg', large: 'https://evil.example/l.jpg' } };
    const redirected = pexelsHit(2);
    const f = fakeFetch({ pexels: { photos: [evil, redirected] }, images: { [redirected.src.medium]: { redirect: 'https://evil.example/x.jpg' } } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(1) });
    const r = await find();
    assert.equal(r.ok, false);
    assert.ok(!f.calls.some((u) => u.startsWith('https://evil.example')));
  });

  it('rejects a wrong content type', async () => {
    saveStockKeys(t.ctx, { pexels: KEY_B });
    const hit = pexelsHit(3);
    const f = fakeFetch({ pexels: { photos: [hit] }, images: { [hit.src.medium]: { type: 'text/html' } } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(1) });
    assert.equal((await find()).ok, false);
  });

  it('rejects a download over 1.5 MB', async () => {
    saveStockKeys(t.ctx, { pexels: KEY_B });
    const hit = pexelsHit(4);
    const f = fakeFetch({ pexels: { photos: [hit] }, images: { [hit.src.medium]: { body: Buffer.alloc(1_600_000) } } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(1) });
    assert.equal((await find()).ok, false);
  });

  it('returns ok:false with the model reason when it picks nothing', async () => {
    saveStockKeys(t.ctx, { pexels: KEY_B });
    const f = fakeFetch({ pexels: { photos: [pexelsHit(1)] } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(null, 'Only a stock lab scene.') });
    const r = await find();
    assert.ok(!r.ok);
    assert.match(r.reason, /Nothing matched: Only a stock lab scene\./);
  });

  it('rejects an out-of-range pick', async () => {
    saveStockKeys(t.ctx, { pexels: KEY_B });
    const f = fakeFetch({ pexels: { photos: [pexelsHit(1)] } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(5) });
    assert.equal((await find()).ok, false);
  });

  it('returns the picked photo with credit in Italian and English, and never leaks the keys', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A, pexels: KEY_B });
    const large = tinyImage('png');
    const f = fakeFetch({
      pixabay: { hits: [pixabayHit(11), pixabayHit(12, 'illustration')] },
      pexels: { photos: [pexelsHit(21)] },
      images: { 'https://cdn.pixabay.com/photo/x/img-11_960.jpg': { type: 'image/png', body: large } },
    });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(1, 'Blue crystals, sharp.') });
    const it = await find('it');
    assert.ok(it.ok);
    assert.equal(it.photo.provider, 'pixabay');
    assert.equal(it.photo.credit, 'Foto: Anna / Pixabay');
    assert.equal(it.photo.ext, '.png');
    assert.equal(it.photo.mime, 'image/png');
    assert.deepEqual(it.photo.bytes, large);
    assert.equal(it.photo.check, 'Blue crystals, sharp.');
    assert.equal(it.photo.pageUrl, 'https://pixabay.com/photos/11/');

    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(2) });
    const en = await find('en');
    assert.ok(en.ok);
    assert.equal(en.photo.credit, 'Photo: Mario Rossi / Pexels');

    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(3) });
    const drawing = await find('en');
    assert.ok(drawing.ok && drawing.photo.credit === 'Image: Anna / Pixabay');
    assert.ok(!JSON.stringify(drawing).includes(KEY_A));
  });

  it('falls back to the 640 px Pixabay image when the 960 px one is missing', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A });
    const f = fakeFetch({ pixabay: { hits: [pixabayHit(31)] }, images: { 'https://cdn.pixabay.com/photo/x/img-31_960.jpg': { type: 'text/html' } } });
    setStockDeps({ commons: false, fetch: f.fn, toPng: (b) => b, ...model(1) });
    const r = await find();
    assert.ok(r.ok);
    assert.ok(f.calls.at(-1)!.endsWith('_640.jpg'));
  });

  it('searches Wikimedia Commons without a key and credits the author with the licence', async () => {
    const f = fakeFetch({ commons: { query: { pages: [commonsPage(2), commonsPage(1)] } } });
    setStockDeps({ fetch: f.fn, toPng: (b) => b, ...model(1) });
    assert.ok(photosAvailable(t.ctx));
    const r = await find('it');
    assert.ok(r.ok);
    assert.equal(r.photo.provider, 'commons');
    assert.equal(r.photo.id, 'File:Precipitate 1.jpg', 'search order (index) decides, not the order of the JSON');
    assert.equal(r.photo.credit, 'Foto: Ada & Bea / Wikimedia Commons, CC BY-SA 4.0');
    assert.equal(r.photo.license, 'CC BY-SA 4.0');
    assert.equal(r.photo.pageUrl, 'https://commons.wikimedia.org/wiki/File:Precipitate_1.jpg');
    const search = new URL(f.calls[0]);
    assert.equal(search.searchParams.get('gsrsearch'), 'copper sulfate crystals filetype:bitmap');
    // The model sees the 500 px thumbnails (a standard width); the book gets the 960 px one.
    assert.ok(f.calls.includes('https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Precipitate_1.jpg/500px-Precipitate_1.jpg'));
    assert.equal(f.calls.at(-1), 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Precipitate_1.jpg/960px-Precipitate_1.jpg');
  });

  it('skips Commons files whose licence a credit line cannot satisfy, and non-photo types', async () => {
    const f = fakeFetch({ commons: { query: { pages: [commonsPage(1, 'GFDL'), commonsPage(2, 'CC BY-NC 2.0'), commonsPage(3, 'CC BY 4.0', 'image/tiff'), commonsPage(4, 'Public domain'), commonsPage(5, 'CC0')] } } });
    setStockDeps({ fetch: f.fn, toPng: (b) => b, ...model(2) });
    const r = await find('en');
    assert.equal(seen.images, 2);
    assert.ok(r.ok);
    assert.equal(r.photo.id, 'File:Precipitate 5.jpg');
    assert.equal(r.photo.credit, 'Photo: Ada & Bea / Wikimedia Commons, CC0');
  });

  it('sends a User-Agent that names the builder, as Wikimedia asks', async () => {
    const headers: (string | null)[] = [];
    const f = fakeFetch({ commons: { query: { pages: [commonsPage(1)] } } });
    const spy = (async (input: string | URL | Request, init?: RequestInit) => { headers.push(new Headers(init?.headers).get('user-agent')); return f.fn(input, init); }) as typeof fetch;
    setStockDeps({ fetch: spy, toPng: (b) => b, ...model(1) });
    assert.ok((await find()).ok);
    assert.ok(headers.length >= 3 && headers.every((h) => h?.startsWith('PolitostSmartbookBuilder/')));
  });

  it('mixes Commons with the stock services, Commons first', async () => {
    saveStockKeys(t.ctx, { pixabay: KEY_A });
    const f = fakeFetch({ commons: { query: { pages: [commonsPage(1)] } }, pixabay: { hits: [pixabayHit(11)] } });
    setStockDeps({ fetch: f.fn, toPng: (b) => b, ...model(2) });
    const r = await find();
    assert.equal(seen.images, 2);
    assert.ok(r.ok && r.photo.provider === 'pixabay' && r.photo.license === null);
  });

  it('never offers a photo the book already uses', async () => {
    const f = fakeFetch({ commons: { query: { pages: [commonsPage(1), commonsPage(2)] } } });
    setStockDeps({ fetch: f.fn, toPng: (b) => b, ...model(1) });
    const r = await findStockPhoto(t.ctx, { query: 'q', mustShow: 'm', language: 'it', projectId: 'p1', exclude: new Set(['commons:File:Precipitate 1.jpg']) });
    assert.equal(seen.images, 1);
    assert.ok(r.ok && r.photo.id === 'File:Precipitate 2.jpg');
  });
});
