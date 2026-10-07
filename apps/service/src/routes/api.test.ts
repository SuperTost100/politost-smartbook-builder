import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { assertSafeSvg, insertProposal, saveHuman, usageForRun } from '../repo/index.ts';
import { newId, now } from '../db/db.ts';
import { json } from '../db/db.ts';
import { paths, resolveDataPath } from '../config.ts';
import { installFakes, multipart, projectBody, projectWithOutline, startApp, type TestApp } from './testkit.ts';

let t: TestApp;
let fakes: ReturnType<typeof installFakes>;
before(async () => { t = await startApp(); fakes = installFakes(); });
after(async () => { fakes.restore(); await t.close(); });

describe('security hooks', () => {
  it('refuses mutations without the CSRF header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('csrf'), headers: { 'content-type': 'application/json' } });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error.code, 'csrf');
  });
  it('allows reads without it', async () => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  });
});

describe('projects', () => {
  it('creates, lists with counts, patches options by merge, archives and rejects a duplicate slug', async () => {
    const created = await t.req('POST', '/api/projects', projectBody('crud'));
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.stage, 'sources');
    assert.equal(created.body.options.ide, true);

    const dup = await t.req('POST', '/api/projects', projectBody('crud'));
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already uses/);
    assert.ok(dup.body.error.action);

    const patched = await t.req('PATCH', `/api/projects/${id}`, { title: 'Nuovo titolo', options: { graphs: false } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.title, 'Nuovo titolo');
    assert.equal(patched.body.options.graphs, false);
    assert.equal(patched.body.options.ide, true, 'other options keep their value');
    assert.equal(patched.body.language, 'it', 'untouched fields keep their value');
    assert.deepEqual(patched.body.authors, ['Ada']);

    const list = await t.req('GET', '/api/projects');
    const row = list.body.find((p: { id: string }) => p.id === id);
    assert.deepEqual(row.counts, { resources: 0, sections: 0, drafted: 0, questions: 0, openIssues: 0 });
    assert.equal(row.activeRun, null);

    const archived = await t.req('POST', `/api/projects/${id}/archive`);
    assert.ok(archived.body.archivedAt);

    const bad = await t.req('POST', '/api/projects', { title: '', subject: 'x', slug: 'Bad Slug' });
    assert.equal(bad.status, 400);
    assert.equal((await t.req('GET', '/api/projects/nope')).status, 404);
  });

  it('deletes rows and folder and reports that a notebook is kept', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('doomed'));
    const nid = newId();
    t.ctx.db.insert('notebooks', { id: nid, project_id: p.id, remote_id: 'r1', title: 'nb', created_at: now() });
    const up = multipart({ role: 'theory' }, [{ name: 'file', filename: 'a.pdf', type: 'application/pdf', data: 'pdf bytes' }]);
    await t.req('POST', `/api/projects/${p.id}/resources`, up.payload, up.headers);
    const dir = paths.project(t.ctx.config, p.id);
    assert.ok(existsSync(dir));
    const res = await t.req('DELETE', `/api/projects/${p.id}`);
    assert.deepEqual(res.body, { ok: true, remoteNotebookKept: true });
    assert.ok(!existsSync(dir));
    assert.equal((await t.req('GET', `/api/projects/${p.id}`)).status, 404);
    assert.equal(t.ctx.db.get('SELECT 1 FROM resources WHERE project_id = ?', p.id), undefined);
  });
});

describe('resources', () => {
  it('stores each uploaded file, starts one prepare run, and deletes the file with the last reference', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('uploads'));
    const before = fakes.calls.startRun.length;
    const up = multipart({ role: 'exams' }, [
      { name: 'file', filename: 'one.pdf', type: 'application/pdf', data: 'one' },
      { name: 'file', filename: 'two.pdf', type: 'application/pdf', data: 'two' },
    ]);
    const res = await t.req('POST', `/api/projects/${p.id}/resources`, up.payload, up.headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].role, 'exams');
    assert.equal(fakes.calls.startRun.length, before + 1);
    assert.equal(fakes.calls.startRun.at(-1)!.kind, 'prepare');

    const path = resolveDataPath(t.ctx.config, (t.ctx.db.get<{ path: string }>('SELECT path FROM resources WHERE id = ?', res.body[0].id))!.path);
    assert.ok(existsSync(path));
    await t.req('DELETE', `/api/resources/${res.body[0].id}`);
    assert.ok(!existsSync(path));
    assert.equal((await t.req('GET', `/api/projects/${p.id}/resources`)).body.length, 1);
  });

  it('rejects unsupported types with a plain message', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('uploads-bad'));
    const up = multipart({}, [{ name: 'file', filename: 'x.exe', type: 'application/octet-stream', data: 'x' }]);
    const res = await t.req('POST', `/api/projects/${p.id}/resources`, up.payload, up.headers);
    assert.equal(res.status, 400);
    assert.match(res.body.error.action, /PDF/);
  });
});

describe('outline', () => {
  it('detects a stale base revision and approval moves the project to drafting', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('outline'));
    const outline = { chapters: [{ id: 'c1', slug: 'uno', title: 'Uno', sections: [{ id: 's1', title: 'A' }] }] };

    const first = await t.req('PUT', `/api/projects/${p.id}/outline`, { outline, baseRevId: null });
    assert.equal(first.status, 200);
    assert.equal(first.body.origin, 'human');

    const stale = await t.req('PUT', `/api/projects/${p.id}/outline`, { outline, baseRevId: null });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error.action, /Reload/);

    const second = await t.req('PUT', `/api/projects/${p.id}/outline`, { outline, baseRevId: first.body.id });
    assert.equal(second.status, 200);

    const dupIds = await t.req('PUT', `/api/projects/${p.id}/outline`, {
      outline: { chapters: [{ id: 'c1', slug: 'uno', title: 'Uno', sections: [{ id: 'c1', title: 'A' }] }] }, baseRevId: second.body.id,
    });
    assert.equal(dupIds.status, 400);

    const approved = await t.req('POST', `/api/projects/${p.id}/outline/approve`, { revId: second.body.id });
    assert.ok(approved.body.approvedAt);
    const project = (await t.req('GET', `/api/projects/${p.id}`)).body;
    assert.equal(project.outlineRevId, second.body.id);
    assert.equal(project.stage, 'drafting');
    assert.equal(project.counts.sections, 1);

    const got = (await t.req('GET', `/api/projects/${p.id}/outline`)).body;
    assert.equal(got.current.id, second.body.id);
    assert.equal(got.history.length, 2);
  });
});

describe('sections', () => {
  it('saves human edits with a revision check, lints on save and keeps history', async () => {
    const lintCalls: string[] = [];
    const r2 = installFakes({ lintSection: (md, o) => { lintCalls.push(o.sectionId); return [{ rule: 'demo', severity: 'minor', message: `len ${md.length}`, file: o.sectionId }]; } });
    try {
      const { projectId } = await projectWithOutline(t, 'sections');
      const url = `/api/projects/${projectId}/sections/s1`;

      const first = await t.req('PUT', url, { markdown: 'Primo testo', baseRevId: null });
      assert.equal(first.status, 200);
      assert.equal(first.body.current.markdown, 'Primo testo');
      assert.equal(first.body.issues.length, 1);
      assert.equal(first.body.issues[0].source, 'lint');
      assert.match(first.body.compiled, /Primo testo/);

      const stale = await t.req('PUT', url, { markdown: 'Altro', baseRevId: null });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.action, 'Reload to see the latest version, then reapply your edit.');

      const second = await t.req('PUT', url, { markdown: 'Secondo testo', baseRevId: first.body.current.id });
      assert.equal(second.status, 200);
      assert.equal(second.body.issues.length, 1, 'open lint issues are replaced, not accumulated');
      assert.equal(second.body.issues[0].message, 'len 13');
      assert.deepEqual(lintCalls, ['s1', 's1']);

      const history = (await t.req('GET', `${url}/history`)).body;
      assert.deepEqual(history.map((h: { status: string }) => h.status), ['current', 'superseded']);

      const restored = await t.req('POST', `${url}/restore`, { revId: first.body.current.id });
      assert.equal(restored.body.current.markdown, 'Primo testo');
      assert.equal(restored.body.current.origin, 'human');
      assert.notEqual(restored.body.current.id, first.body.current.id);

      const events = t.ctx.events.since(0, projectId).filter((e) => e.type === 'content.saved');
      assert.equal(events.length, 3);

      const manuscript = (await t.req('GET', `/api/projects/${projectId}/manuscript`)).body;
      assert.equal(manuscript.length, 1);
      assert.equal(manuscript[0].sections.length, 2);
      assert.equal(manuscript[0].sections[0].current.markdown, 'Primo testo');
      assert.equal((await t.req('GET', `${url.replace('s1', 'zzz')}`)).status, 404);

      const preview = (await t.req('GET', `/api/projects/${projectId}/chapters/c1/preview`)).body;
      assert.equal(preview.number, 1);
      assert.match(preview.markdown, /Primo testo/);
    } finally {
      r2.restore();
      fakes = installFakes();
    }
  });

  it('turns a late AI draft into a proposal that can be accepted or rejected', async () => {
    const { projectId } = await projectWithOutline(t, 'proposals');
    const url = `/api/projects/${projectId}/sections/s1`;
    const human = (await t.req('PUT', url, { markdown: 'Testo umano', baseRevId: null })).body.current;

    // The model started from nothing (base null), but the author has typed since: proposal.
    const late = insertProposal(t.ctx, projectId, 's1', 'Bozza AI', null, 'ai', 'm1', {});
    assert.equal(late.applied, false);
    assert.equal(late.revision.status, 'proposal');
    let view = (await t.req('GET', url)).body;
    assert.equal(view.current.id, human.id);
    assert.equal(view.proposal.markdown, 'Bozza AI');

    // The author compared the proposal with `human`; newer work saved since must not be replaced silently.
    const newer = (await t.req('PUT', url, { markdown: 'Testo umano, ancora', baseRevId: human.id })).body.current;
    const refused = await t.req('POST', `${url}/proposal`, { action: 'accept', revId: late.revision.id, headRevId: human.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.message, 'The section changed after you opened this proposal.');
    assert.equal(refused.body.error.action, 'Reload to compare the proposal with the latest text.');
    assert.equal((await t.req('GET', url)).body.current.id, newer.id, 'the newer text is still current');
    assert.equal((await t.req('GET', url)).body.proposal.id, late.revision.id, 'the proposal is still waiting');
    assert.equal((await t.req('POST', `${url}/proposal`, { action: 'accept', revId: late.revision.id })).status, 400, 'headRevId is required to accept');

    const accepted = await t.req('POST', `${url}/proposal`, { action: 'accept', revId: late.revision.id, headRevId: newer.id });
    assert.equal(accepted.status, 200);
    assert.deepEqual(t.ctx.events.since(0, projectId).filter((e) => e.type === 'proposal.decided').map((e) => e.data), [{ nodeId: 's1', revId: late.revision.id, action: 'accept' }]);
    assert.equal(accepted.body.current.markdown, 'Bozza AI');
    assert.equal(accepted.body.proposal, null);
    assert.equal(accepted.body.current.id, late.revision.id);

    const again = await t.req('POST', `${url}/proposal`, { action: 'accept', revId: late.revision.id, headRevId: late.revision.id });
    assert.equal(again.status, 409);

    // Output based on the current head applies directly.
    const direct = insertProposal(t.ctx, projectId, 's1', 'Seconda bozza', late.revision.id, 'ai', 'm1');
    assert.equal(direct.applied, true);
    assert.equal(direct.revision.status, 'current');

    // A stale one is stored as proposal and can be rejected.
    const stale = insertProposal(t.ctx, projectId, 's1', 'Terza bozza', late.revision.id, 'ai', 'm1');
    assert.equal(stale.applied, false);
    // Rejecting does not look at headRevId.
    const rejected = await t.req('POST', `${url}/proposal`, { action: 'reject', revId: stale.revision.id, headRevId: 'anything' });
    assert.equal(rejected.body.proposal, null);
    assert.deepEqual(t.ctx.events.since(0, projectId).filter((e) => e.type === 'proposal.decided').map((e) => e.data.action), ['accept', 'reject']);
    assert.equal(rejected.body.current.markdown, 'Seconda bozza');
    view = (await t.req('GET', `${url}/history`)).body;
    assert.ok(view.some((r: { status: string }) => r.status === 'rejected'));

    // saveHuman straight through the repo keeps the same check.
    assert.throws(() => saveHuman(t.ctx, projectId, 's1', 'x', 'wrong'), (e: { status?: number }) => e.status === 409);
  });

  it('starts regenerate runs with the right scope', async () => {
    const { projectId } = await projectWithOutline(t, 'regen');
    const res = await t.req('POST', `/api/projects/${projectId}/sections/s2/regenerate`, { instruction: 'più breve', selection: 'frase' });
    assert.equal(res.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId, kind: 'regenerate', scope: { nodeIds: ['s2'], instruction: 'più breve', selection: 'frase' } });
    assert.equal((await t.req('POST', `/api/projects/${projectId}/sections/nope/regenerate`, {})).status, 404);
  });
});

describe('questions and issues', () => {
  it('rejects a PATCH with a stale rev and bumps rev otherwise', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('questions'));
    const q = (await t.req('POST', `/api/projects/${p.id}/questions`, { statement: 'Calcola il limite', kind: 'exercise' })).body;
    assert.equal(q.rev, 1);
    assert.equal(q.status, 'draft');

    const ok = await t.req('PATCH', `/api/questions/${q.id}`, { rev: 1, solution: 'Vale 0', status: 'verified' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.rev, 2);
    assert.equal(ok.body.status, 'verified');

    const stale = await t.req('PATCH', `/api/questions/${q.id}`, { rev: 1, statement: 'Altro' });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error.action, /Reload/);

    const edited = await t.req('PATCH', `/api/questions/${q.id}`, { rev: 2, statement: 'Calcola il limite per x che tende a 0' });
    assert.equal(edited.body.status, 'draft', 'editing the text invalidates verification');

    const verify = await t.req('POST', `/api/questions/${q.id}/verify`);
    assert.equal(verify.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId: p.id, kind: 'review', scope: { questionIds: [q.id] } });

    assert.equal((await t.req('DELETE', `/api/questions/${q.id}`)).body.ok, true);
  });

  it('updates issues and starts fix runs', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('issues'));
    const id = newId();
    t.ctx.db.insert('review_issues', { id, project_id: p.id, node_id: 's1', source: 'review', severity: 'major', category: 'math', message: 'Errore', created_at: now() });
    const list = await t.req('GET', `/api/projects/${p.id}/issues?status=open`);
    assert.equal(list.body.length, 1);
    const fixed = await t.req('PATCH', `/api/issues/${id}`, { status: 'dismissed', resolution: 'ok' });
    assert.equal(fixed.body.status, 'dismissed');
    const fix = await t.req('POST', `/api/projects/${p.id}/issues/fix`, { issueIds: [id] });
    assert.equal(fix.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId: p.id, kind: 'regenerate', scope: { issueIds: [id] } });
    assert.equal((await t.req('POST', `/api/projects/${p.id}/issues/fix`, { issueIds: ['nope'] })).status, 404);
  });
});

describe('assets', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

  it('rejects an SVG with a script and stores a clean one', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('assets'));
    const bad = multipart({}, [{ name: 'file', filename: 'evil.svg', type: 'image/svg+xml', data: svg('<script>alert(1)</script>') }]);
    const res = await t.req('POST', `/api/projects/${p.id}/assets`, bad.payload, bad.headers);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /script/);

    const good = multipart({ caption: 'Un cerchio' }, [{ name: 'file', filename: '../Fig ure è.svg', type: 'image/svg+xml', data: svg('<circle cx="5" cy="5" r="4"/>') }]);
    const ok = await t.req('POST', `/api/projects/${p.id}/assets`, good.payload, good.headers);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.filename, 'Fig-ure-e.svg');
    assert.equal(ok.body.mime, 'image/svg+xml');
    const file = await t.req('GET', `/api/assets/${ok.body.id}/file`);
    assert.equal(file.headers['content-type'], 'image/svg+xml');
    assert.match(file.raw, /<circle/);
    assert.ok(existsSync(paths.assets(t.ctx.config, p.id)));

    const again = await t.req('POST', `/api/projects/${p.id}/assets`, good.payload, good.headers);
    assert.equal(again.body.filename, 'Fig-ure-e-2.svg');
  });

  it('sanitizer refuses the dangerous constructs', () => {
    const bad = [
      svg('<script>x</script>'),
      svg('<rect onclick="x()"/>'),
      svg('<rect title=">" onload="x()"/>'),
      svg('<a href="javascript:alert(1)"><rect/></a>'),
      svg('<image href="https://example.com/x.png"/>'),
      svg('<image xlink:href="http://example.com/x.png"/>'),
      svg('<foreignObject><div/></foreignObject>'),
      svg('<rect style="fill:url(http://example.com/a)"/>'),
      svg('<style>@import url(http://example.com/a.css);</style>'),
      'not svg at all',
    ];
    for (const s of bad) assert.throws(() => assertSafeSvg(s), (e: { status?: number }) => e.status === 400, s);
    assert.doesNotThrow(() => assertSafeSvg(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><text>depends on x=1</text>')));
  });
});

describe('exports', () => {
  it('refuses an approved export while a blocker finding exists and allows a draft', async () => {
    const { projectId } = await projectWithOutline(t, 'exports');
    const blocker = installFakes({
      compileBook: () => ({ files: {}, formulaNumbers: {}, sectionNumbers: {}, findings: [
        { rule: 'unknown-formula', severity: 'blocker', message: 'Formula non trovata', file: 's1' },
        { rule: 'style', severity: 'minor', message: 'Frase lunga', file: 's2', line: 3 },
      ] }),
    });
    try {
      const refused = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /1 check failed/);
      assert.ok(refused.body.error.action);
      assert.equal((await t.req('GET', `/api/projects/${projectId}/exports`)).body.length, 0);

      const draft = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: false });
      assert.equal(draft.status, 200);
      assert.match(draft.body.filename, /^exports-\d{8}-\d{4}-draft\.ptsb$/);
      assert.equal(draft.body.approved, false);
      assert.equal(draft.body.report.ok, false);
      assert.deepEqual(draft.body.report.errors, [{ file: 's1', message: 'Formula non trovata' }]);
      assert.equal(draft.body.report.warnings.length, 1);
      assert.equal(draft.body.report.lint[1].line, 3);
      assert.equal(draft.body.size, 7);
      assert.equal(draft.body.sha256.length, 64);

      const dl = await t.req('GET', `/api/exports/${draft.body.id}/download`);
      assert.equal(dl.status, 200);
      assert.match(String(dl.headers['content-disposition']), /attachment; filename="exports-.*-draft\.ptsb"/);
      assert.equal(dl.raw.length, 7);

      const validate = await t.req('POST', `/api/projects/${projectId}/validate`);
      assert.equal(validate.body.ok, false);
      assert.equal(validate.body.errors.length, 1);
    } finally {
      blocker.restore();
      fakes = installFakes();
    }
  });

  it('refuses an approved export while a review blocker is open, then exports once it is dismissed', async () => {
    const { projectId } = await projectWithOutline(t, 'exports-ok');
    const id = newId();
    t.ctx.db.insert('review_issues', { id, project_id: projectId, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'Soluzione errata', created_at: now() });
    const refused = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /review problem/);

    await t.req('PATCH', `/api/issues/${id}`, { status: 'dismissed' });
    const ok = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true });
    assert.equal(ok.status, 200);
    assert.ok(!ok.body.filename.includes('draft'));
    assert.equal((await t.req('GET', `/api/projects/${projectId}`)).body.stage, 'export');
    assert.equal(t.ctx.events.since(0, projectId).filter((e) => e.type === 'export.ready').length, 1);
  });

  it('requires an approved outline for an approved export', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('exports-noapprove'));
    await t.req('PUT', `/api/projects/${p.id}/outline`, { outline: { chapters: [{ id: 'c1', slug: 'a', title: 'A', sections: [] }] }, baseRevId: null });
    const res = await t.req('POST', `/api/projects/${p.id}/exports`, { approved: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'outline_not_approved');
  });
});

describe('runs', () => {
  it('controls runs through the queue and aggregates usage with NULL propagation', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('runs'));
    const runId = t.ctx.queue.createRun(p.id, 'plan', [{ kind: 'login', key: 'a', label: 'A' }, { kind: 'gate', key: 'g', label: 'Gate' }]);
    // Park both tasks right away so the queue does not try to run them.
    t.ctx.db.run(`UPDATE tasks SET state = 'waiting_for_user', wait_reason = 'Approve' WHERE run_id = ?`, runId);
    for (const [i, o] of [[10, 5], [20, null], [30, 7]] as const) {
      t.ctx.db.run(`INSERT INTO usage (project_id, run_id, provider, model, role, input_tokens, output_tokens, ms, ok, created_at) VALUES (?, ?, 'codex', ?, 'writer', ?, ?, 1, 1, ?)`, p.id, runId, 'm', i, o, now());
    }
    t.ctx.db.run(`INSERT INTO usage (project_id, run_id, provider, model, role, input_tokens, output_tokens, ms, ok, created_at) VALUES (?, ?, 'claude', 'c', 'planner', 1, 2, 1, 1, ?)`, p.id, runId, now());
    assert.deepEqual(usageForRun(t.ctx, runId).map((u) => [u.provider, u.calls, u.inputTokens, u.outputTokens]), [['claude', 1, 1, 2], ['codex', 3, 60, null]]);

    const detail = (await t.req('GET', `/api/runs/${runId}`)).body;
    assert.equal(detail.tasks.length, 2);
    assert.equal(detail.usage.length, 2);
    assert.equal(detail.waiting.reason, 'Approve');
    assert.equal(detail.waiting.kind, 'author');
    assert.equal(detail.waiting.retryAt, null);
    assert.equal(detail.counts.waiting_for_user, 2);
    assert.equal((await t.req('GET', `/api/projects/${p.id}/runs`)).body.length, 1);

    const gate = detail.tasks.find((x: { kind: string }) => x.kind === 'gate');
    const resolved = await t.req('POST', `/api/tasks/${gate.id}/resolve`, { decision: 'continue' });
    assert.equal(resolved.body.state, 'succeeded');
    assert.equal((await t.req('POST', `/api/tasks/${gate.id}/resolve`, { decision: 'continue' })).status, 409);

    assert.equal((await t.req('POST', `/api/runs/${runId}/pause`)).body.status, 'paused');
    assert.equal((await t.req('POST', `/api/runs/${runId}/resume`)).body.status, 'running');
    assert.equal((await t.req('POST', `/api/runs/${runId}/cancel`)).body.status, 'cancelled');
    assert.equal((await t.req('POST', `/api/runs/${runId}/retry`, {})).body.status, 'running');
    assert.equal((await t.req('GET', '/api/runs/nope')).status, 404);

    const started = await t.req('POST', `/api/projects/${p.id}/runs`, { kind: 'generate', scope: { chapterIds: ['c1'] } });
    assert.equal(started.status, 200);
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId: p.id, kind: 'generate', scope: { chapterIds: ['c1'] } });
    assert.equal((await t.req('POST', `/api/projects/${p.id}/runs`, { kind: 'bogus' })).status, 400);
  });
});

describe('settings and system', () => {
  it('merges settings patches and calls the shutdown hook after replying', async () => {
    const before = (await t.req('GET', '/api/settings')).body;
    const put = await t.req('PUT', '/api/settings', { evidenceMode: 'local', routes: { writer: { primary: { provider: 'codex', model: 'gpt-6-sol' } } } });
    assert.equal(put.status, 200);
    assert.equal(put.body.evidenceMode, 'local');
    assert.equal(put.body.routes.writer.primary.provider, 'codex');
    assert.deepEqual(put.body.routes.reviewer, before.routes.reviewer, 'other roles untouched');
    assert.deepEqual(put.body.concurrency, before.concurrency);
    assert.equal((await t.req('PUT', '/api/settings', { routes: { nobody: { primary: { provider: 'a', model: 'b' } } } })).status, 400);

    let called = false;
    const r = installFakes({ shutdown: () => { called = true; } });
    try {
      assert.deepEqual((await t.req('POST', '/api/shutdown')).body, { ok: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(called, true);
    } finally {
      r.restore();
      fakes = installFakes();
    }
  });
});

describe('review fixes (server)', () => {
  const eventTypes = (projectId: string, type: string) => t.ctx.events.since(0, projectId).filter((e) => e.type === type);
  const qrow = (id: string) => t.ctx.db.get<Record<string, any>>('SELECT * FROM questions WHERE id = ?', id)!;

  it('3. editing a question marks it author-edited and keeps the import marker; every question change is announced', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('q-edited'));
    const q = (await t.req('POST', `/api/projects/${p.id}/questions`, { statement: 'Grezzo', kind: 'exam', origin: 'authentic' })).body;
    assert.equal(qrow(q.id).edited_at, null);
    t.ctx.db.run(`UPDATE questions SET imported_at = '2026-01-01', status = 'verified', checks = ? WHERE id = ?`, JSON.stringify([{ method: 'lint', ok: true, detail: 'imported' }]), q.id);

    const meta = await t.req('PATCH', `/api/questions/${q.id}`, { rev: 1, difficulty: 'facile' });
    assert.equal(meta.status, 200);
    assert.equal(qrow(q.id).edited_at, null, 'changing the difficulty is not a text edit');

    const edit = await t.req('PATCH', `/api/questions/${q.id}`, { rev: 2, solution: 'Riparata a mano' });
    assert.equal(edit.status, 200);
    const row = qrow(q.id);
    assert.ok(row.edited_at);
    assert.equal(row.imported_at, '2026-01-01', 'the import marker survives an edit');
    assert.equal(row.status, 'draft');
    assert.deepEqual(json(row.checks, []), [], 'checks are cleared, the marker is not one of them');

    await t.req('DELETE', `/api/questions/${q.id}`);
    // create, two patches, delete
    assert.equal(eventTypes(p.id, 'question.updated').length, 4);
    assert.ok(eventTypes(p.id, 'question.updated').every((e) => Array.isArray(e.data.questionIds)));
  });

  it('6. issue status changes are announced', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('issue-events'));
    const id = newId();
    t.ctx.db.insert('review_issues', { id, project_id: p.id, node_id: 's1', source: 'review', severity: 'major', category: 'math', message: 'Errore', created_at: now() });
    await t.req('PATCH', `/api/issues/${id}`, { status: 'dismissed' });
    assert.deepEqual(eventTypes(p.id, 'issue.updated').map((e) => e.data), [{ issueIds: [id] }]);
  });

  it('6. figures and extras announce their changes', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('asset-events'));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const up = multipart({}, [{ name: 'file', filename: 'c.svg', type: 'image/svg+xml', data: svg }]);
    const asset = (await t.req('POST', `/api/projects/${p.id}/assets`, up.payload, up.headers)).body;
    await t.req('PATCH', `/api/assets/${asset.id}`, { caption: 'Cerchio' });
    assert.equal(eventTypes(p.id, 'asset.updated').length, 2);
    const eid = newId();
    t.ctx.db.insert('enrichments', { id: eid, project_id: p.id, node_id: 's1', kind: 'ide', payload: { id: 'x', title: 'x', language: 'python', code: 'print(1)' }, status: 'draft', checks: [], created_at: now() });
    await t.req('PATCH', `/api/enrichments/${eid}`, { payload: { id: 'x', title: 'y', language: 'python', code: 'print(2)' } });
    await t.req('DELETE', `/api/enrichments/${eid}`);
    assert.equal(eventTypes(p.id, 'enrichment.updated').length, 2);
  });

  it('7. the generate route forwards scope.nodeIds', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('node-scope'));
    await t.req('POST', `/api/projects/${p.id}/runs`, { kind: 'generate', scope: { nodeIds: ['s3'] } });
    assert.deepEqual(fakes.calls.startRun.at(-1), { projectId: p.id, kind: 'generate', scope: { nodeIds: ['s3'] } });
  });

  it('8. changing a source role or inclusion recomputes exam frequency without a model call', async () => {
    const { body: p } = await t.req('POST', '/api/projects', projectBody('priorities'));
    const res = (id: string) => t.ctx.db.insert('resources', { id, project_id: p.id, kind: 'pdf', role: 'exams', filename: `${id}.pdf`, sha256: id.padEnd(64, 'a'), size: 1, path: `x/${id}.pdf`, included: 1, status: 'ready', created_at: now() });
    res('rA'); res('rB');
    const pre = p.id.slice(0, 8);
    for (const k of ['t1', 't2']) t.ctx.db.insert('topics', { id: `${pre}-${k}`, project_id: p.id, name: k, aliases: [], description: '', prerequisites: [], sources: [], exam_sessions: 0, priority: 'normal' });
    const exam = (resource: string, group: string, topic: string) => t.ctx.db.insert('questions', {
      id: newId(), project_id: p.id, kind: 'exam', origin: 'authentic', resource_id: resource, exam_group: group, number: '1', statement: 'x', topic_ids: [`${pre}-${topic}`],
      status: 'draft', checks: [], rev: 1, created_at: now(), updated_at: now(),
    });
    exam('rA', 'S1', 't1'); exam('rA', 'S2', 't1'); exam('rB', 'S3', 't2');
    const topic = (k: string) => t.ctx.db.get<Record<string, any>>('SELECT * FROM topics WHERE id = ?', `${pre}-${k}`)!;

    assert.equal((await t.req('PATCH', '/api/resources/rB', { included: true })).status, 200);
    assert.equal(topic('t1').priority, 'normal', 'no change, no recompute');
    await t.req('PATCH', '/api/resources/rB', { included: false });
    assert.deepEqual([topic('t1').exam_sessions, topic('t1').priority, topic('t2').exam_sessions, topic('t2').priority], [2, 'high', 0, 'low']);
    await t.req('PATCH', '/api/resources/rA', { role: 'theory' });
    assert.equal(topic('t1').exam_sessions, 0, 'a theory source holds no exam sessions');
    await t.req('PATCH', '/api/resources/rA', { role: 'exams' });
    await t.req('PATCH', '/api/resources/rB', { included: true });
    assert.deepEqual([topic('t1').exam_sessions, topic('t1').priority, topic('t2').exam_sessions], [2, 'high', 1]);
  });

  it('15. the approval gate counts a blocker whose fix is only proposed as unresolved', async () => {
    const { projectId } = await projectWithOutline(t, 'proposed-blocker');
    const id = newId();
    t.ctx.db.insert('review_issues', { id, project_id: projectId, node_id: 's1', source: 'review', severity: 'blocker', category: 'math', message: 'Errore', status: 'proposed', resolution: 'Proposal p1', created_at: now() });
    const refused = await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /1 review problem is still open/);
    await t.req('PATCH', `/api/issues/${id}`, { status: 'fixed' });
    assert.equal((await t.req('POST', `/api/projects/${projectId}/exports`, { approved: true })).status, 200);
  });
});
