// What the illustrator is told. The system prompt is the same for every figure of one engine, so a provider can cache it;
// everything that changes from figure to figure is in the user prompt.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DrawingFamily } from '@smartbuilder/domain';
import { languageName } from '../../pipeline/prompts.ts';
import type { CircuitSymbols, DrawingEngine } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** The cheat sheets are Markdown files next to this module. A test renders every code block in them. */
export const SHEET_FILES: Record<DrawingEngine, string> = { typst: join(here, 'sheets', 'typst.md'), schemdraw: join(here, 'sheets', 'schemdraw.md') };

const ROLE = `You are the illustrator of a university textbook. A writer gives you a brief for one figure, and you answer with the drawing source code of that figure, following the cheat sheet below.

OUTPUT. Reply with the source only: no prose, no Markdown fence, no explanation. When you later get a compile error, a picture to check or a change to make, the reply is again the full source, never a patch.

RULES
- Correct first: the right topology and connections, every element, label and value of the brief present, nothing the brief does not ask for. Neat second.
- A label never sits on a line, on a part or on another label. Leave a gap, or move the label beside its part.
- Every wire end lands on a part, a node or a dot, and a dot marks every place where wires join.
- Units are written as in the book (upright, with SI prefixes). Symbols are math. A label that is a word is in the book's language.
- Keep it as simple as the brief allows: no title, no frame, no decoration.`;

const systems = new Map<DrawingEngine, string>();

/** The system prompt of an engine: the role, the output contract, the drawing rules and the cheat sheet of that engine only. */
export function illustratorSystem(engine: DrawingEngine): string {
  let s = systems.get(engine);
  if (!s) {
    s = `${ROLE}\n\nCHEAT SHEET\n\n${readFileSync(SHEET_FILES[engine], 'utf8').trim()}`;
    systems.set(engine, s);
  }
  return s;
}

export interface IllustratorBrief {
  caption: string;
  shows: string;
  family: DrawingFamily;
  /** The book's language code. */
  language: string;
  symbols: CircuitSymbols;
  /** For a redraw: the source that draws the figure now, and what the author wants changed. */
  redraw?: { source: string; instruction: string };
}

export function illustratorPrompt(b: IllustratorBrief): string {
  const symbols = b.symbols === 'american' ? 'American (a zigzag resistor)' : 'European (a rectangular resistor)';
  const head = `Book language: ${languageName(b.language)}. Circuit symbols: ${symbols}.\nCaption: ${b.caption}\nFamily: ${b.family}\nWhat the figure shows:\n${b.shows}`;
  if (!b.redraw) return `${head}\n\nWrite the source now.`;
  return `${head}\n\nThe figure is drawn by this source now:\n${b.redraw.source}\n\nThe author asks for this change: ${b.redraw.instruction}\nMake that change and keep everything else as it is. Reply with the full new source.`;
}

/** The message that sends a compile error back. */
export const repairMessage = (error: string) => `Your source did not compile. Compiler output:\n\n${error}\n\nReply with the full corrected source only.`;

/** The message that goes with the picture of the drawing. The reply is exactly OK or the full corrected source. */
export const LOOK_MESSAGE = `This is your drawing as the reader sees it, at the width it has in the book. Check it against the brief:
1. Every element, label and value of the brief is present.
2. The connections are correct.
3. Nothing overlaps or is cut off.
4. It is readable at book width.
5. Every label is written as the book writes the quantity: a symbol with a subscript has its argument, such as (t) or (jω), after the subscript, not inside it.
Answer exactly OK if all five hold. Otherwise answer with the full corrected source and nothing else.`;
