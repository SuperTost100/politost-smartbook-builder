import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { dropOptionalNulls, parseJsonAnswer, rawJsonSchema, toProviderSchema } from './schema.ts';

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
