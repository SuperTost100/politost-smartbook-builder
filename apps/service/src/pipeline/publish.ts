// Publish: writes a book's approved export into its folder of a politost-books checkout (`books/<slug>/`) with a manifest,
// `.builder.json`, that holds the sha256 of every file. The next publish compares the folder with the manifest and stops if a
// file was edited by hand, because writing the export over it would undo the edit: the edit has to be back-ported first. The
// books repo's CI runs the same comparison on every pull request. Nothing here commits or pushes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { checkFunctionGraph, lintCompiled, unpackPtsb, type LintFinding } from '@smartbuilder/content';
import { RULES_VERSION } from '@smartbuilder/content/rules-version';
import type { AppContext } from '../context.ts';
import { getExport, getProject, listExports } from '../repo/index.ts';
import { exportBook } from '../routes/review.ts';
import { HttpError } from '../server.ts';

export const MANIFEST = '.builder.json';
/** A file of the books repo, not of the book: listed in its catalog, never packed, and not written by the builder. */
const COVER = 'cover.svg';

export interface BuilderManifest {
  projectId: string;
  exportId: string;
  /** When the export was made, as stored on its row. ptsb.json in the folder has the package's own createdAt. */
  exportedAt: string;
  builderVersion: string;
  /** RULES_VERSION of the builder that made the export. */
  rulesVersion: string;
  /** sha256 of every file of the folder but dotfiles and cover.svg, by path inside the folder. */
  files: Record<string, string>;
  /** The blocker and major findings of the published files when they were published (findingKey), so validate-all lists only new ones. */
  findings: string[];
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The book's files in a folder, by path inside it, without dotfiles and the cover. A missing folder has none. */
export function bookFiles(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join('/');
      if (rel === COVER) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = readFileSync(full);
    }
  };
  walk(dir);
  return out;
}

export function readManifest(dir: string): BuilderManifest | null {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, 'utf8')) as BuilderManifest;
  if (!m || typeof m.files !== 'object' || !m.files) throw new Error(`${path} has no "files" map.`);
  return m;
}

/** Files of the folder that differ from the manifest: changed, added or removed since the last publish, sorted by path. */
export function handEdits(files: Record<string, Uint8Array>, manifest: Pick<BuilderManifest, 'files'>): string[] {
  const out: string[] = [];
  for (const path of [...new Set([...Object.keys(files), ...Object.keys(manifest.files)])].sort()) {
    if (!(path in manifest.files)) out.push(`added ${path}`);
    else if (!(path in files)) out.push(`removed ${path}`);
    else if (sha256(files[path]) !== manifest.files[path]) out.push(`changed ${path}`);
  }
  return out;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export const isSemver = (v: unknown): v is string => typeof v === 'string' && SEMVER.test(v);

/** The version after `current`: the next patch, or the release of a prerelease (1.2.0-beta becomes 1.2.0). A new book starts at 1.0.0. */
export function nextVersion(current: string | null): string {
  if (current === null) return '1.0.0';
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`The book's current version "${current}" is not semver; pass --version.`);
  return m[4] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The files with `version` set in smartbook.json, written the way the compiler writes it. */
export function withVersion(files: Record<string, Uint8Array>, version: string): Record<string, Uint8Array> {
  const raw = files['smartbook.json'];
  if (!raw) return files;
  const config = JSON.parse(dec.decode(raw)) as Record<string, unknown>;
  if (config.version === version) return files;
  return { ...files, 'smartbook.json': enc.encode(`${JSON.stringify({ ...config, version }, null, 2)}\n`) };
}

function versionOf(files: Record<string, Uint8Array>): string | null {
  const raw = files['smartbook.json'];
  if (!raw) return null;
  const v = (JSON.parse(dec.decode(raw)) as { version?: unknown }).version;
  return typeof v === 'string' ? v : null;
}

/**
 * Blocker and major findings in a published book with the rules of this builder: the compiled-book lint (text rules on the
 * reader's Markdown, references, assets, duplicates) and the graph check, which leaves a failing graph out of an export.
 */
export function publishedFindings(files: Record<string, Uint8Array>): LintFinding[] {
  const out = lintCompiled(files).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  const graphs = files['grafici.json'] ? JSON.parse(dec.decode(files['grafici.json'])) as unknown : [];
  for (const g of Array.isArray(graphs) ? graphs : []) {
    const r = checkFunctionGraph(g as Record<string, unknown>);
    const title = String((g as { title?: unknown }).title ?? (g as { id?: unknown }).id ?? '');
    if (!r.ok) out.push({ rule: 'graph-check', severity: 'major', file: 'grafici.json', message: `The graph "${title}" fails its check: ${r.detail}`, quote: title });
  }
  return out;
}

export const findingKey = (f: LintFinding) => `${f.severity} ${f.rule} ${f.file}: ${f.quote ?? f.message}`;

export const backportCommand = (projectId: string, folder: string) => `npm run backport -- --project ${projectId} --from ${folder} --dry-run`;

export interface PublishPlan {
  projectId: string;
  slug: string;
  folder: string;
  /** smartbook.json version in the folder now, and the one the publish writes. */
  previousVersion: string | null;
  version: string;
  /** The export the files come from: a stored one, or the one --export makes (no id in a dry run). */
  exportLabel: string | null;
  /** What the folder will hold, and how that differs from it now. Null when no export could be read. */
  files: Record<string, Uint8Array> | null;
  diff: { added: string[]; changed: string[]; removed: string[] };
  /** The export holds the same book as the folder, apart from the package header and the version. */
  upToDate: boolean;
  /** Files changed by hand since the last publish. Any of them stops the publish. */
  handEdited: string[];
  notices: string[];
  /** Why the publish cannot go ahead (hand edits included); empty when it can. */
  refusals: string[];
  manifest: BuilderManifest | null;
}

export interface PublishOptions {
  projectId: string;
  /** The politost-books checkout. */
  booksDir: string;
  /** The version to publish; by default the one after the folder's. */
  version?: string;
  /** Make a new approved export, with the same gate as "Approve and export", instead of using the latest stored one. */
  export?: boolean;
  /** Write nothing: no export, no file. Every check still runs and is reported. */
  dryRun?: boolean;
}

/**
 * Everything a publish checks and would write, without writing it. A real run stops at the first refusal of the folder (hand
 * edits) before it exports; a dry run goes on, so it reports every problem and the files the export would change.
 */
export function planPublish(ctx: AppContext, opts: PublishOptions): PublishPlan {
  if (!existsSync(join(opts.booksDir, 'books'))) throw new Error(`${opts.booksDir} is not a politost-books checkout: it has no books folder.`);
  if (opts.version !== undefined && !isSemver(opts.version)) throw new Error(`--version ${opts.version} is not semver, e.g. 1.2.3.`);
  const { slug } = getProject(ctx, opts.projectId);
  const folder = join(opts.booksDir, 'books', slug);
  const current = bookFiles(folder);
  const notices: string[] = [];
  const refusals: string[] = [];
  const backport = backportCommand(opts.projectId, folder);

  const last = readManifest(folder);
  const handEdited = last ? handEdits(current, last) : [];
  if (handEdited.length) {
    refusals.push(`books/${slug} was edited outside the builder since its last publish (${handEdited.join(', ')}). Publishing would undo those edits. Back-port them first, starting with the dry run:\n  ${backport}`);
  } else if (!last && Object.keys(current).length) {
    notices.push(`books/${slug} has no ${MANIFEST}, so edits made outside the builder cannot be detected: every difference listed below is overwritten. If the folder holds such fixes, back-port them first:\n  ${backport}`);
  } else if (!last) {
    notices.push(`books/${slug} does not exist yet: this is the book's first publish.`);
  }

  const previousVersion = versionOf(current);
  const version = opts.version ?? nextVersion(previousVersion);
  const plan: PublishPlan = {
    projectId: opts.projectId, slug, folder, previousVersion, version, exportLabel: null, files: null,
    diff: { added: [], changed: [], removed: [] }, upToDate: false, handEdited, notices, refusals, manifest: null,
  };
  if (refusals.length && !opts.dryRun) return plan;

  let bytes: Uint8Array | null = null;
  let source: { exportId: string; exportedAt: string; rulesVersion: string } | null = null;
  if (opts.export) {
    try {
      const made = opts.dryRun
        ? exportBook(ctx, opts.projectId, { approved: true, version, dryRun: true })
        : exportBook(ctx, opts.projectId, { approved: true, version });
      if (made.blocked) refusals.push(`${made.blocked.message} ${made.blocked.action ?? ''}`.trim());
      bytes = made.bytes;
      plan.exportLabel = made.row ? `${made.row.filename} (new)` : 'a new export (dry run, not stored)';
      if (made.row) source = { exportId: made.row.id, exportedAt: made.row.createdAt, rulesVersion: RULES_VERSION };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      refusals.push(`${err.message} ${err.action ?? ''}`.trim());
    }
  } else {
    const latest = listExports(ctx, opts.projectId).find((e) => e.approved);
    if (!latest) {
      refusals.push('The book has no approved export. Use "Approve and export" in the builder, or add --export.');
    } else {
      const row = getExport(ctx, latest.id);
      plan.exportLabel = `${row.filename} (${row.createdAt})`;
      if (!existsSync(row.path)) refusals.push(`The export file ${row.path} is no longer on disk. Export the book again, or add --export.`);
      else {
        bytes = readFileSync(row.path);
        if (sha256(bytes) !== row.sha256) {
          refusals.push(`The export file ${row.path} does not match the checksum stored when it was made. Export the book again, or add --export.`);
          bytes = null;
        }
      }
      if (row.report.rulesVersion !== RULES_VERSION) {
        refusals.push(`The latest approved export, ${row.filename}, was checked with other rules (${row.report.rulesVersion ?? 'made before rules were versioned'}; this builder has ${RULES_VERSION}), so a rule added since never read it. Run Validate and "Approve and export" again, or add --export.`);
      }
      source = { exportId: row.id, exportedAt: row.createdAt, rulesVersion: row.report.rulesVersion ?? '' };
    }
  }
  if (!bytes) return plan;

  const files = withVersion(unpackPtsb(bytes), version);
  plan.files = files;
  for (const path of Object.keys(files).sort()) {
    if (!(path in current)) plan.diff.added.push(path);
    else if (!Buffer.from(files[path]).equals(Buffer.from(current[path]))) plan.diff.changed.push(path);
  }
  plan.diff.removed = Object.keys(current).filter((p) => !(p in files)).sort();
  // The same book again, already published with these rules: only the package header (its createdAt) and the version would
  // change. A folder with no manifest, or one checked with other rules, still gets a new one, and an explicit --version is written.
  const book = (f: Record<string, Uint8Array>) => Object.entries(f).filter(([p]) => p !== 'ptsb.json');
  const asBefore = previousVersion === null ? null : book(withVersion(files, previousVersion));
  plan.upToDate = !!asBefore && !!last && last.rulesVersion === source?.rulesVersion
    && (opts.version === undefined || opts.version === previousVersion)
    && asBefore.length === book(current).length
    && asBefore.every(([p, b]) => current[p] !== undefined && Buffer.from(b).equals(Buffer.from(current[p])));

  if (source) {
    const hashes: Record<string, string> = {};
    for (const path of Object.keys(files).sort()) hashes[path] = sha256(files[path]);
    plan.manifest = {
      projectId: opts.projectId, exportId: source.exportId, exportedAt: source.exportedAt, builderVersion: ctx.config.version,
      rulesVersion: source.rulesVersion, files: hashes, findings: [...new Set(publishedFindings(files).map(findingKey))].sort(),
    };
  }
  return plan;
}

/** Writes the plan's files and manifest into the folder, and removes the book files the export no longer has. */
export function writePublish(plan: PublishPlan): void {
  if (plan.refusals.length || !plan.files || !plan.manifest) throw new Error('This publish was refused; nothing was written.');
  // A file edited between the plan and now (an editor, a sync tool) would be overwritten without the plan's check.
  const last = readManifest(plan.folder);
  const edited = last ? handEdits(bookFiles(plan.folder), last) : [];
  if (edited.length) throw new Error(`books/${plan.slug} changed after the publish was planned (${edited.join(', ')}); nothing was written.`);
  for (const path of plan.diff.removed) {
    rmSync(join(plan.folder, path));
    // A folder the removal emptied (an assets folder) goes too, as git does not keep it.
    for (let dir = dirname(join(plan.folder, path)); dir !== plan.folder && readdirSync(dir).length === 0; dir = dirname(dir)) rmdirSync(dir);
  }
  for (const [path, bytes] of Object.entries(plan.files)) {
    const full = join(plan.folder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  writeFileSync(join(plan.folder, MANIFEST), `${JSON.stringify(plan.manifest, null, 2)}\n`);
}

export interface PublishedCheck {
  slug: string;
  /** Whether the folder was published with this builder's rules: 'same', 'other', or 'unknown' without a manifest. */
  rules: 'same' | 'other' | 'unknown';
  /** Blocker and major findings that the manifest did not record at publish time; every one when there is no manifest. */
  fresh: LintFinding[];
}

/** Lints every book of a politost-books checkout that the builder made (it has a manifest, or the builder's ptsb.json). */
export function validatePublished(booksDir: string): PublishedCheck[] {
  const root = join(booksDir, 'books');
  if (!existsSync(root)) throw new Error(`${booksDir} is not a politost-books checkout: it has no books folder.`);
  const out: PublishedCheck[] = [];
  for (const slug of readdirSync(root).sort()) {
    const folder = join(root, slug);
    if (slug.startsWith('.') || !statSync(folder).isDirectory()) continue;
    const manifest = readManifest(folder);
    const header = join(folder, 'ptsb.json');
    const producer = existsSync(header) ? String((JSON.parse(readFileSync(header, 'utf8')) as { producer?: unknown }).producer ?? '') : '';
    if (!manifest && !producer.startsWith('politost-smart-builder/')) continue;
    const known = new Set(manifest?.findings ?? []);
    out.push({
      slug,
      rules: !manifest ? 'unknown' : manifest.rulesVersion === RULES_VERSION ? 'same' : 'other',
      fresh: publishedFindings(bookFiles(folder)).filter((f) => !known.has(findingKey(f))),
    });
  }
  return out;
}
