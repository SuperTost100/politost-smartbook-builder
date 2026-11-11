// Child process for the schemdraw renderer. Started by sandbox.ts, never imported. See schemdraw.ts for the contract.
// argv: <pyodide folder> <wheel folder>. stdin: { "wheels": ["file.whl", ...], "prelude": "<python that defines __sb_render>", "source": "<the drawing code>" }.
// stdout: one JSON line, { "ok": true, "json": "<what __sb_render returned>" } or { "ok": false, "error": "..." }.
import { constants, readFileSync } from 'node:fs';

// Emscripten's NODEFS asks for fs constants through process.binding, which the permission model refuses; hand it the public ones.
process.binding = (name) => { if (name === 'constants') return { fs: constants }; throw new Error('not available'); };
const [dir, wheelDir] = process.argv.slice(2);
const input = JSON.parse(await new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => resolve(s));
}));
let sent = Promise.resolve();
const reply = (o) => { sent = new Promise((done) => process.stdout.write(`${JSON.stringify(o)}\n`, () => done())); };
try {
  const { loadPyodide } = await import(`${dir}/pyodide.mjs`);
  const py = await loadPyodide({ indexURL: dir, jsglobals: {}, stdout: () => {}, stderr: () => {} });
  for (const wheel of input.wheels) py.unpackArchive(new Uint8Array(readFileSync(`${wheelDir}/${wheel}`)), 'wheel');
  try {
    py.runPython(input.prelude);
    py.globals.set('__sb_source', input.source);
    py.runPython('__sb_json = __sb_render(__sb_source)');
    reply({ ok: true, json: py.globals.get('__sb_json') });
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e).slice(-6000) });
  }
} catch (e) {
  reply({ ok: false, setup: true, error: `Pyodide could not start: ${String((e && e.message) || e).slice(0, 500)}` });
}
// A write to a pipe is not finished when write() returns, and process.exit() drops what is still waiting, so the answer was
// lost whenever the parent read late (a busy machine). The exit waits for the write.
await sent;
process.exit(0);
