// Live smoke test: every role's route answers a structured probe, and one NotebookLM round trip works end to end.
// Uses the owner's real subscriptions and NotebookLM quota. Run once: npx tsx scripts/smoke-routes.ts [--data-dir <dir>] [--pdf <file>] [--skip-roles] [--skip-notebooklm]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLES } from '@smartbuilder/domain';
import type { Config } from '../apps/service/src/config.ts';
import { createContext } from '../apps/service/src/context.ts';
import { newId, now } from '../apps/service/src/db/db.ts';
import { gatherEvidence, localEvidenceMeta, notebookStatus } from '../apps/service/src/evidence/index.ts';
import { deleteNotebook } from '../apps/service/src/evidence/nlm.ts';
import { extractResource, storeResource } from '../apps/service/src/extract/index.ts';
import { getConnections, probeRole } from '../apps/service/src/llm/index.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const flag = (name: string) => argv.includes(`--${name}`);

const dataDir = arg('data-dir') ?? mkdtempSync(join(tmpdir(), 'smartbuilder-smoke-'));
mkdirSync(dataDir, { recursive: true });
const pdf = arg('pdf') ?? '/home/tost/politost-sources/Analisi/ESAME/Esami scritti 2022-23.pdf';
const config: Config = { dataDir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: '', version: 'smoke' };
const ctx = createContext(config);
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
};
let failures = 0;
const fail = (s: string) => {
  failures++;
  say(`FAIL ${s}`);
};

async function roles() {
  say('== connections');
  const c = await getConnections(ctx);
  for (const p of c.providers) say(`  ${p.provider.padEnd(12)} installed=${p.installed} signedIn=${p.signedIn} version=${p.version ?? '-'} models=${p.models.length} images=${p.capabilities.images} schema=${p.capabilities.schema}${p.error ? ` error="${p.error}"` : ''}`);
  say(`  notebooklm   installed=${c.notebooklm.installed} signedIn=${c.notebooklm.signedIn} account=${c.notebooklm.account ?? '-'} usage=${c.notebooklm.usage.map((u) => `${u.window}: ${u.remaining}`).join(' | ')}`);
  say(`  libreoffice  ${c.libreoffice.installed ? c.libreoffice.path : 'not found'}   node ${c.node}`);

  say('== probeRole');
  for (const role of ROLES) {
    const route = ctx.settings().routes[role].primary;
    const r = await probeRole(ctx, role);
    say(`  ${role.padEnd(9)} ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.ms).padStart(6)} ms  [${route.provider}/${route.model}]  ${r.detail}`);
    if (!r.ok) failures++;
  }
  const usage = ctx.db.all<{ provider: string; model: string; role: string; input_tokens: number | null; output_tokens: number | null; ms: number; ok: number }>('SELECT * FROM usage ORDER BY id');
  say('== usage rows');
  for (const u of usage) say(`  ${u.provider}/${u.model} role=${u.role} in=${u.input_tokens ?? 'NULL'} out=${u.output_tokens ?? 'NULL'} ${u.ms} ms ok=${u.ok}`);
}

async function notebook() {
  say('== NotebookLM round trip');
  const status = await notebookStatus({ fresh: true });
  say(`  status: installed=${status.installed} signedIn=${status.signedIn} account=${status.account ?? '-'}${status.error ? ` error=${status.error}` : ''}`);
  if (!status.signedIn) return fail('NotebookLM is not signed in');

  const projectId = newId();
  ctx.db.run(`INSERT INTO projects (id, slug, title, subject, language, created_at, updated_at) VALUES (?, 'smoke', 'Smoke test (delete me)', 'Analisi', 'it', ?, ?)`, projectId, now(), now());
  const resourceId = await storeResource(ctx, projectId, { filename: 'Esami scritti 2022-23.pdf', bytes: readFileSync(pdf), role: 'exams' });
  const t0 = Date.now();
  const ex = await extractResource(ctx, resourceId, new AbortController().signal);
  say(`  extracted ${ex.pages} pages (${ex.garbled} garbled) in ${Date.now() - t0} ms`);

  try {
    ctx.saveSettings({ evidenceMode: 'notebooklm' });
    const t1 = Date.now();
    const packet = await gatherEvidence(ctx, {
      projectId, nodeId: 'smoke', resourceIds: [resourceId],
      query: "Qual e' il testo dell'Esercizio 1 dell'esame del 25 gennaio 2023 (turno 1) e come si determina il dominio della funzione? Cita il testo.",
    }, { force: true });
    say(`  gatherEvidence: provider=${packet.provider} in ${Date.now() - t1} ms, answer ${packet.answer.length} chars, ${packet.notes.length} notes`);
    if (packet.provider !== 'notebooklm') fail(`expected provider notebooklm, got ${packet.provider}${localEvidenceMeta(packet.answer) ? ' (local fallback)' : ''}`);
    const verified = packet.notes.filter((n) => n.verified).length;
    for (const n of packet.notes) say(`    ${n.id} verified=${n.verified} page=${n.page === null ? '-' : n.page + 1} claim="${n.claim.slice(0, 90)}" quote="${n.quote.slice(0, 70).replace(/\s+/g, ' ')}..."`);
    say(`  citations resolved to a page: ${verified}/${packet.notes.length}`);
    if (!packet.notes.length) fail('no citations came back');
    else if (!verified) fail('no citation could be located in the extracted pages');
    const srcs = ctx.db.all<{ status: string; remote_source_id: string }>('SELECT status, remote_source_id FROM notebook_sources');
    say(`  notebook_sources: ${srcs.map((s) => `${s.status}:${s.remote_source_id}`).join(', ')}`);
  } finally {
    for (const nb of ctx.db.all<{ remote_id: string; title: string }>('SELECT remote_id, title FROM notebooks')) {
      try {
        await deleteNotebook(nb.remote_id);
        say(`  deleted scratch notebook ${nb.remote_id} (${nb.title})`);
      } catch (err) {
        fail(`could not delete scratch notebook ${nb.remote_id} (${nb.title}): ${err instanceof Error ? err.message : String(err)}. Delete it by hand.`);
      }
    }
  }
}

try {
  if (!flag('skip-roles')) await roles();
  if (!flag('skip-notebooklm')) await notebook();
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  ctx.db.close();
  if (!arg('data-dir')) rmSync(dataDir, { recursive: true, force: true });
}
say(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
