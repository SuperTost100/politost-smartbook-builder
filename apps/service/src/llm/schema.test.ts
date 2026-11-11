import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { dropOptionalNulls, fillAbsentNulls, parseJsonAnswer, rawJsonSchema, toProviderSchema } from './schema.ts';

type Json = Record<string, unknown>;

function everyObject(node: unknown, visit: (o: Json) => void) {
  if (Array.isArray(node)) return node.forEach((n) => everyObject(n, visit));
  if (typeof node !== 'object' || node === null) return;
  const o = node as Json;
  if (o.type === 'object' || o.properties) visit(o);
  for (const v of Object.values(o)) everyObject(v, visit);
}

const sample = z.object({
  title: z.string(),
  note: z.string().optional(),
  count: z.number().default(3),
  sections: z.array(z.object({ id: z.string(), body: z.string().optional(), tags: z.array(z.string()).default([]) })),
  meta: z.object({ lang: z.enum(['it', 'en']), deep: z.object({ x: z.number().optional() }) }),
  maybe: z.string().nullable(),
});

test('provider schema: additionalProperties false and every property required on every object', () => {
  const schema = toProviderSchema(sample);
  let seen = 0;
  everyObject(schema, (o) => {
    seen++;
    assert.equal(o.additionalProperties, false, JSON.stringify(o));
    const props = Object.keys(o.properties as Json);
    assert.deepEqual([...(o.required as string[])].sort(), props.sort());
  });
  assert.ok(seen >= 4, `expected nested objects, saw ${seen}`);
  assert.equal(schema.$schema, undefined);
});

test('provider schema: optional and defaulted fields become nullable', () => {
  const schema = toProviderSchema(sample) as { properties: Record<string, Json> };
  const nullableOf = (s: Json) => ((s.anyOf as Json[] | undefined)?.some((v) => v.type === 'null') || (Array.isArray(s.type) && s.type.includes('null'))) || undefined;
  assert.ok(nullableOf(schema.properties.note));
  assert.ok(nullableOf(schema.properties.count));
  assert.ok(nullableOf(schema.properties.maybe));
  assert.equal(nullableOf(schema.properties.title), undefined);
  assert.equal(JSON.stringify(schema).includes('"default"'), false);
});

test('dropOptionalNulls lets zod apply defaults and accept absent optionals', () => {
  const raw = rawJsonSchema(sample);
  const answer = {
    title: 'T', note: null, count: null,
    sections: [{ id: 'a', body: null, tags: null }],
    meta: { lang: 'it', deep: { x: null } },
    maybe: null,
  };
  const parsed = sample.safeParse(dropOptionalNulls(answer, raw));
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.count, 3);
  assert.deepEqual(parsed.data.sections[0].tags, []);
  assert.equal(parsed.data.maybe, null);
  assert.equal(parsed.data.note, undefined);
});

test('parseJsonAnswer tolerates fences and surrounding prose', () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('Ecco:\n```\n{"a": [1,2]}\n```\nFatto.'), { a: [1, 2] });
  assert.deepEqual(parseJsonAnswer('Sure! {"a": "}"} bye'), { a: '}' });
  assert.throws(() => parseJsonAnswer('no json here'));
});

test('tuples become plain arrays that strict validators accept', async () => {
  const { z } = await import('zod');
  const { toProviderSchema } = await import('./schema.ts');
  const out = JSON.stringify(toProviderSchema(z.object({ range: z.tuple([z.number(), z.number()]) })));
  assert.ok(!out.includes('prefixItems'), out);
  assert.ok(out.includes('"items":{"type":"number"}'), out);
});

test('every model field that carries code is marked, and the marker never reaches the provider schema', async () => {
  const { ideSchema, graphSchema } = await import('../pipeline/prompts.ts');
  const { figureSchema } = await import('../figures/materialize.ts');
  const { sanitizeModelValue } = await import('@smartbuilder/content');
  const ide = rawJsonSchema(ideSchema);
  const out = sanitizeModelValue({ id: 'a', title: 'b', description: 'c', code: 'x = A\\C;', expectedOutput: 'd' }, ide) as { code: string };
  assert.equal(out.code, 'x = A\\C;');
  const graph = sanitizeModelValue({ functions: [{ fn: 'x\\Q', label: 'l' }] }, rawJsonSchema(graphSchema)) as { functions: { fn: string }[] };
  assert.equal(graph.functions[0].fn, 'x\\Q');
  const fig = rawJsonSchema(figureSchema);
  const figOut = sanitizeModelValue({ structure: { smiles: 'C/C=C\\C' }, plot: { functions: [{ expr: 'x\\C' }] } }, fig) as { structure: { smiles: string }; plot: { functions: { expr: string }[] } };
  assert.equal(figOut.structure.smiles, 'C/C=C\\C');
  assert.equal(figOut.plot.functions[0].expr, 'x\\C');
  assert.ok(!JSON.stringify(toProviderSchema(ideSchema)).includes('x-code'));
});

test('fillAbsentNulls turns a left-out nullable key into null, at any depth, and leaves required and optional keys alone', () => {
  const shape = z.object({ name: z.string(), label: z.string().nullable(), spec: z.object({ unit: z.string().nullable(), n: z.number() }).nullable(), more: z.string().optional() });
  const raw = rawJsonSchema(z.array(shape));
  const filled = fillAbsentNulls([{ name: 'a', spec: { n: 1 } }, { name: 'b' }], raw);
  assert.deepEqual(filled, [{ name: 'a', label: null, spec: { n: 1, unit: null } }, { name: 'b', label: null, spec: null }]);
  assert.equal(z.array(shape).safeParse(filled).success, true);
  assert.equal(z.array(shape).safeParse([{ name: 'a' }]).success, false, 'without it the schema refuses the answer');
});
