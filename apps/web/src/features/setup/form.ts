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

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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

/** The book as the form shows it, read the way the form saves it, so a field left alone compares equal. */
export function setupValues(p: Omit<ProjectInput, 'options'> & { options: Partial<BookOptions> }, defaults: BookOptions): SetupValues {
  // A stored "Doe, Jane" shows as two names and is sent only when the author edits the field.
  return { title: p.title.trim(), subject: p.subject.trim(), slug: p.slug, authors: splitAuthors(p.authors.join(', ')), language: p.language.trim(), audience: p.audience, goals: p.goals, options: { ...defaults, ...p.options } };
}

/** A field of the form: a top-level key, or `options.<key>`. */
export type FieldKey = Exclude<keyof SetupValues, 'options'> | `options.${keyof BookOptions}`;

export const fieldValue = (v: SetupValues | SetupPatch, key: FieldKey): unknown =>
  key.startsWith('options.') ? (v.options as Record<string, unknown> | undefined)?.[key.slice(8)] : (v as Record<string, unknown>)[key];

const keysOf = (v: SetupValues | SetupPatch): FieldKey[] => [
  ...Object.keys(v).filter((k) => k !== 'options') as FieldKey[],
  ...Object.keys(v.options ?? {}).map((k) => `options.${k}` as FieldKey),
];

export interface StaleField { key: FieldKey; stored: unknown; mine: unknown }

/**
 * What the stored book changed since the form loaded it. `stale` are the fields this form changed too, to another value,
 * which a save would overwrite without the author knowing. `settled` are fields this form changed to the value already
 * stored: nothing to ask and nothing to send. `refreshed` are the others, which the form can take over as they are.
 */
export function compareStored(loaded: SetupValues, stored: SetupValues, patch: SetupPatch): { stale: StaleField[]; settled: FieldKey[]; refreshed: FieldKey[] } {
  const mine = new Set(keysOf(patch));
  const eq = (a: unknown, b: unknown) => same(a ?? null, b ?? null);
  const moved = (k: FieldKey) => !eq(fieldValue(loaded, k), fieldValue(stored, k));
  const settled = [...mine].filter((k) => eq(fieldValue(stored, k), fieldValue(patch, k)));
  const stale = [...mine].filter((k) => moved(k) && !settled.includes(k)).map((key) => ({ key, stored: fieldValue(stored, key), mine: fieldValue(patch, key) }));
  const refreshed = [...new Set([...keysOf(loaded), ...keysOf(stored)])].filter((k) => !mine.has(k) && moved(k));
  return { stale, settled, refreshed };
}

/** `patch` without the given fields; an `options` left empty is dropped. */
export function withoutFields(patch: SetupPatch, keys: readonly FieldKey[]): SetupPatch {
  const out: Record<string, unknown> = { ...patch, ...(patch.options ? { options: { ...patch.options } } : {}) };
  for (const k of keys) {
    if (k.startsWith('options.')) delete (out.options as Record<string, unknown> | undefined)?.[k.slice(8)];
    else delete out[k];
  }
  if (out.options && Object.keys(out.options).length === 0) delete out.options;
  return out as SetupPatch;
}

/** `base` with the given fields taken from `from`. */
export function withFields(base: SetupValues, from: SetupValues, keys: readonly FieldKey[]): SetupValues {
  const out: SetupValues = { ...base, options: { ...base.options } };
  for (const k of keys) {
    if (k.startsWith('options.')) (out.options as Record<string, unknown>)[k.slice(8)] = fieldValue(from, k);
    else (out as Record<string, unknown>)[k] = fieldValue(from, k);
  }
  return out;
}
