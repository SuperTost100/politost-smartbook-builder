import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { EvidenceNote } from '@smartbuilder/domain';
import { makeCtx, seedPage, seedProject, seedResource } from '../llm/testkit.ts';
import { TaskError } from '../queue/queue.ts';
import { claimsByCitation, shiftCitations } from './citations.ts';
import { setEvidenceDeps, type EvidenceDeps } from './deps.ts';
import { gatherEvidence, localEvidenceMeta, notebookStatus, syncNotebook, transcribePage } from './index.ts';
import { resetNlmCache, setNlmRunner } from './nlm.ts';
import { resetSyncState } from './sync.ts';
import { FakeNlm } from './testnlm.ts';
import { clipQuote, normalizeForMatch, quoteInText } from './verify.ts';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../fixtures/notebooklm/query-exam-2023.json'), 'utf8')) as {
  answer: string;
  references: { source_id: string; citation_number: number; cited_text: string }[];
};

let kit: ReturnType<typeof makeCtx>;
let nlm: FakeNlm;

beforeEach(() => {
  resetSyncState();
  kit = makeCtx();
  nlm = new FakeNlm();
  setNlmRunner(nlm.runner);
  seedProject(kit.ctx);
});
afterEach(() => {
  setNlmRunner(null);
  setEvidenceDeps();
  kit.cleanup();
});

describe('citation claims', () => {
  test('claims from the NotebookLM fixture answer', () => {
    const valid = new Set(fixture.references.map((r) => r.citation_number));
    const claims = claimsByCitation(fixture.answer, valid);
    assert.deepEqual([...claims.keys()].sort(), [1, 2, 3]);
    assert.match(claims.get(1)!, /Si consideri la funzione/);
    assert.doesNotMatch(claims.get(1)!, /[*>]|\[1\]/);
    assert.match(claims.get(2)!, /Determinare il dominio di definizione/);
    assert.match(claims.get(3)!, /Le condizioni di esistenza richiedono/);
    assert.match(claims.get(3)!, /Condizione di esistenza|Il termine/, 'the list items citing [3] are included');
    for (const c of claims.values()) assert.ok(c.length <= 320);
  });

  test('sentences, grouped markers and intervals that are not citations', () => {
    const answer = 'Il limite vale zero [1]. Poi la serie converge [2, 3]. Sull\'intervallo [3, 5] la funzione cresce.';
    const claims = claimsByCitation(answer, new Set([1, 2, 3]));
    assert.equal(claims.get(1), 'Il limite vale zero');
    assert.equal(claims.get(2), 'Poi la serie converge');
    assert.equal(claims.get(3), 'Poi la serie converge');
    assert.equal(claims.size, 3);
  });

  test('shiftCitations renumbers markers', () => {
    assert.equal(shiftCitations('A [1]. B [2, 3].', 10), 'A [11]. B [12, 13].');
    assert.equal(shiftCitations('A [1].', 0), 'A [1].');
  });
});

describe('quote verification', () => {
  test('normalization ignores whitespace, case, quotes and hyphenation', () => {
    assert.equal(normalizeForMatch('Le  condizioni\ndi esi-\nstenza “ok”'), normalizeForMatch('le condizioni di esistenza "ok"'));
    assert.ok(quoteInText('Il dominio della funzione è\n(-∞,-3] ∪ [0,∞)', 'il dominio della funzione è (-∞,-3] ∪ [0,∞)'));
  });
  test('fabricated, too short and out-of-order quotes fail; ellipsis skips the middle', () => {
    const page = 'Teorema di Weierstrass. Sia f continua su un intervallo chiuso e limitato. Allora f ha massimo e minimo.';
    assert.equal(quoteInText(page, 'Sia f continua su un intervallo aperto'), false);
    assert.equal(quoteInText(page, 'f ha'), false);
    assert.ok(quoteInText(page, 'Sia f continua ... ha massimo e minimo'));
    assert.equal(quoteInText(page, 'ha massimo e minimo ... Sia f continua'), false);
  });
  test('clipQuote keeps a verbatim prefix', () => {
    const long = 'parola '.repeat(100);
    const clipped = clipQuote(long, 400);
    assert.ok(clipped.length <= 400);
    assert.ok(long.startsWith(clipped));
  });
});

describe('notebookStatus', () => {
  test('signed in: account and usage windows', async () => {
    const s = await notebookStatus({ fresh: true });
    assert.equal(s.installed, true);
    assert.equal(s.signedIn, true);
    assert.equal(s.account, 'me@example.com');
    assert.deepEqual(s.usage.map((u) => u.window), ['rolling']);
    assert.match(s.usage[0].remaining, /99\.0% left/);
    assert.equal(s.error, null);
  });
  test('expired cookies: not signed in with the CLI message', async () => {
    nlm.signedIn = false;
    const s = await notebookStatus({ fresh: true });
    assert.equal(s.signedIn, false);
    assert.equal(s.installed, true);
    assert.match(s.error ?? '', /expired/);
  });
  test('missing binary', async () => {
    const { NlmMissingError } = await import('./nlm.ts');
    setNlmRunner(async () => { throw new NlmMissingError(); });
    const s = await notebookStatus({ fresh: true });
    assert.equal(s.installed, false);
    assert.equal(s.signedIn, false);
  });
  test('results are cached for a minute', async () => {
    await notebookStatus({ fresh: true });
    const before = nlm.calls.length;
    await notebookStatus();
    assert.equal(nlm.calls.length, before);
    resetNlmCache();
  });
});

function seedFiles() {
  const dir = join(kit.ctx.config.dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.pdf'), '%PDF-a');
  writeFileSync(join(dir, 'b.pdf'), '%PDF-b');
  seedResource(kit.ctx, { id: 'ra', filename: 'Teoria.pdf', sha256: 'aaaaaaaa'.padEnd(64, '1'), path: join(dir, 'a.pdf') });
  seedResource(kit.ctx, { id: 'rb', filename: 'Esami.pdf', sha256: 'bbbbbbbb'.padEnd(64, '2'), path: join(dir, 'b.pdf'), role: 'exams' });
  seedResource(kit.ctx, { id: 'rm', kind: 'md', filename: 'Note.md', sha256: 'cccccccc'.padEnd(64, '3'), path: join(dir, 'missing.md') });
  seedPage(kit.ctx, 'rm', 0, '# Note\nTesto delle note.');
}

describe('syncNotebook', () => {
  test('creates one notebook, uploads each resource once with a sha-tagged title, then skips', async () => {
    seedFiles();
    const first = await syncNotebook(kit.ctx, 'p1');
    assert.equal(first.uploaded, 3);
    assert.equal(first.skipped, 0);
    assert.equal(nlm.count('notebook', 'create'), 1);
    const nb = [...nlm.notebooks.values()][0];
    assert.equal(nb.title, 'Analisi 1 · Smart Builder');
    assert.deepEqual(nb.sources.map((s) => s.title).sort(), ['Esami.pdf [bbbbbbbb]', 'Note.md [cccccccc]', 'Teoria.pdf [aaaaaaaa]']);
    const rows = kit.ctx.db.all<{ status: string; remote_source_id: string }>('SELECT * FROM notebook_sources');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === 'ready' && r.remote_source_id));
    assert.equal(first.notebookId, 'nb1');
    // Markdown resources go up as a file built from page text, not as a command-line argument.
    const mdAdd = nlm.calls.find((c) => c.includes('Note.md [cccccccc]'))!;
    assert.ok(mdAdd.includes('--file'));
    assert.ok(!mdAdd.includes('--text'));

    nlm.calls.length = 0;
    const second = await syncNotebook(kit.ctx, 'p1');
    assert.deepEqual([second.uploaded, second.skipped], [0, 3]);
    assert.equal(nlm.count('source', 'add'), 0);
  });

  test('crash after the remote upload: the retry finds the source by title and does not upload again', async () => {
    seedFiles();
    nlm.crashAfterStore = true;
    await assert.rejects(syncNotebook(kit.ctx, 'p1'), /process died/);
    const stuck = kit.ctx.db.all<{ resource_id: string; status: string; remote_source_id: string | null }>('SELECT * FROM notebook_sources');
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].status, 'uploading');
    assert.equal(stuck[0].remote_source_id, null);
    const remoteCount = () => [...nlm.notebooks.values()][0].sources.length;
    assert.equal(remoteCount(), 1);

    nlm.crashAfterStore = false;
    const out = await syncNotebook(kit.ctx, 'p1');
    assert.equal(out.uploaded, 2);
    assert.equal(out.skipped, 1, 'the recovered source counts as already uploaded');
    assert.equal(remoteCount(), 3, 'no duplicate of the source that survived the crash');
    const titles = [...nlm.notebooks.values()][0].sources.map((s) => s.title);
    assert.equal(new Set(titles).size, 3);
    assert.ok(kit.ctx.db.all<{ status: string }>('SELECT status FROM notebook_sources').every((r) => r.status === 'ready'));
  });

  test('crash before the remote call: the retry uploads', async () => {
    seedFiles();
    kit.ctx.db.insert('notebooks', { id: 'n-local', project_id: 'p1', remote_id: 'nbX', title: 'x', created_at: 'now' });
    nlm.notebooks.set('nbX', { title: 'x', sources: [{ id: 'other', title: 'Unrelated.pdf' }] });
    kit.ctx.db.insert('notebook_sources', { resource_id: 'ra', notebook_id: 'n-local', remote_source_id: null, sha256: 'aaaaaaaa'.padEnd(64, '1'), status: 'uploading' });
    const out = await syncNotebook(kit.ctx, 'p1');
    assert.equal(out.uploaded, 3);
    assert.equal(nlm.notebooks.get('nbX')!.sources.filter((s) => s.title === 'Teoria.pdf [aaaaaaaa]').length, 1);
  });

  test('a full notebook spills into an additional one and each source remembers where it lives', async () => {
    seedFiles();
    nlm.sourceLimit = 2;
    const out = await syncNotebook(kit.ctx, 'p1');
    assert.equal(out.uploaded, 3);
    const books = kit.ctx.db.all<{ id: string; remote_id: string; title: string }>('SELECT * FROM notebooks ORDER BY created_at, rowid');
    assert.equal(books.length, 2);
    assert.match(books[1].title, /Smart Builder \(2\)$/);
    const where = kit.ctx.db.all<{ resource_id: string; remote_id: string }>('SELECT s.resource_id, n.remote_id FROM notebook_sources s JOIN notebooks n ON n.id = s.notebook_id');
    assert.equal(where.length, 3);
    assert.equal(new Set(where.map((w) => w.remote_id)).size, 2);
    for (const w of where) assert.ok(nlm.notebooks.get(w.remote_id)!.sources.length <= 2);
  });

  test('concurrent syncs for one project do not upload twice', async () => {
    seedFiles();
    await Promise.all([syncNotebook(kit.ctx, 'p1'), syncNotebook(kit.ctx, 'p1')]);
    assert.equal(nlm.count('source', 'add'), 3);
    assert.equal(nlm.count('notebook', 'create'), 1);
  });

  test('NotebookLM auth failure surfaces as TaskError(auth) with the login action', async () => {
    seedFiles();
    nlm.runner = async (args) => (args[0] === 'usage' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Error: Cookies have expired. Run nlm login.' });
    setNlmRunner(nlm.runner);
    await assert.rejects(syncNotebook(kit.ctx, 'p1'), (e: unknown) => e instanceof TaskError && e.kind === 'auth' && /nlm login --storage file/.test(e.action ?? ''));
  });
});

function fakeRunRole(out: unknown, spy?: { calls: unknown[] }): EvidenceDeps['runRole'] {
  return (async (_ctx: unknown, opts: unknown) => {
    spy?.calls.push(opts);
    return { text: JSON.stringify(out), data: out, route: { provider: 'codex', model: 'gpt-6-luna' }, usage: { inputTokens: 1, outputTokens: 1 } };
  }) as EvidenceDeps['runRole'];
}

describe('gatherEvidence (local reader)', () => {
  const page0 = 'Teorema di Weierstrass. Sia f continua su un intervallo chiuso e limitato. Allora f ha massimo e minimo.';
  const page1 = 'Teorema di Fermat. Se x0 è un punto di massimo locale interno e f è derivabile in x0, allora f\'(x0) = 0.';

  beforeEach(() => {
    seedResource(kit.ctx, { id: 'ra', filename: 'Teoria.pdf' });
    seedPage(kit.ctx, 'ra', 0, page0);
    seedPage(kit.ctx, 'ra', 1, page1);
    seedPage(kit.ctx, 'ra', 2, 'Pagina senza interesse.');
    kit.ctx.saveSettings({ evidenceMode: 'local' });
  });

  test('keeps verified quotes, drops fabricated ones and records the count', async () => {
    const spy = { calls: [] as { prompt: string; role: string }[] };
    setEvidenceDeps({
      searchPages: () => [{ resourceId: 'ra', idx: 0, snippet: '', rank: 1 }],
      runRole: fakeRunRole({
        notes: [
          { page: 'P1', quote: 'Sia f continua su un intervallo chiuso e limitato', claim: 'Ipotesi di Weierstrass' },
          { page: 'P1', quote: 'Sia f continua su un intervallo aperto e illimitato', claim: 'Inventata' },
          { page: 'P1', quote: "Se x0 è un punto di massimo locale interno e f è derivabile in x0, allora f'(x0) = 0.", claim: 'Fermat, pagina etichettata male' },
          { page: 'P9', quote: 'Testo che non esiste da nessuna parte', claim: 'Inventata 2' },
        ],
        answer: 'Weierstrass richiede continuità su un compatto [P1].',
      }, spy as never),
    });
    const packet = await gatherEvidence(kit.ctx, { projectId: 'p1', nodeId: 'sec1', query: 'Teorema di Weierstrass', resourceIds: ['ra'], pageHints: [{ resourceId: 'ra', pageFrom: 1, pageTo: 1 }] });
    assert.equal(packet.provider, 'local');
    assert.equal(packet.notes.length, 2);
    const [a, b] = packet.notes as EvidenceNote[];
    assert.deepEqual([a.id, a.page, a.verified, a.resourceId], ['n1', 0, true, 'ra']);
    assert.equal(a.claim, 'Ipotesi di Weierstrass');
    assert.deepEqual([b.id, b.page, b.verified], ['n2', 1, true], 'a mislabeled page is corrected when the quote is verbatim elsewhere');
    assert.ok(!packet.notes.some((n) => /aperto|esiste/.test(n.quote)));
    assert.deepEqual(localEvidenceMeta(packet.answer), { kept: 2, dropped: 2, pages: 2 });
    const prompt = spy.calls[0].prompt;
    assert.match(prompt, /\[P1\] Teoria\.pdf/);
    assert.match(prompt, /\[P2\]/);
    assert.doesNotMatch(prompt, /Pagina senza interesse/);
    assert.equal(spy.calls[0].role, 'evidence');
    const stored = kit.ctx.db.get<{ notes: string; provider: string }>('SELECT * FROM evidence_packets WHERE id = ?', packet.id)!;
    assert.equal(stored.provider, 'local');
    assert.equal(JSON.parse(stored.notes).length, 2);
  });

  test('verifies against the transcript when a page has one, and reuses the packet unless forced', async () => {
    kit.ctx.db.run(`UPDATE pages SET transcript = ? WHERE id = 'ra-p2'`, 'Formula trascritta: $\\int_0^1 x\\,dx = \\frac{1}{2}$ come richiesto.');
    const spy = { calls: [] as unknown[] };
    setEvidenceDeps({
      searchPages: () => [{ resourceId: 'ra', idx: 2, snippet: '', rank: 1 }],
      runRole: fakeRunRole({ notes: [{ page: 'P1', quote: '$\\int_0^1 x\\,dx = \\frac{1}{2}$', claim: 'Integrale' }], answer: 'ok' }, spy),
    });
    const req = { projectId: 'p1', nodeId: 'sec2', query: 'integrale', resourceIds: [] };
    const first = await gatherEvidence(kit.ctx, req);
    assert.equal(first.notes.length, 1);
    assert.equal(first.notes[0].page, 2);
    const again = await gatherEvidence(kit.ctx, req);
    assert.equal(again.id, first.id);
    assert.equal(spy.calls.length, 1);
    const forced = await gatherEvidence(kit.ctx, req, { force: true });
    assert.notEqual(forced.id, first.id);
    assert.equal(spy.calls.length, 2);
  });
});

describe('gatherEvidence (NotebookLM)', () => {
  const sha = 'e6a6d3f5'.padEnd(64, '9');
  beforeEach(() => {
    const dir = join(kit.ctx.config.dataDir, 'files');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'esami.pdf'), '%PDF');
    seedResource(kit.ctx, { id: 'rx', filename: 'Esami scritti 2022-23.pdf', sha256: sha, path: join(dir, 'esami.pdf') });
  });

  test('queries with source ids, resolves each citation to a page and attaches the claim', async () => {
    nlm.nextSourceId = fixture.references[0].source_id;
    nlm.queryResponse = fixture;

    const lookups: { ids: string[]; text: string }[] = [];
    setEvidenceDeps({
      findPassage: (_ctx, ids, text) => {
        lookups.push({ ids, text });
        return /dom f|dominio/.test(text) && !/Esercizio 1\./.test(text) ? { resourceId: 'rx', idx: 1, score: 0.9 } : null;
      },
    });
    const packet = await gatherEvidence(kit.ctx, { projectId: 'p1', nodeId: 'sec1', query: "Come si determina il dominio?", resourceIds: ['rx'] });
    assert.equal(packet.provider, 'notebooklm');
    assert.equal(packet.answer, fixture.answer);
    const queries = nlm.calls.filter((c) => c[1] === 'query');
    assert.equal(queries.length, 1);
    const q = queries[0];
    assert.equal(q[q.indexOf('--source-ids') + 1], fixture.references[0].source_id);
    assert.ok(q.includes('--new-conversation'));
    assert.match(q[3], /^Come si determina il dominio\?/);
    assert.match(q[3], /Italian/);
    assert.match(q[3], /verbatim/);
    assert.deepEqual(packet.notes.map((n) => n.id), fixture.references.map((r) => `n${r.citation_number}`));
    const n2 = packet.notes.find((n) => n.id === 'n2')!;
    assert.deepEqual([n2.verified, n2.page, n2.resourceId], [true, 1, 'rx']);
    assert.equal(n2.quote, fixture.references[1].cited_text);
    assert.match(n2.claim, /Determinare il dominio di definizione/);
    const n1 = packet.notes.find((n) => n.id === 'n1')!;
    assert.deepEqual([n1.verified, n1.page, n1.resourceId], [false, null, 'rx'], 'unlocated passages stay unverified and keep the source');
    assert.ok(lookups[0].ids.length === 1 && lookups[0].ids[0] === 'rx', 'the cited source is searched first');
  });

  test('not signed in: falls back to the local reader', async () => {
    nlm.signedIn = false;
    seedPage(kit.ctx, 'rx', 0, 'Il dominio della funzione si determina imponendo la radice non negativa.');
    setEvidenceDeps({
      searchPages: () => [{ resourceId: 'rx', idx: 0, snippet: '', rank: 1 }],
      runRole: fakeRunRole({ notes: [{ page: 'P1', quote: 'imponendo la radice non negativa', claim: 'Metodo' }], answer: 'Imporre la radice non negativa [P1].' }),
    });
    const packet = await gatherEvidence(kit.ctx, { projectId: 'p1', nodeId: 's', query: 'dominio', resourceIds: ['rx'] });
    assert.equal(packet.provider, 'local');
    assert.equal(packet.notes.length, 1);
    assert.equal(nlm.count('notebook', 'query'), 0);
  });

  test('NotebookLM quota: falls back to the local reader', async () => {
    seedPage(kit.ctx, 'rx', 0, 'Il dominio della funzione si determina imponendo la radice non negativa.');
    const base = nlm.runner;
    setNlmRunner(async (args) => (args[1] === 'query' ? { code: 1, stdout: JSON.stringify({ status: 'error', error: 'Rate limit exceeded' }), stderr: '' } : base(args)));
    setEvidenceDeps({
      searchPages: () => [{ resourceId: 'rx', idx: 0, snippet: '', rank: 1 }],
      runRole: fakeRunRole({ notes: [], answer: 'Niente.' }),
    });
    const packet = await gatherEvidence(kit.ctx, { projectId: 'p1', nodeId: 's', query: 'dominio', resourceIds: [] });
    assert.equal(packet.provider, 'local');
  });
});

describe('transcribePage', () => {
  beforeEach(() => {
    seedResource(kit.ctx, { id: 'ra' });
    seedPage(kit.ctx, 'ra', 0, 'testo garbled ∫∫');
  });

  test('renders at scale 2, calls the vision role with the image, caches, and updates the FTS row', async () => {
    const png = Buffer.from('png-bytes');
    const renders: unknown[] = [];
    const roles: { role: string; images?: Buffer[]; system: string; projectId?: string | null }[] = [];
    setEvidenceDeps({
      renderPageImage: (async (_c: unknown, rid: string, idx: number, o: unknown) => { renders.push([rid, idx, o]); return png; }) as EvidenceDeps['renderPageImage'],
      runRole: (async (_c: unknown, opts: { role: string; images?: Buffer[]; system: string; projectId?: string | null }) => {
        roles.push(opts);
        return { text: '```markdown\nSia $f(x) = x^2$ definita su $\\mathbb{R}$.\n```', data: '', route: { provider: 'codex', model: 'gpt-6-luna' }, usage: { inputTokens: 1, outputTokens: 1 } };
      }) as EvidenceDeps['runRole'],
    });
    const page = await transcribePage(kit.ctx, 'ra', 0);
    assert.equal(page.transcript, 'Sia $f(x) = x^2$ definita su $\\mathbb{R}$.');
    assert.equal(page.transcriptModel, 'codex/gpt-6-luna');
    assert.deepEqual(renders, [['ra', 0, { scale: 2 }]]);
    assert.equal(roles[0].role, 'vision');
    assert.deepEqual(roles[0].images, [png]);
    assert.equal(roles[0].projectId, 'p1');
    assert.match(roles[0].system, /\$\.\.\.\$/);
    assert.match(roles[0].system, /illeggibile/);

    const row = kit.ctx.db.get<{ transcript_at: string; rowid: number }>('SELECT transcript_at, rowid FROM pages WHERE id = ?', 'ra-p0')!;
    assert.ok(row.transcript_at);
    const fts = kit.ctx.db.get<{ transcript: string; text: string }>('SELECT text, transcript FROM pages_fts WHERE rowid = ?', row.rowid)!;
    assert.match(fts.transcript, /definita/);
    assert.equal(fts.text, 'testo garbled ∫∫', 'native text stays searchable');
    const hit = kit.ctx.db.all('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?', 'definita');
    assert.equal(hit.length, 1);

    const again = await transcribePage(kit.ctx, 'ra', 0);
    assert.equal(again.transcript, page.transcript);
    assert.equal(renders.length, 1, 'cached');
    await transcribePage(kit.ctx, 'ra', 0, { force: true });
    assert.equal(renders.length, 2);
  });

  test('unknown page is an input error', async () => {
    await assert.rejects(transcribePage(kit.ctx, 'ra', 7), (e: unknown) => e instanceof TaskError && e.kind === 'input');
  });
});
