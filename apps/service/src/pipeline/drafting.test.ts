// How a section is drafted: order inside a chapter, the answer format, the prompt layout and the writer's self-check.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_ROUTES } from '@smartbuilder/domain';
import { newId, now } from '../db/db.ts';
import { resetConnectionsCache, resetLlmState, setFunnel } from '../llm/index.ts';
import { FakeFunnel, makeCtx, seedProject } from '../llm/testkit.ts';
import { Queue, TaskError } from '../queue/queue.ts';
import type { AppContext } from '../context.ts';
import { generateSpecs } from './runs.ts';

let fake: FakeFunnel;
let kit: ReturnType<typeof makeCtx>;
let ctx: AppContext;
const P = 'project01';

beforeEach(() => {
  fake = new FakeFunnel();
  setFunnel(fake);
  resetLlmState();
  resetConnectionsCache();
  kit = makeCtx();
  ctx = kit.ctx;
  ctx.saveSettings({ routes: DEFAULT_ROUTES });
  seedProject(ctx, P);
});
afterEach(() => {
  setFunnel(null);
  kit.cleanup();
});

/** Approved outline: chapters of [chapterId, sectionIds], optionally closed by an exam guide. */
function seedOutline(chapters: [string, string[]][], o: { guides?: boolean } = {}) {
  const outline = {
    chapters: chapters.map(([id, sections], i) => ({
      id, slug: `cap-${i + 1}`, title: `Capitolo ${i + 1}`, objectives: [], prerequisites: [],
      sections: [
        ...sections.map((sid, j) => ({ id: sid, title: `Sezione ${i + 1}.${j + 1}`, objectives: [`Obiettivo ${i + 1}.${j + 1}`], topicIds: [], depth: 'standard', subsections: [] })),
        ...(o.guides ? [{ id: `${id}-guide`, title: 'Come viene chiesto', objectives: [], topicIds: [], depth: 'standard', subsections: [], role: 'exam-guide' }] : []),
      ],
    })),
    exclusions: [], notation: '',
  };
  const id = newId();
  ctx.db.insert('outline_revisions', { id, project_id: P, outline, origin: 'human', note: '', created_at: now(), approved_at: now() });
  ctx.db.run('UPDATE projects SET outline_rev_id = ? WHERE id = ?', id, P);
  return outline;
}

const options = (o: Record<string, unknown>) => ctx.db.run('UPDATE projects SET options = ? WHERE id = ?', JSON.stringify(o), P);

describe('sections of a chapter are written in order', () => {
  const draftDeps = (specs: { key: string; deps?: string[] }[]) => Object.fromEntries(specs.filter((s) => s.key.startsWith('draft:')).map((s) => [s.key, s.deps]));

  test('a draft waits for the draft before it in its chapter, and chapters stay independent', () => {
    seedOutline([['c1', ['s1', 's2', 's3']], ['c2', ['s4', 's5']]]);
    options({ firstChapterGate: true });
    const deps = draftDeps(generateSpecs(ctx, P));
    assert.deepEqual(deps['draft:s1'], ['evidence:s1']);
    assert.deepEqual(deps['draft:s2'], ['evidence:s2', 'draft:s1']);
    assert.deepEqual(deps['draft:s3'], ['evidence:s3', 'draft:s2']);
    assert.deepEqual(deps['draft:s4'], ['evidence:s4'], 'the next chapter does not wait for the previous one');
    assert.deepEqual(deps['draft:s5'], ['evidence:s5', 'draft:s4']);
  });

  test('the first-chapter gate and the exam guide keep their dependencies', () => {
    seedOutline([['c1', ['s1', 's2']], ['c2', ['s3', 's4']]], { guides: true });
    options({ firstChapterGate: true });
    const specs = generateSpecs(ctx, P);
    const by = Object.fromEntries(specs.map((s) => [s.key, s.deps]));
    assert.deepEqual(by['evidence:s3'], ['gate:first-chapter']);
    assert.deepEqual(by['evidence:s1'], []);
    assert.deepEqual(by['draft:c2-guide'], ['gate:first-chapter', 'draft:s3', 'draft:s4'], 'the guide waits for every section of its chapter, and the last section is not repeated');
    assert.deepEqual(by['draft:s4'], ['evidence:s4', 'draft:s3']);
    assert.deepEqual(by['gate:first-chapter'], ['review:c1', 'practice-done:c1']);
  });

  test('a scoped run waits only for the earlier sections it contains', () => {
    seedOutline([['c1', ['s1', 's2', 's3']]]);
    const specs = generateSpecs(ctx, P, undefined, ['s2', 's3']);
    assert.deepEqual(draftDeps(specs), { 'draft:s2': ['evidence:s2'], 'draft:s3': ['evidence:s3', 'draft:s2'] });
  });

  test('a failed section blocks only its successors, and retrying it lets the chapter go on', async () => {
    seedOutline([['c1', ['s1', 's2', 's3']], ['c2', ['s4']]]);
    options({ firstChapterGate: false });
    const specs = generateSpecs(ctx, P).filter((s) => s.kind === 'section.evidence' || s.kind === 'section.draft');
    const queue = new Queue(ctx.db, ctx.events, () => 2);
    const written: string[] = [];
    let healthy = false;
    queue.register('section.evidence', async () => ({ ok: true }));
    queue.register('section.draft', async (t) => {
      const id = t.task.input.nodeId as string;
      if (id === 's2' && !healthy) throw new TaskError('The model answered nonsense.', 'fatal');
      written.push(id);
      return { nodeId: id };
    });
    const runId = queue.createRun(P, 'generate', specs);
    const until = async (fn: () => boolean) => { for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn(), 'timed out'); };
    queue.start();
    try {
      await until(() => queue.runSummary(runId)!.status === 'failed');
      const state = (section: string) => queue.tasks(runId).find((t) => t.kind === 'section.draft' && t.label === `Write "Sezione ${section}"`)!;
      assert.equal(state('1.2').state, 'failed');
      assert.equal(state('1.3').state, 'cancelled');
      assert.equal(state('1.3').error?.message, 'Not run: an earlier task failed.', 'the cause shows on the task that failed, and the successor says why it did not run');
      assert.deepEqual(written.sort(), ['s1', 's4'], 'the other chapter was not held up');
      healthy = true;
      queue.retry(runId, [state('1.2').id]);
      await until(() => queue.runSummary(runId)!.status === 'completed');
      assert.deepEqual(written.sort(), ['s1', 's2', 's3', 's4']);
    } finally {
      await queue.stop();
    }
  });
});
