import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AlignmentFinding } from '@smartbuilder/domain';
import { insertReport, saveHuman } from '../repo/index.ts';
import { projectBody, projectWithOutline, installFakes, startApp, type TestApp } from './testkit.ts';

let t: TestApp;
let fakes: ReturnType<typeof installFakes>;
before(async () => { t = await startApp(); fakes = installFakes(); });
after(async () => { fakes.restore(); await t.close(); });

const newProject = async (slug: string) => (await t.req('POST', '/api/projects', projectBody(slug))).body.id as string;
const items = [{ key: 'limiti', title: 'Limiti', details: 'Limiti di funzioni e successioni', proofs: [] }, { key: 'derivate', title: 'Derivate', details: '', proofs: ['Teorema di Fermat'] }];
const fmt = { written: true, oral: false, proofs: 'some', summary: 'Scritto.' };

describe('course program', () => {
  it('is null until saved; saving text starts a program run and marks the program as being read', async () => {
    const id = await newProject('prog-1');
    const none = await t.req('GET', `/api/projects/${id}/program`);
    assert.equal(none.status, 200);
    assert.equal(none.body, null);

    const before = fakes.calls.startRun.length;
    const res = await t.req('PUT', `/api/projects/${id}/program`, { text: 'Programma: limiti.', url: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.program.status, 'parsing');
    assert.equal(res.body.program.text, 'Programma: limiti.');
    assert.equal(res.body.run.kind, 'program');
    assert.equal(fakes.calls.startRun.length, before + 1);
    assert.equal(fakes.calls.startRun.at(-1)!.kind, 'program');
    assert.equal((await t.req('GET', `/api/projects/${id}/program`)).body.status, 'parsing');

    const url = await t.req('PUT', `/api/projects/${id}/program`, { text: '', url: 'https://didattica.polito.it/guide' });
    assert.equal(url.status, 200);
    assert.equal(url.body.program.url, 'https://didattica.polito.it/guide');
  });

  it('refuses a new program or edited items while a reading runs', async () => {
    const id = await newProject('prog-busy');
    assert.equal((await t.req('PUT', `/api/projects/${id}/program`, { text: 'Programma: limiti.', url: null })).status, 200);
    t.ctx.db.run(`INSERT INTO runs (id, project_id, kind, status, created_at) VALUES ('busy-run', ?, 'program', 'running', ?)`, id, new Date().toISOString());
    const again = await t.req('PUT', `/api/projects/${id}/program`, { text: 'Programma: derivate.', url: null });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'program_running');
    assert.equal((await t.req('GET', `/api/projects/${id}/program`)).body.text, 'Programma: limiti.', 'the new text is not saved');
    assert.equal((await t.req('PUT', `/api/projects/${id}/program/items`, { items, examFormat: fmt })).status, 409);
    t.ctx.db.run(`UPDATE runs SET status = 'cancelling' WHERE id = 'busy-run'`);
    assert.equal((await t.req('PUT', `/api/projects/${id}/program/items`, { items, examFormat: fmt })).status, 409, 'a cancelling reading still counts');
    t.ctx.db.run(`UPDATE runs SET status = 'cancelled' WHERE id = 'busy-run'`);
    assert.equal((await t.req('PUT', `/api/projects/${id}/program/items`, { items, examFormat: fmt })).status, 200);
  });

  it('refuses an empty program, a bad address, and an unknown book', async () => {
    const id = await newProject('prog-2');
    const empty = await t.req('PUT', `/api/projects/${id}/program`, { text: '  ', url: null });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.error.action);
    assert.equal((await t.req('PUT', `/api/projects/${id}/program`, { text: '', url: 'not a url' })).status, 400);
    assert.equal((await t.req('PUT', '/api/projects/nope/program', { text: 'x', url: null })).status, 404);
    assert.equal((await t.req('GET', `/api/projects/${id}/program`)).body, null, 'nothing was saved');
  });

  it('a run that cannot start leaves a failed status, not a program stuck on reading', async () => {
    const id = await newProject('prog-3');
    const restore = installFakes({ startRun: () => { throw new Error('queue is down'); } });
    try {
      const res = await t.req('PUT', `/api/projects/${id}/program`, { text: 'x', url: null });
      assert.equal(res.status, 500);
    } finally { restore.restore(); }
    const p = (await t.req('GET', `/api/projects/${id}/program`)).body;
    assert.deepEqual([p.status, p.error], ['failed', 'queue is down']);
  });

  it('saves edited items and exam format, rejects duplicate keys and bad keys, and deletes', async () => {
    const id = await newProject('prog-4');
    const saved = await t.req('PUT', `/api/projects/${id}/program/items`, { items, examFormat: fmt });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'ready');
    assert.deepEqual(saved.body.items.map((i: { key: string }) => i.key), ['limiti', 'derivate']);
    assert.deepEqual(saved.body.examFormat, fmt);

    // Editing keeps the text that was pasted.
    await t.req('PUT', `/api/projects/${id}/program`, { text: 'Testo incollato', url: null });
    const again = await t.req('PUT', `/api/projects/${id}/program/items`, { items: [items[0]], examFormat: { ...fmt, oral: true } });
    assert.equal(again.body.text, 'Testo incollato');
    assert.equal(again.body.items.length, 1);
    assert.equal(again.body.examFormat.oral, true);

    const dup = await t.req('PUT', `/api/projects/${id}/program/items`, { items: [items[0], { ...items[1], key: 'limiti' }], examFormat: fmt });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error.message, /key "limiti"/);
    assert.equal((await t.req('PUT', `/api/projects/${id}/program/items`, { items: [{ ...items[0], key: 'Not Kebab' }], examFormat: fmt })).status, 400);
    assert.equal((await t.req('PUT', `/api/projects/${id}/program/items`, { items: [{ ...items[0], title: '' }], examFormat: fmt })).status, 400);
    assert.equal((await t.req('GET', `/api/projects/${id}/program`)).body.items.length, 1, 'a refused save changes nothing');

    assert.deepEqual((await t.req('DELETE', `/api/projects/${id}/program`)).body, { ok: true });
    assert.equal((await t.req('GET', `/api/projects/${id}/program`)).body, null);
  });
});

describe('alignment', () => {
  const missing: AlignmentFinding = { kind: 'missing', item: 'limiti', message: 'm', suggested: { chapterId: 'c1', afterSectionId: 's2', title: 'Limiti', objectives: ['o'], depth: 'standard' } };
  const order: AlignmentFinding = { kind: 'order', nodeId: 's1', message: 'later' };

  async function book(slug: string) {
    const { projectId, outlineRevId } = await projectWithOutline(t, slug);
    await t.req('PUT', `/api/projects/${projectId}/program/items`, { items, examFormat: fmt });
    return { projectId, outlineRevId };
  }
  const report = (projectId: string, outlineRevId: string, findings: AlignmentFinding[]) => insertReport(t.ctx, { projectId, outlineRevId, coverage: [], findings, model: 'm' });

  it('is null before any check; a check needs a program, an approved outline and some text', async () => {
    const id = await newProject('align-1');
    assert.equal((await t.req('GET', `/api/projects/${id}/alignment`)).body, null);
    const noProgram = await t.req('POST', `/api/projects/${id}/alignment/check`);
    assert.equal(noProgram.status, 409);
    assert.equal(noProgram.body.error.code, 'no_program');
    assert.ok(noProgram.body.error.action);

    const { projectId } = await book('align-2');
    const noText = await t.req('POST', `/api/projects/${projectId}/alignment/check`);
    assert.equal(noText.body.error.code, 'nothing_written');
    saveHuman(t.ctx, projectId, 's1', 'Testo.', null);
    const before = fakes.calls.startRun.length;
    const ok = await t.req('POST', `/api/projects/${projectId}/alignment/check`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.kind, 'align');
    assert.equal(fakes.calls.startRun.length, before + 1);
    assert.deepEqual(fakes.calls.startRun.at(-1)!.scope, undefined);
  });

  it('returns the latest report', async () => {
    const { projectId, outlineRevId } = await book('align-3');
    report(projectId, outlineRevId, [order]);
    const newest = report(projectId, outlineRevId, [missing]);
    const got = (await t.req('GET', `/api/projects/${projectId}/alignment`)).body;
    assert.equal(got.id, newest.id);
    assert.equal(got.findings[0].kind, 'missing');
    assert.equal(got.appliedAt, null);
  });

  it('applies a report: forwards the chosen findings; refuses a stale one, one applied before, bad indexes, and order-only choices', async () => {
    const { projectId, outlineRevId } = await book('align-4');
    const r = report(projectId, outlineRevId, [order, missing]);

    assert.equal((await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: 'nope' })).status, 404);
    const bad = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: r.id, findings: [5] });
    assert.equal(bad.status, 400);
    const onlyOrder = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: r.id, findings: [0] });
    assert.equal(onlyOrder.status, 400);
    assert.equal(onlyOrder.body.error.code, 'nothing_to_apply');
    assert.match(onlyOrder.body.error.action, /Outline tab/);

    const before = fakes.calls.startRun.length;
    const ok = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: r.id, findings: [1] });
    assert.equal(ok.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1)!.scope, { align: { reportId: r.id, findings: [1] } });
    assert.equal(fakes.calls.startRun.length, before + 1);
    const all = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: r.id });
    assert.deepEqual(fakes.calls.startRun.at(-1)!.scope, { align: { reportId: r.id, findings: [] } });
    assert.equal(all.status, 200);

    // The outline moves on: the report is stale.
    const rev = (await t.req('PUT', `/api/projects/${projectId}/outline`, { outline: { chapters: [{ id: 'c1', slug: 'limiti', title: 'Limiti', sections: [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }] }] }, baseRevId: outlineRevId })).body;
    await t.req('POST', `/api/projects/${projectId}/outline/approve`, { revId: rev.id });
    const stale = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: r.id });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'report_stale');
    assert.match(stale.body.error.action, /Check alignment again/);

    // A report that was applied cannot be applied twice.
    const fresh = report(projectId, rev.id, [missing]);
    t.ctx.db.run(`UPDATE alignment_reports SET applied_at = 'now', applied = '["x"]' WHERE id = ?`, fresh.id);
    const twice = await t.req('POST', `/api/projects/${projectId}/alignment/apply`, { reportId: fresh.id });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'report_applied');
    assert.deepEqual((await t.req('GET', `/api/projects/${projectId}/alignment`)).body.applied, ['x']);
  });
});
