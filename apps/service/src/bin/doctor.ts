// Prints what the builder can use on this computer and how to fix what is missing.
import { ensureFigurePackages, missingFigurePackages } from '../../../../scripts/fetch-figure-packages.mjs';
import { parseArgs } from '../config.ts';
import { createContext } from '../context.ts';
import { getConnections } from '../llm/index.ts';

const ctx = createContext(parseArgs(process.argv.slice(2)));
const c = await getConnections(ctx);
const mark = (ok: boolean | null) => (ok ? 'ok ' : ok === null ? ' ? ' : 'no ');
const [major, minor] = process.versions.node.split('.').map(Number);
console.log(`[${mark(major > 22 || (major === 22 && minor >= 13))}] Node ${process.versions.node} (needs 22.13 or newer)`);
console.log(`[ok ] Data folder ${c.dataDir}`);
for (const p of c.providers) {
  const state = !p.installed ? 'not installed' : p.signedIn === false ? 'installed, not signed in' : `installed${p.version ? ` (${p.version})` : ''}, ${p.models.length} models`;
  console.log(`[${mark(p.installed && p.signedIn !== false)}] ${p.label}: ${state}${p.error ? ` — ${p.error}` : ''}`);
}
const nb = c.notebooklm;
console.log(`[${mark(nb.installed && nb.signedIn)}] NotebookLM: ${!nb.installed ? 'nlm is not installed (uv tool install notebooklm-mcp-cli)' : nb.signedIn ? `signed in as ${nb.account ?? 'unknown'}` : 'not signed in — see docs/SETUP.md'}`);
console.log(`[${mark(c.libreoffice.installed)}] LibreOffice: ${c.libreoffice.installed ? c.libreoffice.path : 'not found (only needed for Word and PowerPoint files)'}`);
// Drawn figures need the pinned Typst packages and Python wheels. Fetch them here when they are missing, like `npm start` does.
let figureProblem = '';
if (missingFigurePackages().length) {
  try {
    await ensureFigurePackages();
  } catch (e) {
    figureProblem = e instanceof Error ? e.message : String(e);
  }
}
const stillMissing = missingFigurePackages().length;
console.log(`[${mark(stillMissing === 0)}] Figure packages: ${stillMissing === 0 ? 'installed (.figure-packages)' : `${stillMissing} missing${figureProblem ? ` (${figureProblem})` : ''}. Run: npm run figure-packages`}`);
ctx.db.close();
