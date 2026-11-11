import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { META_SEPARATOR, bodyParser } from './body.ts';

const meta = z.object({ summary: z.string(), figures: z.array(z.object({ key: z.string(), expr: z.string().nullable().optional() })) });
const parse = bodyParser('markdown', 'markdown', meta);
const answer = (body: string, json = '{"figures": [], "summary": "Riassunto."}') => `${body}\n${META_SEPARATOR}\n${json}`;

const ok = (r: ReturnType<typeof parse>) => {
  assert.equal(r.ok, true, r.ok ? '' : r.problem);
  return (r as { ok: true; data: { markdown: string; summary: string; figures: unknown[] } }).data;
};

test('the text before the separator is the body and the JSON after it carries the other fields', () => {
  const data = ok(parse(answer('Primo paragrafo.\n\nSecondo.')));
  assert.deepEqual(data, { figures: [], summary: 'Riassunto.', markdown: 'Primo paragrafo.\n\nSecondo.' });
});

test('a row that starts with i or u, \\nu, \\neq and \\theta come through as the model wrote them', () => {
  const body = 'Per la maglia:\n\n$$\n\\begin{aligned}\ni_1 &= \\frac{V}{R} \\\\\nu_2 &= R i_1\n\\end{aligned}\n$$\n\nCon $\\nu \\neq \\theta$, $\\beta$ e $\\tau$.\n\n$$\na = b\nu_1 = c\n$$';
  assert.equal(ok(parse(answer(body))).markdown, body);
});

test('a real line break before u stays a line break', () => {
  const body = '$$\nx = 1\nu = 2\n$$';
  assert.equal(ok(parse(answer(body))).markdown, body);
});

test('the word META and a JSON object in the text do not confuse the parser', () => {
  const body = 'Il tag META non è un separatore, e nemmeno <<<META>>> dentro una riga.\n\nEsempio: {"summary": "falso", "figures": []}\n\n{"summary": "anche questo", "figures": [{"key": "x"}]}';
  const data = ok(parse(answer(body)));
  assert.equal(data.markdown, body);
  assert.equal(data.summary, 'Riassunto.');
  assert.deepEqual(data.figures, []);
});

test('the last separator line splits, so a text that holds the line itself is read to the end', () => {
  const body = 'Prima.\n<<<META>>>\nDopo.';
  assert.equal(ok(parse(answer(body))).markdown, body);
});

test('function names KaTeX lacks are rewritten in the body, and the metadata is sanitised as JSON strings are', () => {
  const data = ok(parse(answer('Vale $\\cotan x$.', '{"figures": [], "summary": "Riassunto con \\u001b[1mcodice\\u001b[0m."}')));
  assert.equal(data.markdown, 'Vale $\\operatorname{cotan} x$.');
  assert.equal(data.summary, 'Riassunto con codice.');
});

test('the body keeps CRLF line ends as plain line ends and loses a code fence around the whole answer', () => {
  assert.equal(ok(parse(answer('Uno.\r\n\r\nDue.'))).markdown, 'Uno.\n\nDue.');
  assert.equal(ok(parse(answer('```markdown\nUno.\n\nDue.\n```'))).markdown, 'Uno.\n\nDue.');
  const inner = 'Uno.\n\n```\ncodice\n```\n\nDue.';
  assert.equal(ok(parse(answer(inner))).markdown, inner, 'a fence inside the text is not a wrapper');
});

test('a missing separator, bad JSON, wrong fields and an empty body each give a clear problem', () => {
  const problem = (text: string) => {
    const r = parse(text);
    assert.equal(r.ok, false);
    return (r as { problem: string }).problem;
  };
  assert.match(problem('Solo testo, senza metadati.'), /<<<META>>> is missing/);
  assert.match(problem(`Testo.\n${META_SEPARATOR}\nnon è JSON`), /JSON after <<<META>>> could not be read/);
  assert.match(problem(`Testo.\n${META_SEPARATOR}\n{"figures": []}`), /summary/);
  assert.match(problem(`\n${META_SEPARATOR}\n{"figures": [], "summary": "s"}`), /no text before/);
});

test('metadata nulls for optional fields are dropped before validation', () => {
  const data = ok(parse(answer('Testo.', '{"figures": [{"key": "a", "expr": null}], "summary": "s"}')));
  assert.deepEqual(data.figures, [{ key: 'a' }]);
});

test('code keeps every backslash, tab and line break, and gets no KaTeX rewrite', () => {
  const code = "A = [2 1; 1 3];\nb = [3; 5];\nx = A\\b;\nfprintf('x = %g\\n', x(1));\ny = A\\C;\n\tz = 1;";
  const r = bodyParser('code', 'code', z.object({ title: z.string() }))(`${code}\n${META_SEPARATOR}\n{"title": "t"}`);
  assert.deepEqual(r, { ok: true, data: { title: 't', code } });
});

test('without metadata the answer is the text alone, and the separator line is refused', () => {
  const plain = bodyParser('markdown', 'markdown');
  assert.deepEqual(plain('Testo $\\nu$ corretto.\n'), { ok: true, data: { markdown: 'Testo $\\nu$ corretto.' } });
  const r = plain(`Testo.\n${META_SEPARATOR}\n{}`);
  assert.equal(r.ok, false);
  assert.equal(plain('  \n').ok, false);
});
