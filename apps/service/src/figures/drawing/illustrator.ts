// The illustrator: a model draws one figure from the writer's description, in a conversation that holds the brief.
//
//   const r = await illustrate(ctx, { projectId, language: 'it', symbols: 'european', caption, shows, family: 'circuit' });
//   if (r.ok) store(r.svg, { engine: r.engine, source: r.source });  else dropWithNote(r.reason);
//
// The steps, all in one conversation (`withRole`) so the model keeps what it drew:
//   1. the brief goes in and the source comes back (plain text: a fence around it is removed);
//   2. the source is compiled by `renderDrawing`. A compile error goes back to the model, at most MAX_REPAIRS times;
//   3. the compiled drawing is rasterised and goes back as a picture with a checklist. The model answers OK or a corrected
//      source, which is compiled like any source (one repair). This look is done once. A correction that does not compile,
//      or a follow-up that fails, keeps the drawing that compiled before.
// No drawing that compiles means no figure: the caller drops the request with the reason.
import type { DrawingFamily } from '@smartbuilder/domain';
import type { AppContext } from '../../context.ts';
import { FollowUpError, withRole, type ParseResult, type RoleConversation } from '../../llm/index.ts';
import { illustratorPrompt, illustratorSystem, lookMessage, repairMessage } from './prompt.ts';
import { rasterizeDrawing, renderDrawing } from './index.ts';
import type { CircuitSymbols, DrawingEngine } from './types.ts';

/** The one table that picks the engine: schemdraw draws logic, timing and Karnaugh figures best, Typst everything else (bake-off of 11 November). */
export const ENGINE_OF_FAMILY: Record<DrawingFamily, DrawingEngine> = {
  circuit: 'typst', logic: 'schemdraw', timing: 'schemdraw', karnaugh: 'schemdraw', 'state-machine': 'typst', 'block-diagram': 'typst',
  plot: 'typst', sketch: 'typst', 'tree-graph': 'typst', other: 'typst',
};

/** Compile errors sent back for the first source. The look turn gets one more repair. */
export const MAX_REPAIRS = 2;

export interface IllustrateInput {
  projectId: string;
  runId?: string | null;
  taskId?: string | null;
  signal?: AbortSignal;
  language: string;
  symbols: CircuitSymbols;
  caption: string;
  shows: string;
  family: DrawingFamily;
  /** The engine of an existing drawing (a redraw keeps it). Default: the family's engine. */
  engine?: DrawingEngine;
  /** A redraw: the source that draws the figure now and the author's instruction. */
  redraw?: { source: string; instruction: string };
  /** Accessible name written into the SVG. Default: the caption. */
  title?: string;
}

export interface Compiled { source: string; svg: string; width: number; height: number }

export type LookOutcome =
  /** The model looked at the picture and answered OK. */
  | 'ok'
  /** It answered with a corrected source that compiled, and that drawing was kept. */
  | 'corrected'
  /** It answered with a correction that did not compile or was not source: the earlier drawing was kept. */
  | 'kept'
  /** The look did not happen: the follow-up failed (a route that cannot read images, a limit). */
  | 'skipped';

export type Illustrated =
  | {
    ok: true; engine: DrawingEngine; source: string; svg: string; width: number; height: number;
    /** Renders the source went through: 1 when it compiled at once. */
    compileAttempts: number;
    look: LookOutcome;
    /** The first drawing that compiled, before the look turn. */
    first: Compiled;
    usage: { inputTokens: number; outputTokens: number; calls: number };
    ms: number;
    model: string;
  }
  | { ok: false; reason: string; compileAttempts: number; usage: { inputTokens: number; outputTokens: number; calls: number }; ms: number };

/** Strips a Markdown fence and checks that the answer looks like source of the engine, so a prose reply is not compiled as Typst text. */
export function cleanSource(engine: DrawingEngine, text: string): ParseResult<string> {
  const fenced = /```[\w-]*[ \t]*\n([\s\S]*?)```/.exec(text);
  const source = (fenced ? fenced[1] : text).trim();
  if (!source) return { ok: false, problem: 'The answer was empty. Reply with the drawing source.' };
  if (engine === 'typst' && !source.includes('#')) return { ok: false, problem: 'The answer has no Typst code: it needs an import and a call that start with #. Reply with the Typst source only.' };
  if (engine === 'schemdraw' && !/schemdraw/.test(source)) return { ok: false, problem: 'The answer is not schemdraw Python code. Reply with the Python source only.' };
  return { ok: true, data: source };
}

/** Whether the look turn's answer says the drawing is fine. A real source never starts like this and stays this short. */
export const saysOk = (text: string) => /^\W*ok\b/i.test(text.trim()) && text.trim().length < 120;

class SetupProblem extends Error {}

export async function illustrate(ctx: AppContext, o: IllustrateInput): Promise<Illustrated> {
  const engine = o.engine ?? ENGINE_OF_FAMILY[o.family];
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const add = (u: { inputTokens: number | null; outputTokens: number | null }, calls = 1) => {
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.calls += calls;
  };
  let renders = 0;
  const finish = () => ({ usage, ms: Date.now() - started, compileAttempts: renders });

  const compile = async (source: string): Promise<{ ok: true; c: Compiled } | { ok: false; error: string }> => {
    renders++;
    const r = await renderDrawing({ engine, source, symbols: o.symbols, title: o.title ?? o.caption });
    if (r.ok) return { ok: true, c: { source, svg: r.svg, width: r.width, height: r.height } };
    if (r.kind === 'setup') throw new SetupProblem(r.error);
    return { ok: false, error: r.error };
  };

  /** Compiles a source, and on an error sends it back up to `repairs` times. Throws FollowUpError when the model cannot be asked again. */
  const settle = async (talk: RoleConversation<string>, source: string, repairs: number): Promise<{ c?: Compiled; error: string }> => {
    let src: string | null = source;
    let error = '';
    for (let n = 0; n <= repairs; n++) {
      if (src !== null) {
        const r = await compile(src);
        if (r.ok) return { c: r.c, error: '' };
        error = r.error;
      }
      if (n === repairs) break;
      const reply = await talk.send(repairMessage(error));
      add(reply.usage);
      const cleaned = cleanSource(engine, reply.text);
      src = cleaned.ok ? cleaned.data : null;
      if (!cleaned.ok) error = cleaned.problem;
    }
    return { error };
  };

  try {
    return await withRole<string, Illustrated>(ctx, {
      role: 'illustrator',
      system: illustratorSystem(engine),
      prompt: illustratorPrompt({ caption: o.caption, shows: o.shows, family: o.family, language: o.language, symbols: o.symbols, redraw: o.redraw }),
      parse: (text) => cleanSource(engine, text),
      projectId: o.projectId, runId: o.runId, taskId: o.taskId, signal: o.signal,
    }, async (talk) => {
      // The first answer may have cost a repair turn inside runRole: its usage is the total of both.
      add(talk.result.usage, 1);
      let first: Compiled | undefined;
      let error: string;
      try {
        ({ c: first, error } = await settle(talk, talk.result.data, MAX_REPAIRS));
      } catch (err) {
        if (!(err instanceof FollowUpError)) throw err;
        return { ok: false, reason: `the illustrator stopped before the drawing compiled (${err.message})`, ...finish() };
      }
      const compileAttempts = renders;
      if (!first) return { ok: false, reason: `the drawing did not compile after ${renders} attempts: ${error.split('\n')[0]}`, ...finish() };

      let best = first;
      let look: LookOutcome = 'skipped';
      try {
        const reply = await talk.send(lookMessage(!!o.redraw), { images: [rasterizeDrawing(first.svg, 1000)] });
        add(reply.usage);
        if (saysOk(reply.text)) {
          look = 'ok';
        } else {
          look = 'kept';
          const cleaned = cleanSource(engine, reply.text);
          if (cleaned.ok) {
            const fixed = await settle(talk, cleaned.data, 1);
            if (fixed.c) { best = fixed.c; look = 'corrected'; }
          }
        }
      } catch (err) {
        // A follow-up that fails, or a setup problem that appears late, keeps what already compiled.
        if (!(err instanceof FollowUpError) && !(err instanceof SetupProblem)) throw err;
      }
      return { ok: true, engine, ...best, compileAttempts, look, first, usage, ms: Date.now() - started, model: talk.result.route.model };
    });
  } catch (err) {
    if (err instanceof SetupProblem) return { ok: false, reason: err.message, ...finish() };
    throw err;
  }
}
