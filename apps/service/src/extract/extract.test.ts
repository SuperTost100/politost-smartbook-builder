import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { detectKind, storeResource, extractResource, renderPageImage, findPassage, searchPages, segmentQuestions, ExtractError, isBlockedAddress, safeFetch, htmlToMarkdown, LIBREOFFICE_MISSING } from './index.ts';
import { segmentExams, segmentNumberedQuiz } from './segment.ts';
import { seedPage, seedResource } from '../llm/testkit.ts';
import { paths, resolveDataPath } from '../config.ts';
import { makeCtx, makePdf, makeZip, makeDocx } from './testkit.ts';

const SRC = '/home/tost/politost-sources/Analisi';
const haveSources = existsSync(SRC);
const signal = () => new AbortController().signal;
const hasSoffice = (() => { try { execFileSync('which', ['soffice'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const synthetic = () =>
  makePdf(
    [['Il dominio della funzione radice quadrata.', 'Secondo rigo di prova con x e y.'], ['Seconda pagina: limiti e continuita di una funzione.'], ['Terza pagina: integrali impropri.']],
    [{ title: 'Capitolo uno', page: 0 }, { title: 'Capitolo due', page: 1 }],
  );

// ---------- kind detection and storage ----------

test('detectKind: content decides, unsupported input is rejected with a clear message', () => {
  assert.equal(detectKind('x.bin', synthetic()), 'pdf');
  assert.equal(detectKind('x.docx', makeDocx(['ciao'])), 'docx');
  assert.equal(detectKind('slides.pdf', makeZip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p/>' })), 'pptx');
  assert.equal(detectKind('notes.md', Buffer.from('# Titolo\n\ntesto è ok')), 'md');
  assert.equal(detectKind('notes.markdown', Buffer.from('# Titolo')), 'md');
  assert.throws(() => detectKind('notes.txt', Buffer.from('plain text')), /not supported/);
  assert.throws(() => detectKind('a.md', Buffer.from([0xff, 0xfe, 0x41, 0x80])), /UTF-8/);
  assert.throws(() => detectKind('a.md', Buffer.from([0x23, 0x00, 0x41])), /UTF-8/);
  assert.throws(() => detectKind('a.xlsx', makeZip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<w/>' })), /Excel/);
  assert.throws(() => detectKind('a.zip', makeZip({ 'readme.txt': 'hi' })), ExtractError);
  assert.throws(() => detectKind('a.pdf', Buffer.alloc(0)), /empty/);
  assert.throws(() => detectKind('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), /not supported/);
});

test('storeResource: content-addressed file, dedupe by sha256, queued row', async () => {
  const { ctx, projectId } = makeCtx();
  const bytes = synthetic();
  const id = await storeResource(ctx, projectId, { filename: '../../evil/Appunti.pdf', bytes, role: 'theory' });
  const again = await storeResource(ctx, projectId, { filename: 'other-name.pdf', bytes, role: 'mixed' });
  assert.equal(again, id);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM resources WHERE id = ?', id)!;
  assert.equal(row.kind, 'pdf');
  assert.equal(row.status, 'queued');
  assert.equal(row.filename, 'Appunti.pdf');
  assert.equal(row.sha256, sha);
  assert.equal(row.size, bytes.length);
  assert.equal(row.path, `projects/${projectId}/resources/${sha}.pdf`, 'stored relative to the data directory');
  assert.deepEqual(readFileSync(resolveDataPath(ctx.config, row.path as string)), bytes);
  assert.equal(resolveDataPath(ctx.config, row.path as string), join(paths.resources(ctx.config, projectId), `${sha}.pdf`));
  assert.equal(readdirSync(paths.resources(ctx.config, projectId)).filter((f) => f.endsWith('.tmp')).length, 0);
  assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM resources')!.n, 1);
  await assert.rejects(storeResource(ctx, projectId, { filename: 'a.txt', bytes: Buffer.from('x'), role: 'theory' }), /not supported/);
  await assert.rejects(storeResource(ctx, projectId, { filename: 'a.pdf', bytes, role: 'nonsense' }), /role/);
});

// ---------- PDF extraction, FTS, outline, render ----------

test('extractResource: pages, labels, outline, FTS and idempotent replace', async () => {
  const { ctx, projectId } = makeCtx();
  const id = await storeResource(ctx, projectId, { filename: 'syn.pdf', bytes: synthetic(), role: 'theory' });
  const out = await extractResource(ctx, id, signal());
  assert.equal(out.pages, 3);
  assert.deepEqual(out.index?.entries, [{ title: 'Capitolo uno', level: 1, page: 0 }, { title: 'Capitolo due', level: 1, page: 1 }]);
  const pages = ctx.db.all<{ idx: number; label: string; text: string; quality: string }>('SELECT idx, label, text, quality FROM pages WHERE resource_id = ? ORDER BY idx', id);
  assert.deepEqual(pages.map((p) => p.label), ['1', '2', '3']);
  assert.match(pages[0].text, /dominio della funzione radice/);
  assert.equal(pages[0].quality, 'good');
  const res = ctx.db.get<{ status: string; page_count: number; error: string | null }>('SELECT status, page_count, error FROM resources WHERE id = ?', id)!;
  assert.deepEqual({ ...res }, { status: 'ready', page_count: 3, error: null });
  assert.equal(ctx.db.get<{ origin: string }>('SELECT origin FROM source_indexes WHERE resource_id = ?', id)!.origin, 'extracted');

  // FTS search finds the page that holds both words; accents and case do not matter.
  const hits = searchPages(ctx, projectId, 'Dominio radice');
  assert.equal(hits[0].resourceId, id);
  assert.equal(hits[0].idx, 0);
  assert.match(hits[0].snippet, /dominio/i);
  assert.deepEqual(searchPages(ctx, projectId, 'AND OR NOT "*" ('), []);
  assert.deepEqual(searchPages(ctx, projectId, 'dominio', { resourceIds: [] }), []);
  assert.equal(searchPages(ctx, projectId, 'integrali', { resourceIds: [id] })[0].idx, 2);
  ctx.db.update('resources', id, { included: 0 });
  assert.deepEqual(searchPages(ctx, projectId, 'dominio'), []);
  ctx.db.update('resources', id, { included: 1 });

  // A transcription survives re-extraction of the same bytes; rows and FTS stay in step.
  ctx.db.run(`UPDATE pages SET transcript = 'Il $\\sqrt{x}$ ha dominio $x \\ge 0$', transcript_model = 'm' WHERE resource_id = ? AND idx = 0`, id);
  await extractResource(ctx, id, signal());
  const kept = ctx.db.get<{ transcript: string }>('SELECT transcript FROM pages WHERE resource_id = ? AND idx = 0', id)!;
  assert.match(kept.transcript, /sqrt/);
  assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM pages WHERE resource_id = ?', id)!.n, 3);
  assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM pages_fts')!.n, 3);
  assert.equal(searchPages(ctx, projectId, 'sqrt')[0].idx, 0);
});

test('extractResource: bad PDF fails with an error on the row; abort terminates the worker', async () => {
  const { ctx, projectId } = makeCtx();
  const bad = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not really a pdf')]);
  const id = await storeResource(ctx, projectId, { filename: 'bad.pdf', bytes: bad, role: 'theory' });
  await assert.rejects(extractResource(ctx, id, signal()));
  const row = ctx.db.get<{ status: string; error: string }>('SELECT status, error FROM resources WHERE id = ?', id)!;
  assert.equal(row.status, 'failed');
  assert.ok(row.error.length > 0);

  const ok = await storeResource(ctx, projectId, { filename: 'ok.pdf', bytes: synthetic(), role: 'theory' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(extractResource(ctx, ok, ac.signal), { name: 'AbortError' });
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM resources WHERE id = ?', ok)!.status, 'queued');
});

test('renderPageImage: PNG, cache by scale, highlight is never cached; non-PDF resources throw 404', async () => {
  const { ctx, projectId } = makeCtx();
  const id = await storeResource(ctx, projectId, { filename: 'syn.pdf', bytes: synthetic(), role: 'theory' });
  await extractResource(ctx, id, signal());
  const png = await renderPageImage(ctx, id, 0, {});
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dir = paths.pageCache(ctx.config, projectId, id);
  assert.deepEqual(readdirSync(dir), ['0@1.5.png']);
  const cached = await renderPageImage(ctx, id, 0, { scale: 1.5 });
  assert.deepEqual(cached, png);
  const hl = await renderPageImage(ctx, id, 0, { highlight: 'Il dominio della funzione radice quadrata' });
  assert.notDeepEqual(hl, png);
  assert.deepEqual(readdirSync(dir), ['0@1.5.png']);
  const noMatch = await renderPageImage(ctx, id, 0, { highlight: 'testo che non esiste da nessuna parte nella pagina' });
  assert.deepEqual(noMatch, png);
  await renderPageImage(ctx, id, 1, { scale: 1 });
  assert.deepEqual(readdirSync(dir).sort(), ['0@1.5.png', '1@1.png']);
  await assert.rejects(renderPageImage(ctx, id, 99, {}), (e: ExtractError) => e.status === 404);

  const md = await storeResource(ctx, projectId, { filename: 'n.md', bytes: Buffer.from('# A\n\ntesto'), role: 'theory' });
  await extractResource(ctx, md, signal());
  await assert.rejects(renderPageImage(ctx, md, 0, {}), (e: ExtractError) => e.status === 404);
});

// ---------- Markdown and URL ----------

test('Markdown: pages split at H1/H2, labels are headings, index from headings', async () => {
  const { ctx, projectId } = makeCtx();
  const md = '# Limiti\n\nIntroduzione ai limiti.\n\n## Definizione\n\nUn limite è...\n\n### Nota\n\ndettaglio\n\n```\n# non un titolo\n```\n\n## Teoremi\n\nPermanenza del segno.\n';
  const id = await storeResource(ctx, projectId, { filename: 'limiti.md', bytes: Buffer.from(md), role: 'theory' });
  const out = await extractResource(ctx, id, signal());
  assert.equal(out.pages, 3);
  const pages = ctx.db.all<{ label: string; quality: string; text: string }>('SELECT label, quality, text FROM pages WHERE resource_id = ? ORDER BY idx', id);
  assert.deepEqual(pages.map((p) => p.label), ['Limiti', 'Definizione', 'Teoremi']);
  assert.ok(pages.every((p) => p.quality === 'good'));
  assert.match(pages[1].text, /# non un titolo/);
  assert.deepEqual(out.index?.entries.map((e) => [e.title, e.level, e.page]), [['Limiti', 1, 0], ['Definizione', 2, 1], ['Nota', 3, 1], ['Teoremi', 2, 2]]);
  assert.equal(searchPages(ctx, projectId, 'permanenza')[0].idx, 2);
});

test('htmlToMarkdown keeps title, h1-h3, paragraphs and list items; drops scripts, styles and nav', () => {
  const { title, markdown } = htmlToMarkdown(
    `<html><head><title>Corso &amp; Appunti</title><style>.a{}</style></head><body><nav><a>Home</a></nav><script>var x=1</script>
     <h1>Limiti</h1><p>Il limite di <b>f</b> &egrave; finito.</p><h2>Esempi</h2><ul><li>uno</li><li>due</li></ul><h3>Nota</h3><p>fine</p>
     <footer>(c) 2020</footer></body></html>`,
  );
  assert.equal(title, 'Corso & Appunti');
  assert.equal(markdown, '# Limiti\n\nIl limite di f è finito.\n\n## Esempi\n\n- uno\n- due\n\n### Nota\n\nfine');
});

test('URL storage refuses loopback, private, link-local, file and DNS-resolved private targets', async () => {
  const { ctx, projectId } = makeCtx();
  for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/', 'http://224.0.0.1/', 'http://[fd00::1]/', 'file:///etc/passwd', 'ftp://example.com/x']) {
    await assert.rejects(storeResource(ctx, projectId, { url, role: 'theory' }), (e: ExtractError) => e instanceof ExtractError && e.status === 400, url);
  }
  assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM resources')!.n, 0);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1']) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(a), false, a);
});

test('safeFetch against a local fixture server: HTML to Markdown, redirects, size, type and timeout limits', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Pagina</title></head><body><h1>Titolo</h1><p>Testo del corso.</p></body></html>');
    } else if (url.pathname === '/r') {
      const n = Number(url.searchParams.get('n') ?? 0);
      res.statusCode = 302;
      res.setHeader('location', n > 0 ? `/r?n=${n - 1}` : '/page');
      res.end();
    } else if (url.pathname === '/big') {
      res.setHeader('content-type', 'text/plain');
      res.end(Buffer.alloc(2 * 1024 * 1024, 65));
    } else if (url.pathname === '/img') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([1, 2, 3]));
    } else if (url.pathname === '/slow') {
      res.setHeader('content-type', 'text/plain');
      res.write('start');
    } else res.statusCode = 404, res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ok = await safeFetch(`${base}/page`, { allowPrivate: true });
    assert.match(ok.body.toString(), /Testo del corso/);
    const hop = await safeFetch(`${base}/r?n=4`, { allowPrivate: true });
    assert.equal(hop.redirects.length, 5);
    assert.equal(hop.finalUrl, `${base}/page`);
    await assert.rejects(safeFetch(`${base}/r?n=5`, { allowPrivate: true }), /redirected more than 5/);
    await assert.rejects(safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1024 * 1024 }), /larger than/);
    await assert.rejects(safeFetch(`${base}/img`, { allowPrivate: true }), /Only web pages/);
    await assert.rejects(safeFetch(`${base}/missing`, { allowPrivate: true }), /status 404/);
    await assert.rejects(safeFetch(`${base}/slow`, { allowPrivate: true, timeoutMs: 300 }), /longer than 20 seconds/);
    // Without the test switch the same server is refused.
    await assert.rejects(safeFetch(`${base}/page`), /private or local/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('safeFetch settles when a compressed response is cut off after the headers', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    setTimeout(() => res.socket?.destroy(), 50);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const started = Date.now();
    await assert.rejects(safeFetch(`${base}/`, { allowPrivate: true, timeoutMs: 5000 }), /could not be fetched/);
    assert.ok(Date.now() - started < 3000, 'settled long before the overall timeout');
    // Headers only, then silence: the overall timeout settles it.
    const silent = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.flushHeaders(); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(safeFetch(`http://127.0.0.1:${(silent.address() as { port: number }).port}/`, { allowPrivate: true, timeoutMs: 300 }), /longer than 20 seconds/);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('URL resource: raw HTML and derived Markdown stored, fetch date and final URL in meta, pages split by heading', async () => {
  const { ctx, projectId } = makeCtx();
  const html = '<html><head><title>Limiti di funzioni</title></head><body><nav>menu</nav><h1>Limiti</h1><p>Un limite descrive il comportamento.</p><h2>Teorema del confronto</h2><p>Se f &lt;= g allora i limiti si confrontano.</p></body></html>';
  const server = http.createServer((req, res) => {
    if (req.url === '/old') { res.statusCode = 301; res.setHeader('location', '/corso/limiti.html'); return res.end(); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const id = await storeResource(ctx, projectId, { url: `${base}/old`, role: 'theory' }, { fetch: { allowPrivate: true } });
    const again = await storeResource(ctx, projectId, { url: `${base}/other`, role: 'theory' }, { fetch: { allowPrivate: true } });
    assert.equal(again, id, 'same page content dedupes');
    const row = ctx.db.get<{ kind: string; url: string; filename: string; path: string; sha256: string; meta: string }>('SELECT kind, url, filename, path, sha256, meta FROM resources WHERE id = ?', id)!;
    assert.equal(row.kind, 'url');
    assert.equal(row.url, `${base}/old`);
    assert.equal(row.filename, 'Limiti di funzioni');
    const meta = JSON.parse(row.meta);
    assert.equal(meta.finalUrl, `${base}/corso/limiti.html`);
    assert.match(meta.fetchedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(readFileSync(resolveDataPath(ctx.config, row.path), 'utf8'), html);
    assert.equal(row.path, `projects/${projectId}/resources/${row.sha256}.html`);
    assert.match(readFileSync(join(paths.resources(ctx.config, projectId), `${row.sha256}.md`), 'utf8'), /^# Limiti\n\nUn limite/);
    const out = await extractResource(ctx, id, signal());
    assert.equal(out.pages, 2);
    assert.deepEqual(out.index?.entries.map((e) => e.title), ['Limiti', 'Teorema del confronto']);
    const text = ctx.db.get<{ text: string }>('SELECT text FROM pages WHERE resource_id = ? AND idx = 1', id)!.text;
    assert.match(text, /^## Teorema del confronto/);
    assert.doesNotMatch(text, /menu/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---------- Office files ----------

test('DOCX without LibreOffice fails with the install message', async () => {
  const { ctx, projectId } = makeCtx();
  const id = await storeResource(ctx, projectId, { filename: 'a.docx', bytes: makeDocx(['Ciao']), role: 'theory' });
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(extractResource(ctx, id, signal()), (e: Error) => e.message === LIBREOFFICE_MISSING);
  } finally {
    process.env.PATH = saved;
  }
  const row = ctx.db.get<{ status: string; error: string }>('SELECT status, error FROM resources WHERE id = ?', id)!;
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'LibreOffice is needed to read Word and PowerPoint files. Install it, then retry.');
});

test('DOCX with LibreOffice: converted, kind kept, text searchable, pages renderable', { skip: !hasSoffice, timeout: 150_000 }, async () => {
  const { ctx, projectId } = makeCtx();
  const id = await storeResource(ctx, projectId, { filename: 'a.docx', bytes: makeDocx(['Il dominio della radice quadrata.']), role: 'theory' });
  const out = await extractResource(ctx, id, signal());
  assert.ok(out.pages >= 1);
  assert.equal(ctx.db.get<{ kind: string }>('SELECT kind FROM resources WHERE id = ?', id)!.kind, 'docx');
  assert.equal(searchPages(ctx, projectId, 'dominio radice')[0].idx, 0);
  const png = await renderPageImage(ctx, id, 0, {});
  assert.equal(png[1], 0x50);
});

// ---------- Real course material ----------

const realCtx = async (files: Record<string, { path: string; role: string }>) => {
  const k = makeCtx();
  const ids: Record<string, string> = {};
  for (const [key, f] of Object.entries(files)) {
    ids[key] = await storeResource(k.ctx, k.projectId, { filename: f.path.split('/').pop()!, bytes: readFileSync(join(SRC, f.path)), role: f.role });
  }
  return { ...k, ids };
};

const dist = (ctx: ReturnType<typeof makeCtx>['ctx'], id: string) => {
  const rows = ctx.db.all<{ quality: string; n: number }>('SELECT quality, count(*) AS n FROM pages WHERE resource_id = ? GROUP BY quality', id);
  const d = { good: 0, garbled: 0, empty: 0 } as Record<string, number>;
  for (const r of rows) d[r.quality] = Number(r.n);
  return d;
};

test('real notes: page counts, outline and garbled distribution', { skip: !haveSources, timeout: 120_000 }, async () => {
  const k = await realCtx({
    riassunto: { path: 'APPUNTI/RiassuntoAnalisi1.pdf', role: 'theory' },
    ponzy: { path: 'APPUNTI/Teoria Analisi 1 by ponzy.pdf', role: 'theory' },
    exam: { path: 'ESAME/Esami scritti 2022-23.pdf', role: 'exams' },
  });
  const r = await extractResource(k.ctx, k.ids.riassunto, signal());
  assert.equal(r.pages, 83);
  assert.ok(r.index && r.index.entries.length > 20);
  assert.deepEqual(r.index!.entries[0], { title: 'Intervalli di R', level: 1, page: 8 });
  assert.ok(r.index!.entries.some((e) => e.level === 2 && e.title === 'Maggioranti e minoranti' && e.page === 9));
  const d = dist(k.ctx, k.ids.riassunto);
  // Prose and definitions read well; chapters full of formulas do not.
  assert.ok(d.good >= 25 && d.garbled >= 35, JSON.stringify(d));
  const label10 = k.ctx.db.get<{ label: string }>('SELECT label FROM pages WHERE resource_id = ? AND idx = 10', k.ids.riassunto)!;
  assert.equal(label10.label, '3');
  // Detached accents are repaired in stored text.
  const p10 = k.ctx.db.get<{ text: string }>('SELECT text FROM pages WHERE resource_id = ? AND idx = 10', k.ids.riassunto)!;
  assert.match(p10.text, /è maggiorante/);

  await extractResource(k.ctx, k.ids.ponzy, signal());
  const dp = dist(k.ctx, k.ids.ponzy);
  assert.equal(dp.good + dp.garbled + dp.empty, 34);
  assert.ok(dp.good <= 3 && dp.garbled + dp.empty >= 31, JSON.stringify(dp));

  await extractResource(k.ctx, k.ids.exam, signal());
  const de = dist(k.ctx, k.ids.exam);
  assert.equal(de.good + de.garbled + de.empty, 19);
  assert.ok(de.garbled >= 12, JSON.stringify(de));
  console.log('garbled distribution riassunto', d, 'ponzy', dp, 'exam 2022-23', de);
});

test('exam papers without an Analisi heading: Prova scritta, fila variants, file-named templates, SOLUZIONI markers', () => {
  const paper = (head: string[], solutions: string[][]) => [
    { idx: 0, text: ['1', ...head, 'Cognome', 'Nome', 'Esercizio 1 (8 punti)', 'Un corpo di massa m scende.', 'Esercizio 2 (8 punti)', 'Una molla di costante k.'].join('\n') },
    ...solutions.map((lines, i) => ({ idx: i + 1, text: [String(i + 2), ...lines].join('\n') })),
  ];
  const a = segmentExams('r1', paper(['Prova scritta 25.6.26- Corso 13 - Prof. M. Rossi', 'Compito FILA A'], [
    ['Soluzione Esercizio 1', 'a) Dalla conservazione dell’energia.'],
    ['Soluzione Esercizio 2', 'b) Il periodo vale T.'],
  ]), { label: 'giugno_filaA_sol', untitled: true });
  assert.deepEqual(a.map((x) => `${x.examGroup} #${x.number} ${x.examDate} p${x.pageFrom}-${x.pageTo}`), [
    'Prova scritta del 25 giugno 2026 #1A 2026-06-25 p0-1', 'Prova scritta del 25 giugno 2026 #2A 2026-06-25 p0-2',
  ]);
  assert.match(a[0].statement, /Un corpo di massa/);
  assert.doesNotMatch(a[0].statement, /Cognome/);
  assert.match(a[1].solution, /^Soluzione Esercizio 2\nb\) Il periodo/);

  // Year from the file name; "Esercizio N _ SOLUZIONE" after a SOLUZIONI line; a header repeated on the next page continues the solution.
  const b = segmentExams('r2', paper(['Prova scritta 11/07- Compito A1 (Corso n)'], [
    ['SOLUZIONI', 'Esercizio 1 _ SOLUZIONE', 'Si conserva la quantità di moto.', 'Esercizio 2 _ SOLUZIONE', 'Primo passo.'],
    ['Esercizio 2 _ SOLUZIONE', 'Secondo passo.'],
  ]), { label: '2022 - TEMA_2', untitled: true });
  assert.deepEqual(b.map((x) => `${x.examGroup} #${x.number} ${x.examDate} p${x.pageFrom}-${x.pageTo}`), [
    'Prova scritta del 11 luglio 2022 #1A1 2022-07-11 p0-1', 'Prova scritta del 11 luglio 2022 #2A1 2022-07-11 p0-2',
  ]);
  assert.match(b[1].solution, /Primo passo\.\nSecondo passo\./);

  // A blank template has no date: the session is named after the file.
  const c = segmentExams('r3', paper(['Prova scritta xx-xx-xxxx - Corso x - Prof. xxx'], [['SOLUZIONE', 'Esercizio 1 (8 punti)', 'Uno.', 'Esercizio 2 (8 punti)', 'Due.']]), { label: 'TEMA ESAME 2025 - 1', untitled: true });
  assert.deepEqual(c.map((x) => `${x.examGroup} #${x.number} ${x.examDate}`), ['Prova scritta - TEMA ESAME 2025 - 1 #1 null', 'Prova scritta - TEMA ESAME 2025 - 1 #2 null']);
  assert.deepEqual(c.map((x) => x.solution), ['Esercizio 1 (8 punti)\nUno.', 'Esercizio 2 (8 punti)\nDue.']);
});

test('exercise sheets with plain "Esercizio N" and no heading become one group per file, only when asked', () => {
  const pages = [{ idx: 0, text: 'Tutorato Settimana 3\nApril 2020\nEsercizio 1\nUn blocco scivola.\n1. v0 = 5 m/s\nEsercizio 2\nUna molla.' }];
  const q = segmentExams('r4', pages, { label: 'tutorato_settimana_3', kind: 'exercise', untitled: true });
  assert.deepEqual(q.map((x) => `${x.kind} ${x.examGroup} #${x.number}`), ['exercise tutorato_settimana_3 #1', 'exercise tutorato_settimana_3 #2']);
  assert.match(q[0].statement, /Un blocco scivola\.\n1\. v0/);
  assert.equal(segmentExams('r4', pages).length, 0);
});

// The layout of a "DBQuiz" file: "N) statement", options "a)" to "d)" (one may be split from its text), no answer key in the text.
const QUIZ_PAGES = [
  { idx: 0, text: 'Quiz fisica 1\nMEMO: VERIFICATA DUBBIO\n\n1) Sistema aperto, per avere lavoro massimo:\na) Nessuna\nb) Adiabatico\nc) Irreversibile\nd) Reversibile\n\n2) Gas a trasformazione reversibile da A a B. T=kS. Valore di Qab\nscambiato?\n\na) Qab= k*(Sb\n\n^2-Sa\n\n^2)\nb) Qab= TbSb - TaSa\nc)\nQab= k/2* (Sb\n\n^2-Sa\n\n^2)\nd) Qab= 0\n\n3) Un grave di massa m, in moto in un fluido, è soggetto a una forza F=-kv. Che dimensioni ha m/k?\n\na) [T]^-1\nb) [L][T]^-1\nc) [L]' },
  { idx: 1, text: 'd) [T]\n\n4) Quale affermazione è vera nel caso di fluido ideale:\na) E’ un fluido con coefficiente di viscosità nullo\nb) La portata dipende dalla densità\nc) Nessuna delle altre\nd) E’ sempre comprimibile\n\n6) Si misura sei volte la lunghezza di un’asta. Determinare 1) la sensibilità, 2) l’errore assoluto\n\na) 1) 0,01; 2) 0,02 m\nb) 1) 0,1; 2) 0,02 m\nc)\n1) 0,01; 2) 0,04 m\nd) 1) 0,02; 2) 0,04 m' },
  { idx: 2, text: '1) Seconda raccolta, primo quesito: quanto vale la somma 2+2?\na) 3\nb) 4\nc) 5\nd) 6\n\n2) Quanto vale la radice di 9?\na) 3\nb) 9\nc) 1\nd) 0' },
];

test('numbered quizzes ("N)" with options a) to d)): statement keeps the options as a list, restarts make blocks, no solution', () => {
  const q = segmentNumberedQuiz('r5', QUIZ_PAGES, 'DBQuiz_Fisica1');
  assert.deepEqual(q.map((x) => `${x.examGroup} #${x.number} p${x.pageFrom}-${x.pageTo}`), [
    'DBQuiz_Fisica1 - blocco 1 #1 p0-0', 'DBQuiz_Fisica1 - blocco 1 #2 p0-0', 'DBQuiz_Fisica1 - blocco 1 #3 p0-1',
    'DBQuiz_Fisica1 - blocco 1 #4 p1-1', 'DBQuiz_Fisica1 - blocco 1 #6 p1-1',
    'DBQuiz_Fisica1 - blocco 2 #1 p2-2', 'DBQuiz_Fisica1 - blocco 2 #2 p2-2',
  ]);
  assert.ok(q.every((x) => x.kind === 'exercise' && x.origin === 'authentic' && x.chapterId === null && x.solution === '' && x.examDate === null));
  assert.equal(q[0].statement, 'Sistema aperto, per avere lavoro massimo:\n\n- a) Nessuna\n- b) Adiabatico\n- c) Irreversibile\n- d) Reversibile');
  // Wrapped options are joined and an option letter alone on its line takes the next line.
  assert.match(q[1].statement, /^Gas a trasformazione reversibile da A a B\. T=kS\. Valore di Qab\nscambiato\?\n\n- a\) Qab= k\*\(Sb \^2-Sa \^2\)\n- b\) /);
  assert.match(q[1].statement, /- c\) Qab= k\/2\* \(Sb \^2-Sa \^2\)\n- d\) Qab= 0$/);
  // An option on the next page stays with its question; "[T]" is the time dimension, not an answer mark.
  assert.match(q[2].statement, /- c\) \[L\]\n- d\) \[T\]$/);
  // "1) …" inside an option is not a new question, and a skipped number is fine.
  assert.match(q[4].statement, /- c\) 1\) 0,01; 2\) 0,04 m\n- d\) /);
});

test('numbered quizzes: one block is named after the file, and a sheet with a few lettered lines is not a quiz', () => {
  assert.deepEqual([...new Set(segmentNumberedQuiz('r6', QUIZ_PAGES.slice(0, 2), 'DBQuiz_Fisica1').map((x) => x.examGroup))], ['DBQuiz_Fisica1']);
  assert.deepEqual(segmentNumberedQuiz('r7', [{ idx: 0, text: 'Esercizio 1\n1) Calcola il limite.\na) per x che tende a 0\nb) per x che tende a 1\n2) Studia la funzione.\nEsercizio 2\nSvolgi.' }], 'foglio'), []);
});

test('segmentQuestions: an "exercises" source falls back to the numbered layout when it has no simulazioni; an exam source does not', () => {
  const { ctx, projectId } = makeCtx();
  seedResource(ctx, { id: 'quiz1', projectId, role: 'exercises', filename: 'DBQuiz_Fisica1.pdf' });
  for (const p of QUIZ_PAGES) seedPage(ctx, 'quiz1', p.idx, p.text);
  const rows = segmentQuestions(ctx, 'quiz1');
  assert.equal(rows.length, 7);
  assert.ok(rows.every((x) => x.kind === 'exercise' && x.examGroup!.startsWith('DBQuiz_Fisica1 - blocco')));
  seedResource(ctx, { id: 'ex1', projectId, role: 'exams', filename: 'Fisica.pdf' });
  for (const p of QUIZ_PAGES) seedPage(ctx, 'ex1', p.idx, p.text);
  assert.equal(segmentQuestions(ctx, 'ex1').length, 0);
});

test('real exams: segmentation of 2022-23 and 2014-15, solutions matched by exercise number', { skip: !haveSources, timeout: 120_000 }, async () => {
  const k = await realCtx({
    e2223: { path: 'ESAME/Esami scritti 2022-23.pdf', role: 'exams' },
    e1415: { path: 'ESAME/Esami scritti 2014-15.pdf', role: 'exams' },
  });
  await extractResource(k.ctx, k.ids.e2223, signal());
  await extractResource(k.ctx, k.ids.e1415, signal());

  const q = segmentQuestions(k.ctx, k.ids.e2223);
  assert.deepEqual(q.map((x) => `${x.examGroup} #${x.number}`), [
    'Esame del 25 gennaio 2023 - turno 1 #1', 'Esame del 25 gennaio 2023 - turno 1 #2A', 'Esame del 25 gennaio 2023 - turno 1 #2B',
    'Esame del 25 gennaio 2023 - turno 2 #1', 'Esame del 25 gennaio 2023 - turno 2 #2',
    'Esame del 10 febbraio 2023 #1', 'Esame del 10 febbraio 2023 #2',
  ]);
  assert.deepEqual(q.map((x) => x.examDate), ['2023-01-25', '2023-01-25', '2023-01-25', '2023-01-25', '2023-01-25', '2023-02-10', '2023-02-10']);
  assert.ok(q.every((x) => x.kind === 'exam' && x.origin === 'authentic' && x.difficulty === 'medio' && x.solution.length > 100 && x.pageFrom! <= x.pageTo!));
  assert.match(q[0].statement, /^Esercizio 1\.[\s\S]*Si consideri la funzione/);
  assert.match(q[0].solution, /^Esercizio 1\.[\s\S]*Le condizioni di esistenza richiedono/);
  assert.match(q[1].solution, /Versione A/);
  assert.match(q[2].solution, /Versione B/);
  assert.doesNotMatch(q[0].statement, /Politecnico di Torino|SVOLGIMENTO/);
  assert.equal(q[0].pageFrom, 1);

  const old = segmentQuestions(k.ctx, k.ids.e1415);
  assert.equal(old.length, 11);
  assert.deepEqual([...new Set(old.map((x) => x.examGroup))], [
    'Esame del 30 gennaio 2015', 'Esame del 13 febbraio 2015 - Io turno', 'Esame del 13 febbraio 2015 - IIo turno', 'Esame del 17 giugno 2015', 'Esame del 9 settembre 2015',
  ]);
  assert.deepEqual(old.filter((x) => x.examGroup!.includes('IIo')).map((x) => x.number), ['1', '2.1', '2.2']);
  assert.ok(old.every((x) => x.solution.length > 50));
  assert.equal(old.find((x) => x.examGroup === 'Esame del 9 settembre 2015' && x.number === '1')!.examDate, '2015-09-09');
});

test('real exams: every collection yields sessions with two or three exercises each', { skip: !haveSources, timeout: 120_000 }, async () => {
  const files = readdirSync(join(SRC, 'ESAME')).filter((f) => f.endsWith('.pdf'));
  const k = await realCtx(Object.fromEntries(files.map((f) => [f, { path: `ESAME/${f}`, role: 'exams' }])));
  let total = 0;
  for (const f of files) {
    await extractResource(k.ctx, k.ids[f], signal());
    const q = segmentQuestions(k.ctx, k.ids[f]);
    total += q.length;
    assert.ok(q.length >= 6, `${f}: ${q.length}`);
    const withSolution = q.filter((x) => x.solution).length;
    assert.ok(withSolution >= q.length * 0.6, `${f}: ${withSolution}/${q.length} with solution`);
  }
  assert.ok(total > 150, String(total));
});

test('real NotebookLM citations resolve to the right exam pages', { skip: !haveSources, timeout: 120_000 }, async () => {
  const fixture = join(import.meta.dirname, '../../../../fixtures/notebooklm/query-exam-2023.json');
  const k = await realCtx({ e2223: { path: 'ESAME/Esami scritti 2022-23.pdf', role: 'exams' } });
  await extractResource(k.ctx, k.ids.e2223, signal());
  const refs = JSON.parse(readFileSync(fixture, 'utf8')).references as { citation_number: number; cited_text: string }[];
  assert.equal(refs.length, 3);
  // The first passage starts on the contents page and runs onto page 2; the last starts at the foot of page 2 and runs onto the solutions.
  const expected: Record<number, number> = { 1: 0, 2: 1, 3: 1 };
  for (const ref of refs) {
    const hit = findPassage(k.ctx, [k.ids.e2223], ref.cited_text);
    assert.ok(hit, `reference ${ref.citation_number} not found`);
    assert.equal(hit.idx, expected[ref.citation_number], `reference ${ref.citation_number}`);
    assert.ok(hit.score >= 0.9 && hit.score <= 1);
  }
  assert.equal(findPassage(k.ctx, [k.ids.e2223], 'Il teorema di Weierstrass garantisce che una funzione continua su un compatto ha massimo, ma questa frase non è nel documento.'), null);
  assert.equal(findPassage(k.ctx, [k.ids.e2223], ''), null);
  // Whitespace, case and accent differences do not matter.
  const loose = findPassage(k.ctx, [k.ids.e2223], 'DETERMINARE   il dominio di definizione dom f,\n eventuali PROPRIETA di simmetria, i limiti agli estremi di dom f');
  assert.equal(loose?.idx, 1);
  // Highlight renders on the located page.
  const png = await renderPageImage(k.ctx, k.ids.e2223, 1, { highlight: refs[1].cited_text });
  assert.equal(png[1], 0x50);
  // Search finds the page with the answer on top.
  const hits = searchPages(k.ctx, k.projectId, 'dominio radice');
  assert.equal(hits[0].idx, 2);
});

test('real quiz PDF: 521 pages extract in well under a minute and split into simulazioni', { skip: !haveSources, timeout: 120_000 }, async () => {
  const k = await realCtx({ quiz: { path: 'ESERCIZI/quiz Paola Suria.pdf', role: 'exercises' } });
  const t0 = Date.now();
  const out = await extractResource(k.ctx, k.ids.quiz, signal());
  const ms = Date.now() - t0;
  console.log(`quiz extraction: ${out.pages} pages in ${ms} ms (${out.garbled} garbled or empty)`);
  assert.equal(out.pages, 521);
  assert.ok(ms < 30_000, `took ${ms} ms`);
  const q = segmentQuestions(k.ctx, k.ids.quiz);
  assert.ok(q.length > 600, String(q.length));
  assert.ok(q.every((x) => x.kind === 'exercise' && /^Simulazione|^Test/.test(x.examGroup!)));
  const first = q.find((x) => x.examGroup === 'Simulazione 1' && x.number === '1')!;
  assert.match(first.statement, /derivata della funzione/);
  assert.equal(first.solution, 'Risposta corretta: e');
  assert.equal(q.filter((x) => x.examGroup === 'Simulazione 1').length, 20, 'repeated copy of the block is folded in');
  // Aborting a long extraction stops the worker promptly.
  const ac = new AbortController();
  const started = Date.now();
  const p = extractResource(k.ctx, k.ids.quiz, ac.signal);
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - started < 3000);
});
