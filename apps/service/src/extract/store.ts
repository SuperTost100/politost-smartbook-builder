import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ResourceKind } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId, now } from '../db/db.ts';
import { paths, toDataPath } from '../config.ts';
import { ExtractError } from './errors.ts';
import { safeFetch, type SafeFetchOptions } from './safe-fetch.ts';
import { htmlToMarkdown } from './html.ts';

const ROLES = ['theory', 'exercises', 'exams', 'mixed'];

const UNSUPPORTED =
  'This file type is not supported. Upload a PDF, a Word (.docx) or PowerPoint (.pptx) file, or a Markdown (.md) file.';

/** Names of the entries in a ZIP central directory, or null when the bytes are not a ZIP. */
export function zipEntryNames(buf: Buffer): string[] | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const n = buf.readUInt16LE(off + 28), x = buf.readUInt16LE(off + 30), c = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + n));
    off += 46 + n + x + c;
  }
  return names;
}

/** Decide the resource kind from content, never from the extension alone. Throws ExtractError for anything unsupported. */
export function detectKind(filename: string, bytes: Buffer): ResourceKind {
  if (!bytes.length) throw new ExtractError('The file is empty.');
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  const zip = zipEntryNames(bytes);
  if (zip) {
    if (zip.includes('[Content_Types].xml') && zip.some((n) => n.startsWith('word/'))) return 'docx';
    if (zip.includes('[Content_Types].xml') && zip.some((n) => n.startsWith('ppt/'))) return 'pptx';
    if (zip.some((n) => n.startsWith('xl/'))) throw new ExtractError('Excel files are not supported. Export the sheet as PDF and upload that.');
    throw new ExtractError(UNSUPPORTED);
  }
  if (/\.(md|markdown)$/i.test(filename)) {
    if (!isUtf8Text(bytes)) throw new ExtractError('This Markdown file is not valid UTF-8 text. Save it as UTF-8 and upload it again.');
    return 'md';
  }
  throw new ExtractError(UNSUPPORTED);
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function cleanName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 200);
}

/** Write via a temp file in the same directory, then rename, so a crash never leaves a half-written resource. */
export function writeAtomic(file: string, data: Buffer | string) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const EXT: Record<ResourceKind, string> = { pdf: 'pdf', docx: 'docx', pptx: 'pptx', md: 'md', url: 'html' };

export async function storeResource(
  ctx: AppContext,
  projectId: string,
  input: { filename: string; bytes: Buffer; role: string } | { url: string; role: string },
  /** `fetch` is for tests (local fixture servers); routes never pass it. */
  opts: { fetch?: Pick<SafeFetchOptions, 'allowPrivate' | 'signal' | 'maxBytes' | 'timeoutMs'> } = {},
): Promise<string> {
  if (!ROLES.includes(input.role)) throw new ExtractError(`Unknown source role "${input.role}". Use theory, exercises, exams or mixed.`);
  if (!ctx.db.get('SELECT 1 FROM projects WHERE id = ?', projectId)) throw new ExtractError('That project was not found.', 404, 'not_found');

  let kind: ResourceKind;
  let bytes: Buffer;
  let filename: string;
  let url: string | null = null;
  const meta: Record<string, unknown> = {};
  let derived: string | null = null;

  if ('url' in input) {
    const page = await safeFetch(input.url, opts.fetch);
    bytes = page.body;
    kind = 'url';
    url = input.url.trim();
    const isHtml = /html/i.test(page.contentType);
    const text = bytes.toString('utf8');
    const conv = isHtml ? htmlToMarkdown(text) : { title: '', markdown: text.trim() };
    if (!conv.markdown.trim()) throw new ExtractError('That page has no readable text.', 400, 'url_empty', 'Open it in a browser. If it needs a login, save it as PDF and upload that.');
    derived = conv.markdown;
    const host = new URL(page.finalUrl).hostname;
    filename = cleanName(conv.title || host);
    Object.assign(meta, { fetchedAt: now(), finalUrl: page.finalUrl, contentType: page.contentType, title: conv.title, redirects: page.redirects });
  } else {
    bytes = input.bytes;
    filename = cleanName(input.filename);
    kind = detectKind(filename, bytes);
  }

  const hash = sha256(bytes);
  const existing = ctx.db.get<{ id: string }>('SELECT id FROM resources WHERE project_id = ? AND sha256 = ?', projectId, hash);
  if (existing) return existing.id;

  const dir = paths.resources(ctx.config, projectId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.${EXT[kind]}`);
  if (!existsSync(file)) writeAtomic(file, bytes);
  if (derived !== null) {
    const mdFile = join(dir, `${hash}.md`);
    writeAtomic(mdFile, derived);
    meta.derivedFile = `${hash}.md`;
  }

  const id = newId();
  try {
    ctx.db.insert('resources', {
      id, project_id: projectId, kind, role: input.role, filename, url, sha256: hash, size: bytes.length, path: toDataPath(ctx.config, file),
      included: 1, status: 'queued', error: null, page_count: 0, meta, created_at: now(),
    });
  } catch (err) {
    // Lost a race with a concurrent upload of the same bytes.
    const again = ctx.db.get<{ id: string }>('SELECT id FROM resources WHERE project_id = ? AND sha256 = ?', projectId, hash);
    if (again) return again.id;
    throw err;
  }
  return id;
}
