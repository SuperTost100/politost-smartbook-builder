// Helpers shared by the llm and evidence tests. Not used at runtime.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities, ModelInfo, ProviderOverview, RunInput, RunResult } from 'cli-funnel';
import type { Config } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import type { FunnelLike } from './funnel.ts';

export function makeCtx(): { ctx: AppContext; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
  const config: Config = { dataDir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: '', version: 'test' };
  const ctx = createContext(config);
  return { ctx, cleanup: () => { ctx.db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

export function seedProject(ctx: AppContext, id = 'p1', title = 'Analisi 1') {
  ctx.db.run(`INSERT INTO projects (id, slug, title, subject, language, created_at, updated_at) VALUES (?, ?, ?, 'Analisi', 'it', 'now', 'now')`, id, id, title);
}

export function seedResource(ctx: AppContext, o: { id: string; projectId?: string; kind?: string; filename?: string; sha256?: string; path?: string; role?: string; status?: string; included?: number }) {
  ctx.db.run(
    `INSERT INTO resources (id, project_id, kind, role, filename, sha256, size, path, included, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'now')`,
    o.id, o.projectId ?? 'p1', o.kind ?? 'pdf', o.role ?? 'theory', o.filename ?? `${o.id}.pdf`, o.sha256 ?? `${o.id}`.padEnd(64, 'a'), o.path ?? `/nonexistent/${o.id}.pdf`, o.included ?? 1, o.status ?? 'ready',
  );
}

export function seedPage(ctx: AppContext, resourceId: string, idx: number, text: string, transcript: string | null = null) {
  const id = `${resourceId}-p${idx}`;
  ctx.db.run(`INSERT INTO pages (id, resource_id, idx, label, text, quality, transcript) VALUES (?, ?, ?, ?, ?, 'good', ?)`, id, resourceId, idx, String(idx + 1), text, transcript);
  const rowid = ctx.db.get<{ rowid: number }>('SELECT rowid FROM pages WHERE id = ?', id)!.rowid;
  ctx.db.run('INSERT INTO pages_fts (rowid, text, transcript) VALUES (?, ?, ?)', rowid, text, transcript ?? '');
}

export const caps = (images: boolean, schema: Capabilities['schema'] = 'native', access: Capabilities['access'] = ['none']): Capabilities => ({
  access, effort: true, contextWindow: false, fast: false, resume: false, approvals: false, images, system: 'native', schema,
});

export type Step = (input: RunInput) => Partial<RunResult> | Error | Promise<Partial<RunResult> | Error>;

/** A scripted funnel: each run() call consumes the next step. */
export class FakeFunnel implements FunnelLike {
  calls: RunInput[] = [];
  steps: Step[] = [];
  providers: FunnelLike['providers'] = {
    // As in cli-funnel: only Claude and Codex pass approvals through (supervised).
    claude: { displayName: 'Claude Code', capabilities: caps(true, 'native', ['none', 'supervised', 'accept-edits', 'auto', 'full']) },
    codex: { displayName: 'Codex', capabilities: caps(true, 'native', ['none', 'supervised', 'accept-edits', 'auto', 'full']) },
    agent: { displayName: 'Cursor Agent', capabilities: caps(false, 'prompt') },
    antigravity: { displayName: 'Antigravity', capabilities: caps(false) },
  };
  installed: Record<string, boolean> = { claude: true, codex: true, agent: false, antigravity: true };
  loggedIn: Record<string, boolean> = { claude: true, codex: true, agent: false, antigravity: false };

  next(...steps: Step[]) {
    this.steps.push(...steps);
    return this;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (!step) throw new Error('FakeFunnel: no scripted step left');
    const out = await step(input);
    if (out instanceof Error) throw out;
    return { text: '', provider: input.selection.provider, model: input.selection.model, finishReason: 'stop', toolCalls: [], deniedActions: [], ...out };
  }

  async overview(): Promise<ProviderOverview[]> {
    return Object.entries(this.providers).map(([id, p]) => ({
      id: id as never,
      displayName: p.displayName,
      capabilities: p.capabilities,
      installation: { installed: this.installed[id] ?? false, version: this.installed[id] ? '1.2.3' : undefined, testedRange: { min: '0' }, detail: this.installed[id] ? undefined : `${p.displayName} CLI is not installed.` },
      auth: this.installed[id] ? { loggedIn: this.loggedIn[id] ?? false, detail: this.loggedIn[id] ? undefined : 'Not signed in' } : undefined,
    }));
  }

  async models(id: never): Promise<ModelInfo[]> {
    return [{ id: `${String(id)}-model`, name: `${String(id)} model`, provider: id, efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], contextWindows: [], fast: false, source: 'manifest' }];
  }
}

export const usageOf = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
