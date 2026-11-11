// Child process for the Typst renderer. Started by sandbox.ts, never imported. See typst.ts for the contract.
// argv: <compiler entry file> <workspace folder>. stdin: { "mainFile": "<path>" }. stdout: one JSON line.
import { createRequire } from 'node:module';

const [compilerEntry, workspace] = process.argv.slice(2);
const input = JSON.parse(await new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => resolve(s));
}));
const reply = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
try {
  const { NodeCompiler } = createRequire(compilerEntry)(compilerEntry);
  const compiler = NodeCompiler.create({ workspace });
  const result = compiler.compile({ mainFilePath: input.mainFile });
  if (result.hasError()) reply({ ok: false, diagnostics: compiler.fetchDiagnostics(result.takeDiagnostics()) });
  else reply({ ok: true, svg: compiler.plainSvg(result.result) });
} catch (e) {
  reply({ ok: false, diagnostics: [{ severity: 1, message: String((e && e.message) || e).slice(0, 1000), package: '', path: '', range: null }] });
}
process.exit(0);
