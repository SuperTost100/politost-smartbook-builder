// Downloads the pinned packages that the drawn-figure renderers need, so that nothing is downloaded while a figure renders.
//
//   node scripts/fetch-figure-packages.mjs            download what is missing, fail if anything cannot be verified
//   node scripts/fetch-figure-packages.mjs --soft     same, but a failure only prints a warning (used by `npm start`)
//   node scripts/fetch-figure-packages.mjs --check    only report what is missing
//
// Everything lands in `.figure-packages/` at the repo root (git-ignored). Each download is checked against the SHA-256
// written below before it is unpacked, so a changed or tampered file is refused. The renderers in
// apps/service/src/figures/drawing read from this folder and nothing else.
//
// To upgrade a package: change its version and hash here, run the script, then run the service tests, because the
// renderer snapshot test notices when the drawing output changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIGURE_PACKAGES_DIR = join(root, '.figure-packages');

// Typst packages from https://packages.typst.org/preview. `allowed` marks the ones a model may import. The others are
// dependencies of those, kept offline so the allowed ones load. Every version is one that the bundled compiler accepts
// (Typst 0.14.2 inside @myriaddreamin/typst-ts-node-compiler 0.7.0): cetz 0.5.3 needs Typst 0.15 and is not used.
// Licences: cetz and cetz-plot LGPL-3.0-or-later, oxifmt MIT-0 or MIT/Apache-2.0, elembic MIT/Apache-2.0, the rest MIT.
export const TYPST_PACKAGES = [
  { name: 'cetz', version: '0.5.2', allowed: true, sha256: '77cf8490114ae04c6e665a11efa691d284a0cadb9719771b5708c1197292f23f' },
  { name: 'cetz-plot', version: '0.1.4', allowed: true, sha256: '13170258be0761701e57141081e1f6f029bc8967988f549a3b089289a1347936' },
  { name: 'zap', version: '0.6.0', allowed: true, sha256: '2eadf408a4c4ef0764e39a24485e4b84d917b994db7fa51b108ef59f05ac0299' },
  { name: 'fletcher', version: '0.5.8', allowed: true, sha256: 'a61883a4af4ca923a37c597900e674f40dad3f7bde3f2a3d8fe8042e6ca8a66b' },
  { name: 'lilaq', version: '0.6.0', allowed: true, sha256: '41e7839e9e4eaf5c0b5ec93f23d387233bce439fe226326b06c2fa01f2fc251f' },
  { name: 'finite', version: '0.5.1', allowed: true, sha256: '4d17271b35425f5cf1cf0dc14b451ea6765dfb8ecdb626d0181b9238ec71e7fd' },
  // Dependencies (fletcher uses cetz 0.3.4, finite uses cetz 0.4.2, cetz uses oxifmt, lilaq uses the rest).
  { name: 'cetz', version: '0.4.2', allowed: false, sha256: 'e1d2f121b166f1520fc529cad834e2ca5e0b6bcab6816e1d0e07d70836aa0b59' },
  { name: 'cetz', version: '0.3.4', allowed: false, sha256: '4f4b5a8d311d519e749940a766fe50521e40c041129e1c91af0c42e61f307514' },
  { name: 'oxifmt', version: '1.0.0', allowed: false, sha256: '7d17a1fc8ad01740ec3cb2b03c7360a4225ff9318e5710765fa98ea6fd59594f' },
  { name: 'oxifmt', version: '0.2.1', allowed: false, sha256: '16fac2923032c59727de01e84d42cac45e8790da28df56effca49f4de41b09d9' },
  { name: 'elembic', version: '1.1.1', allowed: false, sha256: 'e3a8ec6b2ad5f43d93ae31dd5742de7256c57719675636179cd818f26ca7bb88' },
  { name: 'komet', version: '0.1.0', allowed: false, sha256: '3fd7d065f670de088a170603069788039ed52614c9fd81d5f7c923bedb355786' },
  { name: 'komet', version: '0.2.0', allowed: false, sha256: '0ee6b4760e365d0322c4200944a43d73a6b9a981f5b47eadc44bbee4bbd66e50' },
  { name: 'suiji', version: '0.5.1', allowed: false, sha256: '58a7b19fc6e3419e03a189f32cf86cb7d7e3522abe3e463435c31f3fb21f5aa3' },
  { name: 'tiptoe', version: '0.4.0', allowed: false, sha256: '1be772c335902a7554b5164a5a4145bfd886867ac1b26478b74d5e4bf9eb6b3f' },
  { name: 'zero', version: '0.6.1', allowed: false, sha256: '87ffec0d591551ab5d1465c40582e4441876dd8f70ef88a2d577297f5977768f' },
  { name: 'diagraph-layout', version: '0.0.1', allowed: false, sha256: '0bd85571728596beacb6004f36cf52d14753ac9acfd4d1d4717190765146ece1' },
  { name: 't4t', version: '0.4.3', allowed: false, sha256: '53338a3a37482749af41d745b8e7bed86027c064501fb4beb24307a63255d1a7' },
  { name: 'valkyrie', version: '0.2.1', allowed: false, sha256: 'e17247077f6c0eb51d11f7a502c2b1f2ce3bec582596a309bbc1b00a7c04f394' },
];

// Pure-Python wheels for the Pyodide that the service already ships. All MIT. ziamath bundles the STIX Two Math font
// (SIL OFL 1.1) and ziafont bundles DejaVu Sans: schemdraw uses them to draw its text as outlines.
export const PYTHON_WHEELS = [
  { file: 'schemdraw-0.23-py3-none-any.whl', sha256: 'b6af33cf175fb7692ed3f71b5d2702c400e009ae26efe76c6fa4f85d34e0fac5', url: 'https://files.pythonhosted.org/packages/97/f6/7efb3798e44868e09e8ce8a4329ac21acd134a3d5fd59792f97a7feccc2a/schemdraw-0.23-py3-none-any.whl' },
  { file: 'ziamath-0.13-py3-none-any.whl', sha256: '67a9b9714101fc90c2d6d0328e578f3ac311fb007644f2bbb9314ba2bc1c1459', url: 'https://files.pythonhosted.org/packages/f8/0d/6e029024b14f3da85408601fd7607eff8d84081d1934b64785373ecb9be5/ziamath-0.13-py3-none-any.whl' },
  { file: 'ziafont-0.11-py3-none-any.whl', sha256: 'b62132be3da9667a80d048ab5498f107e49761722b69965788c2c747a38e7373', url: 'https://files.pythonhosted.org/packages/0c/ea/c5d6e745660b1d95fd257e9fc7f906541ede9bb2edf2ee8fdb4bc151c129/ziafont-0.11-py3-none-any.whl' },
  { file: 'latex2mathml-3.81.1-py3-none-any.whl', sha256: 'c337668441b71c819b6733905a8058ba9a9d767bae11a0c5fdacb3aff31361bd', url: 'https://files.pythonhosted.org/packages/07/30/b8bcfb01a2514cb7554a048ed52883de276e66d757c3cc535a3c29eb9e98/latex2mathml-3.81.1-py3-none-any.whl' },
];

const typstUrl = (p) => `https://packages.typst.org/preview/${p.name}-${p.version}.tar.gz`;
const typstDirOf = (p) => join(FIGURE_PACKAGES_DIR, 'typst', 'preview', p.name, p.version);
const wheelPathOf = (w) => join(FIGURE_PACKAGES_DIR, 'python', w.file);
const ledgerFile = join(FIGURE_PACKAGES_DIR, 'verified.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readLedger = () => {
  try { return JSON.parse(readFileSync(ledgerFile, 'utf8')); } catch { return {}; }
};

function items() {
  return [
    ...TYPST_PACKAGES.map((p) => ({ key: `typst/${p.name}-${p.version}`, sha256: p.sha256, present: () => existsSync(join(typstDirOf(p), 'typst.toml')) })),
    ...PYTHON_WHEELS.map((w) => ({ key: `python/${w.file}`, sha256: w.sha256, present: () => existsSync(wheelPathOf(w)) })),
  ];
}

/** What is missing from `.figure-packages/` (an empty list means the renderers can run). */
export function missingFigurePackages() {
  const ledger = readLedger();
  return items().filter((i) => ledger[i.key] !== i.sha256 || !i.present()).map((i) => i.key);
}

/** Reads a gzip-compressed tar archive into `[path, bytes]` pairs. Only plain files are returned. */
export function untar(gz) {
  const tar = gunzipSync(gz);
  const files = [];
  let pos = 0;
  let longName = null;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from, len) => header.toString('utf8', from, from + len).replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const prefix = text(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longName = null;
    const body = tar.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') files.push([name, Buffer.from(body)]);
    // Directories, links, and pax headers (type 'x' or 'g') carry nothing the packages need.
  }
  return files;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function installTypst(p, bytes) {
  const target = typstDirOf(p);
  const stage = `${target}.partial`;
  rmSync(stage, { recursive: true, force: true });
  for (const [name, body] of untar(bytes)) {
    const rel = normalize(name.replace(/^\.\//, ''));
    // A package must unpack inside its own folder: refuse absolute paths and "..".
    if (rel.startsWith('..') || resolve(stage, rel).indexOf(stage + sep) !== 0) throw new Error(`${p.name} ${p.version} contains the path ${name}`);
    mkdirSync(dirname(resolve(stage, rel)), { recursive: true });
    writeFileSync(resolve(stage, rel), body);
  }
  const toml = readFileSync(join(stage, 'typst.toml'), 'utf8');
  if (!new RegExp(`^name\\s*=\\s*"${p.name}"`, 'm').test(toml) || !new RegExp(`^version\\s*=\\s*"${p.version.replace(/\./g, '\\.')}"`, 'm').test(toml)) {
    throw new Error(`${p.name} ${p.version}: typst.toml names another package`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(stage, target);
}

/** Downloads and verifies whatever is missing. Throws on the first file whose hash differs. Returns the keys it fetched. */
export async function ensureFigurePackages({ log = () => {} } = {}) {
  mkdirSync(FIGURE_PACKAGES_DIR, { recursive: true });
  const ledger = readLedger();
  const missing = new Set(missingFigurePackages());
  const fetched = [];
  const record = (key, hash) => {
    ledger[key] = hash;
    writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);
    fetched.push(key);
  };
  for (const p of TYPST_PACKAGES) {
    const key = `typst/${p.name}-${p.version}`;
    if (!missing.has(key)) continue;
    log(`Downloading Typst package ${p.name} ${p.version}`);
    const bytes = await download(typstUrl(p));
    if (sha256(bytes) !== p.sha256) throw new Error(`Typst package ${p.name} ${p.version} does not match its pinned SHA-256 (got ${sha256(bytes)}).`);
    installTypst(p, bytes);
    record(key, p.sha256);
  }
  for (const w of PYTHON_WHEELS) {
    const key = `python/${w.file}`;
    if (!missing.has(key)) continue;
    log(`Downloading Python wheel ${w.file}`);
    const bytes = await download(w.url);
    if (sha256(bytes) !== w.sha256) throw new Error(`Python wheel ${w.file} does not match its pinned SHA-256 (got ${sha256(bytes)}).`);
    mkdirSync(dirname(wheelPathOf(w)), { recursive: true });
    writeFileSync(wheelPathOf(w), bytes);
    record(key, w.sha256);
  }
  return fetched;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const soft = args.includes('--soft');
  const missing = missingFigurePackages();
  if (args.includes('--check')) {
    console.log(missing.length ? `Missing figure packages: ${missing.join(', ')}` : 'Figure packages are complete.');
    process.exit(missing.length ? 1 : 0);
  }
  if (missing.length) {
    try {
      const done = await ensureFigurePackages({ log: (m) => console.log(m) });
      console.log(`Figure packages ready (${done.length} downloaded) in ${FIGURE_PACKAGES_DIR}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`${soft ? 'Warning' : 'Error'}: could not fetch the figure packages: ${why}`);
      console.error('Drawn figures stay off until `npm run figure-packages` succeeds.');
      process.exit(soft ? 0 : 1);
    }
  }
}
