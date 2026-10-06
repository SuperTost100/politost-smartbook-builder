// JSON schema derivation and answer parsing for provider calls.
import { z } from 'zod';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Derive the JSON schema sent to providers from a zod schema.
 * Codex and the Anthropic API reject objects without `additionalProperties: false` and with optional properties,
 * so every object gets additionalProperties:false, every property is required, and optional fields become nullable.
 * Feed the model's answer through `dropOptionalNulls` with the schema from `rawJsonSchema` before validating.
 */
export function toProviderSchema(schema: z.ZodType): Json {
  return strictify(rawJsonSchema(schema));
}

/** The schema as zod describes it for input, before strict post-processing. */
export function rawJsonSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
}

/** Applies the strict-mode rules to any JSON schema. Returns a new object. */
export function strictify(schema: Json): Json {
  const copy = structuredClone(schema);
  delete copy.$schema;
  return walk(copy) as Json;
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'default' || k === 'propertyNames' || k === '$schema') continue;
    if (k === 'properties' && isObj(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]));
    } else if (k === 'additionalProperties' && isObj(v)) {
      out.additionalProperties = walk(v);
    } else if (k === '$defs' || k === 'definitions') {
      out[k] = isObj(v) ? Object.fromEntries(Object.entries(v).map(([dk, dv]) => [dk, walk(dv)])) : v;
    } else if (k === 'enum' || k === 'const' || k === 'required' || k === 'examples') {
      out[k] = v;
    } else {
      out[k] = walk(v);
    }
  }
  if (isObj(out.properties)) {
    const keys = Object.keys(out.properties);
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const key of keys) {
      if (!required.has(key)) (out.properties as Json)[key] = nullable((out.properties as Json)[key]);
    }
    out.required = keys;
    out.additionalProperties = false;
  } else if (out.type === 'object' && !isObj(out.additionalProperties)) {
    // An object with no declared properties: nothing to fill in, nothing extra allowed.
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  return out;
}

function nullable(schema: unknown): unknown {
  if (!isObj(schema)) return schema;
  const variants = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) || variants?.some((v) => isObj(v) && v.type === 'null')) return schema;
  return { anyOf: [schema, { type: 'null' }] };
}

/** Removes null values the model sent for optional properties so zod sees them as absent (defaults then apply). */
export function dropOptionalNulls(value: unknown, original: Json): unknown {
  return strip(value, original);
}

function objectSchema(s: unknown): Json | undefined {
  if (!isObj(s)) return undefined;
  if (isObj(s.properties)) return s;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const arr = s[key];
    if (Array.isArray(arr)) {
      const found = arr.map(objectSchema).find(Boolean);
      if (found) return found;
    }
  }
  return undefined;
}

function itemSchema(s: unknown): unknown {
  if (!isObj(s)) return undefined;
  if (s.items !== undefined) return s.items;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const arr = s[key];
    if (Array.isArray(arr)) {
      const found = arr.map(itemSchema).find((x) => x !== undefined);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function strip(v: unknown, s: unknown): unknown {
  if (Array.isArray(v)) {
    const items = itemSchema(s);
    return v.map((x) => strip(x, items));
  }
  if (!isObj(v)) return v;
  const sch = objectSchema(s);
  if (!sch) return v;
  const props = sch.properties as Json;
  const required = new Set(Array.isArray(sch.required) ? (sch.required as string[]) : []);
  const out: Json = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null && k in props && !required.has(k)) continue;
    out[k] = strip(val, props[k] ?? (isObj(sch.additionalProperties) ? sch.additionalProperties : undefined));
  }
  return out;
}

/** Parses a JSON answer from model text. Tolerates a ```json fence and prose around the object. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence) attempts.push(fence[1].trim());
  const block = firstBalanced(trimmed);
  if (block) attempts.push(block);
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`The answer is not valid JSON: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Short, model-readable list of validation problems. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}
