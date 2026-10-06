import { strToU8, zipSync } from 'fflate';
import { readPtsb } from '@politost/content-core';
import type { CompiledBook } from './types.ts';

export const PTSB_PRODUCER = 'politost-smart-builder/0.1.0';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Plain ZIP .ptsb with ptsb.json { encrypted: false, access: 'public' }. */
export function packPtsb(book: CompiledBook, opts: { createdAt?: string } = {}): Uint8Array {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const entries: Record<string, Uint8Array> = {
    'ptsb.json': strToU8(
      `${JSON.stringify({ formatVersion: 1, packageType: 'smartbook', encrypted: false, access: 'public', createdAt, producer: PTSB_PRODUCER }, null, 2)}\n`,
    ),
  };
  for (const path of Object.keys(book.files).sort()) {
    const v = book.files[path];
    entries[path] = typeof v === 'string' ? enc.encode(v) : v;
  }
  // A fixed modification time keeps the archive reproducible for the same createdAt.
  const t = Date.parse(createdAt);
  const mtime = Number.isFinite(t) && t >= Date.UTC(1980, 0, 1) ? new Date(t) : new Date(Date.UTC(2000, 0, 1));
  return zipSync(entries, { level: 6, mtime });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Reopen with content-core readPtsb and compare against the compiled book. */
export function readBackPtsb(bytes: Uint8Array, book: CompiledBook): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  let warnings: string[] = [];
  let bundle;
  try {
    bundle = readPtsb(bytes);
  } catch (e) {
    return { ok: false, errors: [`readPtsb failed: ${(e as Error).message}`], warnings };
  }
  warnings = [...bundle.warnings];

  if (!bundle.manifest) errors.push('ptsb.json is missing');
  else {
    if (bundle.manifest.encrypted !== false) errors.push('ptsb.json: encrypted must be false');
    if (bundle.manifest.access !== 'public') errors.push(`ptsb.json: access is "${bundle.manifest.access}", expected "public"`);
    if (bundle.manifest.formatVersion !== 1) errors.push(`ptsb.json: formatVersion ${bundle.manifest.formatVersion}, expected 1`);
  }

  const asText = (v: string | Uint8Array | undefined) => (v === undefined ? undefined : typeof v === 'string' ? v : dec.decode(v));

  const expectedChapters = Object.keys(book.files).filter((p) => /^chapters\/.+\.md$/.test(p)).map((p) => p.slice('chapters/'.length)).sort();
  const gotChapters = Object.keys(bundle.chapterFiles).sort();
  if (expectedChapters.join('\n') !== gotChapters.join('\n')) {
    errors.push(`chapter files differ: expected [${expectedChapters.join(', ')}], got [${gotChapters.join(', ')}]`);
  }
  for (const name of expectedChapters) {
    if (name in bundle.chapterFiles && bundle.chapterFiles[name] !== asText(book.files[`chapters/${name}`])) {
      errors.push(`chapters/${name}: content differs after round trip`);
    }
  }

  const expectedAssets = Object.keys(book.files).filter((p) => p.startsWith('assets/')).sort();
  const gotAssets = Object.keys(bundle.assets).sort();
  if (expectedAssets.join('\n') !== gotAssets.join('\n')) {
    errors.push(`asset names differ: expected [${expectedAssets.join(', ')}], got [${gotAssets.join(', ')}]`);
  }
  for (const name of expectedAssets) {
    const orig = book.files[name];
    const got = bundle.assets[name];
    if (got && orig !== undefined) {
      const o = typeof orig === 'string' ? enc.encode(orig) : orig;
      if (!sameBytes(o, got)) errors.push(`${name}: bytes differ after round trip`);
    }
  }

  const textExtras: [string, string][] = [
    ['esercizi.md', bundle.eserciziRaw],
    ['esami.md', bundle.esamiRaw],
  ];
  for (const [name, got] of textExtras) {
    const orig = asText(book.files[name]);
    if (orig !== undefined && orig !== got) errors.push(`${name}: content differs after round trip`);
  }
  const jsonExtras: [string, unknown][] = [
    ['ide.json', bundle.ide],
    ['grafici.json', bundle.grafici],
  ];
  for (const [name, got] of jsonExtras) {
    const orig = asText(book.files[name]);
    if (orig !== undefined && JSON.stringify(JSON.parse(orig)) !== JSON.stringify(got)) errors.push(`${name}: content differs after round trip`);
  }
  const cfg = asText(book.files['smartbook.json']);
  if (cfg !== undefined) {
    try {
      if (JSON.stringify(JSON.parse(cfg)) !== JSON.stringify(bundle.config)) errors.push('smartbook.json: content differs after round trip');
    } catch {
      errors.push('smartbook.json: not valid JSON');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
