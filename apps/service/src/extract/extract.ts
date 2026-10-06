import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceIndex, SourceIndexEntry } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { json, newId, now } from '../db/db.ts';
import { paths } from '../config.ts';
import { ExtractError } from './errors.ts';
import { extractPdfInWorker, renderPdfInWorker, abortError } from './pdf-runner.ts';
import type { ExtractedPage, OutlineFlat } from './pdf-types.ts';
import { splitMarkdown } from './markdown.ts';
import { writeAtomic } from './store.ts';

interface ResourceRow {
  id: string;
  project_id: string;
  kind: string;
  role: string;
  filename: string;
  path: string;
  sha256: string;
  meta: string;
}

export const LIBREOFFICE_MISSING = 'LibreOffice is needed to read Word and PowerPoint files. Install it, then retry.';

function loadResource(ctx: AppContext, resourceId: string): ResourceRow {
  const row = ctx.db.get<ResourceRow>('SELECT id, project_id, kind, role, filename, path, sha256, meta FROM resources WHERE id = ?', resourceId);
  if (!row) throw new ExtractError('That source was not found. It may have been deleted.', 404, 'not_found');
  return row;
}

const dataFile = (ctx: AppContext, p: string) => (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) ? p : join(ctx.config.dataDir, p));

function setStatus(ctx: AppContext, row: ResourceRow, status: 'extracting' | 'ready' | 'failed' | 'queued', extra: Record<string, unknown> = {}) {
  ctx.db.update('resources', row.id, { status, ...extra });
  ctx.events.emit('resource.state', { resourceId: row.id, status, error: (extra.error as string | undefined) ?? null }, { projectId: row.project_id });
}

/** Convert Word/PowerPoint to PDF with LibreOffice in an isolated profile. Returns the PDF path. */
async function convertWithLibreOffice(ctx: AppContext, source: string, outPdf: string, signal: AbortSignal): Promise<void> {
  const tmpRoot = paths.tmp(ctx.config);
  mkdirSync(tmpRoot, { recursive: true });
  const work = mkdtempSync(join(tmpRoot, 'soffice-'));
  try {
    const profile = join(work, 'profile');
    const outDir = join(work, 'out');
    mkdirSync(outDir);
    await new Promise<void>((resolve, reject) => {
      execFile(
        'soffice',
        ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', outDir, source],
        { timeout: 120_000, signal, env: { ...process.env, HOME: process.env.HOME ?? work }, maxBuffer: 4 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.name === 'AbortError' || signal.aborted) return reject(abortError());
          if (e.code === 'ENOENT') return reject(new ExtractError(LIBREOFFICE_MISSING, 422, 'libreoffice_missing', 'Install LibreOffice, then retry.'));
          if (e.killed) return reject(new ExtractError('LibreOffice took longer than 2 minutes to convert this file.', 422, 'convert_timeout', 'Save the file as PDF and upload that instead.'));
          reject(new ExtractError(`LibreOffice could not convert this file (${String(stderr || e.message).trim().slice(0, 200)}).`, 422, 'convert_failed'));
        },
      );
    });
    const produced = join(outDir, source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '.pdf');
    if (!existsSync(produced)) throw new ExtractError('LibreOffice produced no PDF for this file.', 422, 'convert_failed');
    renameSync(produced, outPdf);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface Unitised { pages: Omit<ExtractedPage, 'score'>[]; entries: SourceIndexEntry[] }

function fromMarkdown(text: string, label: string): Unitised {
  const { units, entries } = splitMarkdown(text, label);
  return {
    pages: units.map((u, idx) => ({ idx, label: u.label, text: u.text, quality: 'good' as const })),
    entries,
  };
}

/** Extract a stored resource into pages, FTS rows and its source index. Idempotent: replaces existing pages. */
export async function extractResource(ctx: AppContext, resourceId: string, signal: AbortSignal): Promise<{ pages: number; garbled: number; index: SourceIndex | null }> {
  const row = loadResource(ctx, resourceId);
  const meta = json<Record<string, unknown>>(row.meta, {});
  const file = dataFile(ctx, row.path);
  setStatus(ctx, row, 'extracting', { error: null });
  try {
    let pages: Omit<ExtractedPage, 'score'>[];
    let entries: SourceIndexEntry[] = [];
    if (row.kind === 'pdf' || row.kind === 'docx' || row.kind === 'pptx') {
      let pdf = file;
      if (row.kind !== 'pdf') {
        const converted = join(dirname(file), `${row.sha256}.pdf`);
        if (!existsSync(converted) || meta.pdfFile !== `${row.sha256}.pdf`) {
          await convertWithLibreOffice(ctx, file, converted, signal);
        }
        meta.pdfFile = `${row.sha256}.pdf`;
        pdf = converted;
      }
      if (signal.aborted) throw abortError();
      const out = await extractPdfInWorker(pdf, signal);
      pages = out.pages;
      entries = out.outline.map((o: OutlineFlat) => ({ title: o.title, level: o.level, page: o.page }));
    } else if (row.kind === 'md' || row.kind === 'url') {
      const mdFile = row.kind === 'url' ? join(dirname(file), String(meta.derivedFile ?? `${row.sha256}.md`)) : file;
      const text = readFileSync(mdFile, 'utf8').replace(/^﻿/, '');
      const u = fromMarkdown(text, row.filename.replace(/\.[^.]+$/, '') || 'Documento');
      pages = u.pages;
      // Single-heading documents give an index no better than the page list.
      entries = u.entries;
    } else {
      throw new ExtractError(`Cannot extract a resource of kind "${row.kind}".`);
    }
    if (signal.aborted) throw abortError();
    if (!pages.length) throw new ExtractError('No pages could be read from this file.', 422, 'empty');

    const counts = { good: 0, garbled: 0, empty: 0 };
    for (const p of pages) counts[p.quality]++;
    const index: SourceIndex | null = entries.length ? { resourceId, origin: 'extracted', entries } : null;

    ctx.db.tx(() => {
      const old = new Map(
        ctx.db.all<{ idx: number; text: string; transcript: string | null; transcript_model: string | null; transcript_at: string | null }>(
          'SELECT idx, text, transcript, transcript_model, transcript_at FROM pages WHERE resource_id = ?', resourceId,
        ).map((r) => [r.idx, r]),
      );
      ctx.db.run('DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages WHERE resource_id = ?)', resourceId);
      ctx.db.run('DELETE FROM pages WHERE resource_id = ?', resourceId);
      const insPage = ctx.db.raw.prepare(
        'INSERT INTO pages (id, resource_id, idx, label, text, quality, transcript, transcript_model, transcript_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insFts = ctx.db.raw.prepare('INSERT INTO pages_fts (rowid, text, transcript) VALUES (?, ?, ?)');
      for (const p of pages) {
        // Same bytes extract to the same text, so a transcription already paid for is kept.
        const prev = old.get(p.idx);
        const keep = prev && prev.text === p.text && prev.transcript ? prev : null;
        const res = insPage.run(
          newId(), resourceId, p.idx, p.label, p.text, p.quality,
          keep?.transcript ?? null, keep?.transcript_model ?? null, keep?.transcript_at ?? null,
        );
        insFts.run(Number(res.lastInsertRowid), p.text, keep?.transcript ?? '');
      }
      if (index) {
        ctx.db.run(
          `INSERT INTO source_indexes (resource_id, origin, entries) VALUES (?, 'extracted', ?)
           ON CONFLICT(resource_id) DO UPDATE SET origin = 'extracted', entries = excluded.entries`,
          resourceId, JSON.stringify(index.entries),
        );
      } else {
        ctx.db.run(`DELETE FROM source_indexes WHERE resource_id = ? AND origin = 'extracted'`, resourceId);
      }
      meta.quality = counts;
      meta.extractedAt = now();
      ctx.db.update('resources', resourceId, { status: 'ready', error: null, page_count: pages.length, meta });
    });
    ctx.events.emit('resource.state', { resourceId, status: 'ready', pageCount: pages.length }, { projectId: row.project_id });
    return { pages: pages.length, garbled: counts.garbled + counts.empty, index };
  } catch (err) {
    if (signal.aborted || (err as Error).name === 'AbortError') {
      setStatus(ctx, row, 'queued');
    } else {
      setStatus(ctx, row, 'failed', { error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

/** Page file for rendering: the PDF itself, or the PDF LibreOffice made from a Word/PowerPoint file. */
function renderSource(ctx: AppContext, row: ResourceRow): string {
  const file = dataFile(ctx, row.path);
  if (row.kind === 'pdf') return file;
  if (row.kind === 'docx' || row.kind === 'pptx') {
    const converted = join(dirname(file), `${row.sha256}.pdf`);
    if (existsSync(converted)) return converted;
  }
  throw new ExtractError('This source has no page images.', 404, 'not_found');
}

/** PNG bytes of a page, cached on disk by scale. If highlight is given, the matching passage is marked in translucent orange. */
export async function renderPageImage(ctx: AppContext, resourceId: string, idx: number, opts: { scale?: number; highlight?: string } = {}): Promise<Buffer> {
  const row = loadResource(ctx, resourceId);
  const src = renderSource(ctx, row);
  const scale = Math.min(4, Math.max(0.5, Number.isFinite(opts.scale) ? (opts.scale as number) : 1.5));
  if (!Number.isInteger(idx) || idx < 0) throw new ExtractError('That page does not exist.', 404, 'not_found');
  const highlight = opts.highlight?.trim() || undefined;
  const cacheFile = join(paths.pageCache(ctx.config, row.project_id, resourceId), `${idx}@${scale}.png`);
  if (!highlight && existsSync(cacheFile)) return readFileSync(cacheFile);
  let out;
  try {
    out = await renderPdfInWorker(src, idx, scale, highlight);
  } catch (err) {
    if (/outside the document/.test((err as Error).message)) throw new ExtractError('That page does not exist.', 404, 'not_found');
    throw err;
  }
  const png = Buffer.from(out.png);
  if (!highlight) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeAtomic(cacheFile, png);
  }
  return png;
}
