// Outside research: scripted model answers, pages served by a stub, a real temp database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { json, newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject, usageOf } from '../llm/testkit.ts';
import type { TaskContext } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { pageText, researchDeps, sectionResearch } from './research.ts';
import { startRun } from './runs.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';
const fetchPage = researchDeps.fetchPage;
const pages: Record<string, string> = {
  'https://example.edu/clausius': 'Per un ciclo qualsiasi vale la disuguaglianza di Clausius: l\'integrale di dQ/T è minore o uguale a zero.',
  'https://example.org/entropia': 'Una pagina che parla di altro.',
};

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
  // Runs are only planned here; the queue does not execute them.
  (ctx.queue as unknown as { wake(): void }).wake = () => undefined;
  ctx.db.run(`UPDATE projects SET options = ? WHERE id = ?`, JSON.stringify({ outsideMaterial: true }), P);
  const outline = { chapters: [{ id: 'c1', slug: 'termo', title: 'Termodinamica', objectives: [], prerequisites: [], sections: [{ id: 's1', title: 'Entropia', objectives: ['Enunciare la disuguaglianza di Clausius'], topicIds: [], depth: 'standard', subsections: [] }] }], exclusions: [], notation: '' };
  const rev = newId();
  ctx.db.insert('outline_revisions', { id: rev, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', rev, P);
  researchDeps.fetchPage = async (url) => {
    if (!(url in pages)) throw new Error('404');
    return { url, title: `Titolo di ${url}`, text: pages[url] };
  };
});
afterEach(() => {
  researchDeps.fetchPage = fetchPage;
  setFunnel(null);
  kit.cleanup();
});

function seedSection(markdown: string, citations: Record<string, string[]> = {}) {
  const id = newId();
  ctx.db.insert('content_revisions', { id, project_id: P, node_id: 's1', kind: 'section', markdown, origin: 'ai', model: 'm', parent_rev_id: null, status: 'current', citations, created_at: now() });
  ctx.db.insert('evidence_packets', { id: newId(), project_id: P, node_id: 's1', provider: 'local', query: 'q', answer: '', notes: [{ id: 'n1', quote: 'q', resourceId: 'r1', page: 0, verified: true, claim: '' }], created_at: now() });
  return id;
}

function task(): TaskContext {
  const runId = newId();
  ctx.db.insert('runs', { id: runId, project_id: P, kind: 'research', status: 'running', snapshot: {}, created_at: now() });
  const id = newId();
  ctx.db.insert('tasks', { id, run_id: runId, project_id: P, kind: 'section.research', label: 'r', key: `research:${id}`, input: { nodeId: 's1' }, state: 'running', pool: 'research', attempts: 1, max_attempts: 2, created_at: now() });
  return {
    task: { id, runId, projectId: P, kind: 'section.research', key: `research:${id}`, label: 'r', input: { nodeId: 's1' }, attempts: 1 }, signal: new AbortController().signal, deps: {},
    enqueue: () => [], progress: () => undefined, setProvider: () => undefined,
  };
}

const additions = (list: unknown[]) => () => ({ structured: { additions: list } as never, text: '{}', usage: usageOf(10, 10) });

test('a verified addition becomes a proposal after its block, citing a web note; an unverified one is dropped', async () => {
  const head = seedSection('Primo paragrafo.\n\nSecondo paragrafo.', { 1: ['n1'] });
  fake.next(additions([
    { afterBlock: 1, markdown: 'Per ogni ciclo vale $\\oint \\frac{\\delta Q}{T} \\le 0$.', why: 'Manca la disuguaglianza di Clausius', sources: [{ url: 'https://example.edu/clausius', title: 'Clausius', quote: "l'integrale di dQ/T è minore o uguale a zero" }] },
    { afterBlock: 2, markdown: 'Una frase inventata.', why: 'x', sources: [{ url: 'https://example.org/entropia', title: 'E', quote: 'questa frase non è sulla pagina' }] },
  ]));
  const r = await sectionResearch(ctx, task());
  assert.equal(r.proposed, 1);
  assert.match(String(r.dropped), /quote not found/);

  const call = fake.calls[0];
  assert.equal(call.selection.access, 'supervised');
  // The folder's Claude settings take every local tool away before the approval callback is even asked.
  const settings = JSON.parse(readFileSync(join(call.selection.cwd, '.claude', 'settings.json'), 'utf8'));
  assert.ok(['Bash', 'Read', 'Write', 'mcp__*'].every((tool) => settings.permissions.deny.includes(tool)));
  assert.equal(await call.onApproval!({ id: 'a', tool: 'WebSearch', input: {} }), 'allow');
  assert.equal(await call.onApproval!({ id: 'b', tool: 'Bash', input: {} }), 'deny');

  const current = ctx.db.get<{ id: string }>(`SELECT id FROM content_revisions WHERE node_id = 's1' AND status = 'current'`)!;
  assert.equal(current.id, head, 'the current text is unchanged');
  const proposal = ctx.db.get<{ markdown: string; citations: string }>(`SELECT markdown, citations FROM content_revisions WHERE node_id = 's1' AND status = 'proposal'`)!;
  assert.deepEqual(proposal.markdown.split('\n\n').map((b) => b.slice(0, 12)), ['Primo paragr', 'Per ogni cic', 'Secondo para']);
  assert.deepEqual(json(proposal.citations, {}), { 1: ['w1'], 2: ['n1'] });
  const notes = json<{ id: string; url?: string; verified: boolean }[]>(ctx.db.get<{ notes: string }>(`SELECT notes FROM evidence_packets WHERE node_id = 's1'`)!.notes, []);
  assert.deepEqual(notes.map((n) => [n.id, n.url ?? null]), [['n1', null], ['w1', 'https://example.edu/clausius']]);
});

test('no verified addition: no proposal and no new notes', async () => {
  seedSection('Primo paragrafo.');
  fake.next(additions([{ afterBlock: 1, markdown: 'Testo.', why: 'x', sources: [{ url: 'https://example.invalid/x', title: 'x', quote: 'qualcosa di lungo abbastanza' }] }]));
  const r = await sectionResearch(ctx, task());
  assert.equal(r.proposed, 0);
  assert.equal(ctx.db.get(`SELECT 1 FROM content_revisions WHERE status = 'proposal'`), undefined);
});

test('research runs only when outside material is on, and only with a route that can search', async () => {
  seedSection('Primo paragrafo.');
  assert.equal(startRun(ctx, P, 'research', { nodeIds: ['s1'] }).kind, 'research');
  ctx.db.run(`UPDATE projects SET options = '{}' WHERE id = ?`, P);
  assert.throws(() => startRun(ctx, P, 'research', { nodeIds: ['s1'] }), /Outside material is off/);

  for (const provider of ['antigravity', 'codex']) {
    ctx.saveSettings({ routes: { ...DEFAULT_ROUTES, research: { primary: { provider, model: 'g' } } } });
    await assert.rejects(sectionResearch(ctx, task()), /cannot search the web/);
  }
});

test('an addition of several blocks cites the pages on each, and the blocks after it keep their citations', async () => {
  seedSection('Primo.\n\nSecondo.', { 1: ['n1'] });
  fake.next(additions([{ afterBlock: 1, markdown: 'Vale la disuguaglianza:\n\n$$\\oint \\frac{\\delta Q}{T} \\le 0$$', why: 'w', sources: [{ url: 'https://example.edu/clausius', title: 'C', quote: "l'integrale di dQ/T è minore o uguale a zero" }] }]));
  await sectionResearch(ctx, task());
  const p = ctx.db.get<{ markdown: string; citations: string }>(`SELECT markdown, citations FROM content_revisions WHERE status = 'proposal'`)!;
  assert.equal(p.markdown.split('\n\n').length, 4);
  assert.deepEqual(json(p.citations, {}), { 1: ['w1'], 2: ['w1'], 3: ['n1'] });
});

test('note ids are given at commit from the packet as it is then: an earlier w1 is not reused, dropped additions use none', async () => {
  seedSection('Primo.');
  const packet = ctx.db.get<{ id: string; notes: string }>(`SELECT id, notes FROM evidence_packets WHERE node_id = 's1'`)!;
  ctx.db.run('UPDATE evidence_packets SET notes = ? WHERE id = ?', JSON.stringify([...json<unknown[]>(packet.notes, []), { id: 'w1', quote: 'x', resourceId: null, page: null, verified: true, claim: '', url: 'https://old.example' }]), packet.id);
  fake.next(additions([
    { afterBlock: 1, markdown: 'Scartata.', why: 'a', sources: [{ url: 'https://example.org/entropia', title: 'E', quote: 'questa frase non è sulla pagina' }] },
    { afterBlock: 1, markdown: 'Tenuta.', why: 'b', sources: [{ url: 'https://example.edu/clausius', title: 'C', quote: "l'integrale di dQ/T è minore o uguale a zero" }] },
  ]));
  await sectionResearch(ctx, task());
  const ids = json<{ id: string }[]>(ctx.db.get<{ notes: string }>(`SELECT notes FROM evidence_packets WHERE id = ?`, packet.id)!.notes, []).map((n) => n.id);
  assert.deepEqual(ids, ['n1', 'w1', 'w2']);
  assert.deepEqual(json(ctx.db.get<{ citations: string }>(`SELECT citations FROM content_revisions WHERE status = 'proposal'`)!.citations, {}), { 1: ['w2'] });
});

test('page text is read in linear time, even from markup crafted to slow regexes down', () => {
  const hostile = '<script>'.repeat(375_000) + '<title>T</title><p>Testo &egrave; qui</p>';
  const started = Date.now();
  const page = pageText('text/html', hostile);
  assert.ok(Date.now() - started < 1000, 'a 3 MB page takes under a second');
  assert.equal(page.title, 'T');
  assert.match(page.text, /Testo è qui/);
});
