import type { BookOptions, BookOptionsPatch, ProjectInput } from '@smartbuilder/domain';

/** The whole number written in `text` when it lies from `lo` to `hi`, otherwise null: empty text, decimals and words are refused. */
export function wholeNumberIn(text: string, lo: number, hi: number): number | null {
  if (!/^\s*-?\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
}

/** The author list as the form saves it: names split on commas, semicolons and new lines. */
export const splitAuthors = (text: string) => text.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean);

export type SetupValues = Omit<ProjectInput, 'options'> & { options: BookOptions };
export type SetupPatch = Partial<Omit<ProjectInput, 'options'>> & { options?: BookOptionsPatch };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields the author changed since the form loaded, and inside `options` only the changed keys. The service merges the
 * options key by key, so a form opened before another tab's save no longer writes that tab's values back.
 */
export function changedFields(loaded: SetupValues, current: SetupValues): SetupPatch {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(current) as (keyof SetupValues)[]) {
    if (k !== 'options' && !same(loaded[k], current[k])) patch[k] = current[k];
  }
  const options: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(loaded.options), ...Object.keys(current.options)]) as Set<keyof BookOptions>) {
    // A saved book keeps its area unless the patch says null, so going back to Automatic has to be sent as null.
    if (!same(loaded.options[k], current.options[k])) options[k] = current.options[k] ?? null;
  }
  if (Object.keys(options).length) patch.options = options;
  return patch as SetupPatch;
}
