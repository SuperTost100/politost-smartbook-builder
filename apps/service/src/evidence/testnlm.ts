// A fake `nlm` for tests: tracks notebooks and sources in memory and records every call.
import type { NlmResult, NlmRunner } from './nlm.ts';

export class FakeNlm {
  calls: string[][] = [];
  notebooks = new Map<string, { title: string; sources: { id: string; title: string }[] }>();
  signedIn = true;
  tier = 'NOTEBOOKLM_TIER_PRO_CONSUMER_USER';
  /** Max sources per notebook; adding beyond it fails with a source-limit message. */
  sourceLimit = Infinity;
  /** Throw this (as a crash) when `source add` runs, after optionally storing the source remotely. */
  crashAfterStore = false;
  /** Source id handed out by the next `source add` (default: generated). */
  nextSourceId?: string;
  queryResponse: unknown = { answer: '', references: [], sources_used: [] };
  private seq = 0;

  runner: NlmRunner = async (args) => {
    this.calls.push(args);
    const ok = (v: unknown): NlmResult => ({ code: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    const err = (m: string): NlmResult => ({ code: 1, stdout: JSON.stringify({ status: 'error', error: m }), stderr: '' });
    const [a, b] = args;
    if (a === 'login') return this.signedIn ? ok('✓ Authentication valid!\n  Profile: default\n  Account: me@example.com\n') : { code: 1, stdout: '', stderr: 'Authentication failed: cookies have expired' };
    if (a === 'usage') return ok({ windows: [{ window: 'rolling', percent_used: 1, percent_remaining: 99, resets_at: '2026-10-07T04:04:42+00:00' }], tier: this.tier });
    if (a === 'notebook' && b === 'create') {
      const id = `nb${++this.seq}`;
      this.notebooks.set(id, { title: args[2], sources: [] });
      return ok({ notebook_id: id, title: args[2], url: `https://example/${id}` });
    }
    if (a === 'notebook' && b === 'delete') {
      this.notebooks.delete(args[2]);
      return ok({ status: 'success' });
    }
    if (a === 'source' && b === 'list') {
      const nb = this.notebooks.get(args[2]);
      return nb ? ok(nb.sources) : err('Notebook not found');
    }
    if (a === 'source' && b === 'add') {
      const nb = this.notebooks.get(args[2]);
      if (!nb) return err('Notebook not found');
      if (nb.sources.length >= this.sourceLimit) return err(`Source limit reached: a notebook can have at most ${this.sourceLimit} sources`);
      const title = args[args.indexOf('--title') + 1];
      const id = this.nextSourceId ?? `src${++this.seq}`;
      nb.sources.push({ id, title });
      if (this.crashAfterStore) throw new Error('process died');
      return ok({ source_type: 'file', source_id: id, title });
    }
    if (a === 'notebook' && b === 'query') return ok(this.queryResponse);
    return err(`unexpected command ${args.join(' ')}`);
  };

  count(...prefix: string[]) {
    return this.calls.filter((c) => prefix.every((p, i) => c[i] === p)).length;
  }
}
