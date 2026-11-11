// An answer made of one long text (Markdown or code) as plain text, then a separator line, then a small JSON object.
// The long text never travels inside a JSON string, so no backslash of a formula or a program is ever an escape.
import { rewriteLatexNames, sanitizeModelValue } from '@smartbuilder/content';
import type { z } from 'zod';
import type { ParseResult } from './index.ts';
import { describeIssues, dropOptionalNulls, parseJsonAnswer, rawJsonSchema } from './schema.ts';

/** A line of its own between the text and its metadata. It is no Markdown, no LaTeX and no code a book contains. */
export const META_SEPARATOR = '<<<META>>>';

/** The sentence that tells the model the format. `field` names the text in the prompt ("the section", "the program"). */
export function bodyFormatRule(field: string, withMeta: boolean) {
  return withMeta
    ? `Answer in this format, with no code fence around any part: first ${field} as plain text, exactly as it should appear, with every backslash written once. Then one line holding only ${META_SEPARATOR}. Then one JSON object with the other fields. Nothing comes after the JSON.`
    : `Answer with ${field} as plain text and nothing else: no JSON, no code fence, no comment before or after it. Never write the line ${META_SEPARATOR}.`;
}

/** The whole answer is wrapped in one code fence. The fence goes, and a fence inside the text means the text is not wrapped. */
function unfence(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length < 3 || !/^```[\w-]*\s*$/.test(lines[0]) || lines.at(-1)!.trim() !== '```') return text;
  const inner = lines.slice(1, -1);
  return inner.some((l) => /^```/.test(l)) ? text : inner.join('\n');
}

/**
 * The parser for `runRole`'s `parse` option. The answer is the text, then a line holding only META_SEPARATOR, then a JSON
 * object that must satisfy `meta`; the result has the metadata and the text in `field`. Without `meta` the whole answer is the
 * text. The text is not cleaned here beyond what runRole does (terminal codes, control bytes, tool markup), except that
 * Markdown gets its unknown function names rewritten (`\cotan`). A line break in it is a line break. The metadata gets the
 * usual sanitising for JSON strings. The separator is searched from the end, so a text that mentions it earlier is read whole.
 */
export function bodyParser<K extends string, M extends object = Record<never, never>>(
  field: K,
  kind: 'markdown' | 'code',
  meta?: z.ZodType<M>,
): (text: string) => ParseResult<M & Record<K, string>> {
  const raw = meta ? rawJsonSchema(meta) : undefined;
  return (text) => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const at = lines.findLastIndex((l) => l.trim() === META_SEPARATOR);
    let fields: M = {} as M;
    let body: string;
    if (!meta) {
      if (at >= 0) return { ok: false, problem: `The answer has a line ${META_SEPARATOR}, which this answer must not have. Write the text alone.` };
      body = text;
    } else {
      if (at < 0) return { ok: false, problem: `The line ${META_SEPARATOR} is missing. Write the text, then a line holding only ${META_SEPARATOR}, then one JSON object with the other fields.` };
      body = lines.slice(0, at).join('\n');
      let value: unknown;
      try {
        value = parseJsonAnswer(lines.slice(at + 1).join('\n'));
      } catch (err) {
        return { ok: false, problem: `The JSON after ${META_SEPARATOR} could not be read. ${err instanceof Error ? err.message : String(err)}` };
      }
      const parsed = meta.safeParse(sanitizeModelValue(dropOptionalNulls(value, raw!), raw));
      if (!parsed.success) return { ok: false, problem: `The JSON after ${META_SEPARATOR} does not fit:\n${describeIssues(parsed.error)}` };
      fields = parsed.data;
    }
    body = unfence(body).trim();
    if (!body) return { ok: false, problem: meta ? `There is no text before ${META_SEPARATOR}.` : 'The answer is empty.' };
    return { ok: true, data: { ...fields, [field]: kind === 'markdown' ? rewriteLatexNames(body) : body } as M & Record<K, string> };
  };
}
