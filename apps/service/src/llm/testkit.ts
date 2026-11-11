// Helpers shared by the llm and evidence tests. Not used at runtime.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities, LiveSessionInfo, ModelInfo, ProcessOptions, ProviderOverview, RateLimits, RunInput, RunResult } from 'cli-funnel';
import type { Config } from '../config.ts';
import { createContext, type AppContext } from '../context.ts';
import { META_SEPARATOR } from './body.ts';
import type { FunnelLike } from './funnel.ts';

// The tests never touch the owner's logins: the private homes link to these stand-ins instead.
export const fakeLogins = mkdtempSync(join(tmpdir(), 'sb-logins-'));
process.env.CODEX_HOME = join(fakeLogins, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(fakeLogins, 'claude');
for (const [dir, file] of [['codex', 'auth.json'], ['claude', '.credentials.json']]) {
  mkdirSync(join(fakeLogins, dir), { recursive: true });
  writeFileSync(join(fakeLogins, dir, file), '{}');
}

export function makeCtx(): { ctx: AppContext; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
  const config: Config = { dataDir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: '', version: 'test' };
  const ctx = createContext(config);
  return { ctx, cleanup: () => { ctx.db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

/** A book with the defaults, except that its writer does not check its own drafts: a test that wants that turn scripts it and turns the option on. */
export function seedProject(ctx: AppContext, id = 'p1', title = 'Analisi 1') {
  ctx.db.run(`INSERT INTO projects (id, slug, title, subject, language, options, created_at, updated_at) VALUES (?, ?, ?, 'Analisi', 'it', '{"selfCheck":false}', 'now', 'now')`, id, id, title);
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
  /** Session ids that stay live after their turn, as Claude Code and Codex do with keepAlive. */
  live = new Set<string>();
  closed: string[] = [];
  /** What rateLimits() answers per provider. Others throw, as in cli-funnel. */
  usage: Record<string, RateLimits> = {};
  /** The options each rateLimits() call got. */
  rateLimitOptions: (ProcessOptions | undefined)[] = [];

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

  sessions(): LiveSessionInfo[] {
    return [...this.live].map((sessionId) => ({ sessionId }) as LiveSessionInfo);
  }

  closeSession(sessionId: string): boolean {
    this.closed.push(sessionId);
    return this.live.delete(sessionId);
  }

  async rateLimits(id: never, opts?: ProcessOptions): Promise<RateLimits> {
    this.rateLimitOptions.push(opts);
    const u = this.usage[id];
    if (!u) throw Object.assign(new Error(`${String(id)} cannot report its usage windows.`), { code: 'unsupported' });
    return u;
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

/**
 * A fix answer in the plain-text format of the patch prompt, written from the data it carries. Every change is given as
 * answering problem 1. `resolved` entries say the current text already fixes problems.
 */
export function patchText(a: { changes: { block: number; text: string }[]; figures?: unknown[]; resolved?: { issues: number[]; reason: string }[] }): string {
  const parts = [
    ...a.changes.map((c) => (c.text === '' ? `@@@ delete ${c.block} | issues 1` : `@@@ block ${c.block} | issues 1\n${c.text}`)),
    ...(a.resolved ?? []).map((r) => `@@@ resolved | issues ${r.issues.join(', ')}\n${r.reason}`),
    ...(a.figures?.length ? [`@@@ figures\n${JSON.stringify(a.figures)}`] : []),
  ];
  return parts.join('\n\n') || '@@@ none';
}

export const patchAnswer = (a: Parameters<typeof patchText>[0]) => () => ({ text: patchText(a), usage: usageOf(10, 10) });

/** A section answer in the writer's format: the text, a separator line, then the small JSON. */
export const written = (o: { markdown: string; figures?: unknown[]; noFigureReason?: string | null; summary?: string }) => () => ({
  text: `${o.markdown}\n${META_SEPARATOR}\n${JSON.stringify({ figures: o.figures ?? [], noFigureReason: o.noFigureReason ?? null, summary: o.summary ?? 'riassunto' })}`,
  usage: usageOf(10, 10),
});

/** A lab answer in the same format: the code, a separator line, then id, title, description and expectedOutput. */
export const wroteCode = ({ code, ...meta }: { code: string; id: string; title: string; description: string; expectedOutput: string }) => () => ({ text: `${code}\n${META_SEPARATOR}\n${JSON.stringify(meta)}`, usage: usageOf(10, 10) });

/** An exam reading in the plain-text format of the extraction prompts: a statement part and an optional solution part per exercise, or an unreadable line. */
export const examText = (exercises: { number: string; statement?: string; solution?: string; readable?: boolean }[]): string => exercises
  .map((e) => (e.readable === false ? `@@@ unreadable ${e.number}` : `@@@ statement ${e.number}\n${e.statement ?? ''}${e.solution ? `\n@@@ solution ${e.number}\n${e.solution}` : ''}`))
  .join('\n');

export const examRead = (...exercises: Parameters<typeof examText>[0]) => () => ({ text: examText(exercises), usage: usageOf(10, 10) });
