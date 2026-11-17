// Publish: compiles a book through the same gate as "Approve and export", stores the export, and writes it into the book's
// folder of a politost-books checkout (`books/<slug>/`) with a manifest, `.builder.json`, that names the export and holds the
// sha256 of every file. The next publish compares the folder with that stored export and with the new one, and stops on a
// file that matches neither: a hand edit, which writing over would undo, so it has to be back-ported first. The books repo's
// CI checks the hashes on every pull request. Nothing here commits or pushes.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { checkFunctionGraph, lintCompiled, unpackPtsb, type LintFinding } from '@smartbuilder/content';
import type { AppContext } from '../context.ts';
import { getExport, getProject } from '../repo/index.ts';
import { prepareExport, storeExport, type PreparedExport } from '../routes/review.ts';
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
  /** sha256 of every file of the folder but dotfiles and cover.svg, by path inside the folder. */
  files: Record<string, string>;
  /** The blocker and major findings of the published files when they were published (findingKey), so validate-all lists only new ones. */
  findings: string[];
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * The book's files in a folder, by path inside it, without dotfiles and the cover. A missing folder has none. A symbolic link
 * is refused: the folder can come from a pull request, and a publish would otherwise read and write the file it points at.
 */
export function bookFiles(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    if (lstatSync(d).isSymbolicLink()) throw new Error(`${d} is a symbolic link; a book folder holds only plain files and folders.`);
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join('/');
      if (rel === COVER) continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`${full} is a symbolic link; a book folder holds only plain files and folders.`);
      if (st.isDirectory()) walk(full);
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
  /** The export about to be stored, compiled with `version`; writePublish stores it. */
  prepared: PreparedExport;
  /** What the folder will hold, and how that differs from it now. */
  files: Record<string, Uint8Array>;
  diff: { added: string[]; changed: string[]; removed: string[] };
  /** The folder was published by publish-book and holds the same book, apart from the package header and the version. */
  upToDate: boolean;
  /** Files that differ from both the export the folder was published from and the new one: edits made outside the builder. */
  handEdited: string[];
  notices: string[];
  /** Why the publish cannot go ahead (hand edits included); empty when it can. */
  refusals: string[];
  /** sha256 of the folder's book files when the plan was made: writePublish refuses a folder that changed since. */
  folderHashes: Record<string, string>;
}

export interface PublishOptions {
  projectId: string;
  /** The politost-books checkout. */
  booksDir: string;
  /** The version to publish; by default the one after the folder's. */
  version?: string;
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a === undefined ? b === undefined : b !== undefined && Buffer.from(a).equals(Buffer.from(b));
/** For the hand-edit check: smartbook.json without its version, which the publish sets and a contributor raises as the repo asks. */
const sameBook = (path: string, a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  path === 'smartbook.json' && a && b ? same(withVersion({ [path]: a }, '')[path], withVersion({ [path]: b }, '')[path]) : same(a, b);

/**
 * The files of the export a manifest names, as this builder stored it. The manifest's own hashes are not trusted: they live in
 * the books repo, where anyone can rewrite them with the files.
 */
function publishedExport(ctx: AppContext, projectId: string, manifest: BuilderManifest): Record<string, Uint8Array> | string {
  if (manifest.projectId !== projectId) return `its ${MANIFEST} belongs to project ${manifest.projectId}, not ${projectId}`;
  let row;
  try {
    row = getExport(ctx, manifest.exportId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return `its ${MANIFEST} names export ${manifest.exportId}, which this builder does not have (a books checkout published from another data folder?)`;
  }
  if (row.projectId !== projectId) return `its ${MANIFEST} names export ${manifest.exportId} of another project`;
  if (!existsSync(row.path)) return `the export it was published from, ${row.filename}, is no longer on disk`;
  const bytes = readFileSync(row.path);
  if (sha256(bytes) !== row.sha256) return `the export it was published from, ${row.filename}, does not match the checksum stored with it`;
  return unpackPtsb(bytes);
}

/**
 * Everything a publish checks and would write, without writing anything. It compiles the book through the gate of "Approve
 * and export" first, then compares the folder with the export it was published from and with this new one. A file that
 * matches neither was edited outside the builder; one that matches the new export (a fix already back-ported) is fine.
 */
export function planPublish(ctx: AppContext, opts: PublishOptions): PublishPlan {
  if (!existsSync(join(opts.booksDir, 'books'))) throw new Error(`${opts.booksDir} is not a politost-books checkout: it has no books folder.`);
  if (opts.version !== undefined && !isSemver(opts.version)) throw new Error(`--version ${opts.version} is not semver, e.g. 1.2.3.`);
  const { slug } = getProject(ctx, opts.projectId);
  const folder = join(opts.booksDir, 'books', slug);
  const current = bookFiles(folder);
  const notices: string[] = [];
  const refusals: string[] = [];
  const previousVersion = versionOf(current);
  const version = opts.version ?? nextVersion(previousVersion);

  const prepared = prepareExport(ctx, opts.projectId, { approved: true, version });
  if (prepared.blocked) refusals.push(`${prepared.blocked.message} ${prepared.blocked.action ?? ''}`.trim());
  const files = unpackPtsb(prepared.bytes);

  const last = readManifest(folder);
  let handEdited: string[] = [];
  // The folder is exactly the export its manifest names: nothing was changed there since, back-ported or not.
  let asPublished = false;
  if (last) {
    const base = publishedExport(ctx, opts.projectId, last);
    if (typeof base === 'string') {
      refusals.push(`books/${slug} cannot be checked for edits made outside the builder: ${base}.`);
    } else {
      const paths = [...new Set([...Object.keys(current), ...Object.keys(base)])].sort();
      handEdited = paths.filter((p) => !sameBook(p, current[p], base[p]) && !sameBook(p, current[p], files[p]));
      asPublished = paths.every((p) => same(current[p], base[p]));
      if (handEdited.length) {
        refusals.push(`books/${slug} was edited outside the builder since its last publish (${handEdited.join(', ')}). Publishing would undo those edits. Back-port them first, starting with the dry run:\n  ${backportCommand(opts.projectId, folder)}`);
      }
    }
  } else if (Object.keys(current).length) {
    notices.push(`books/${slug} has no ${MANIFEST}: this is its first publish through publish-book, so edits made outside the builder cannot be told apart. Every difference listed below is overwritten; read them before publishing.`);
  } else {
    notices.push(`books/${slug} does not exist yet: this is the book's first publish.`);
  }

  const diff = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
  for (const path of Object.keys(files).sort()) {
    if (!(path in current)) diff.added.push(path);
    else if (!same(files[path], current[path])) diff.changed.push(path);
  }
  diff.removed = Object.keys(current).filter((p) => !(p in files)).sort();
  // The same book again, in a folder that is still what was published: only the package header (its createdAt) and the version
  // would change. A folder with no manifest, or with a back-ported fix its manifest does not list, gets a new one, and an
  // explicit --version is written.
  const book = (f: Record<string, Uint8Array>) => Object.entries(f).filter(([p]) => p !== 'ptsb.json');
  const asBefore = previousVersion === null ? null : book(withVersion(files, previousVersion));
  const upToDate = !!asBefore && asPublished && (opts.version === undefined || opts.version === previousVersion)
    && asBefore.length === book(current).length && asBefore.every(([p, b]) => same(b, current[p]));

  return {
    projectId: opts.projectId, slug, folder, previousVersion, version, prepared, files, diff, upToDate, handEdited, notices, refusals,
    folderHashes: Object.fromEntries(Object.entries(current).map(([p, b]) => [p, sha256(b)])),
  };
}

/**
 * Stores the plan's export (as "Approve and export" does), writes its files and a manifest that names it into the folder, and
 * removes the book files the export no longer has. Returns the manifest.
 */
export function writePublish(ctx: AppContext, plan: PublishPlan): BuilderManifest {
  if (plan.refusals.length) throw new Error('This publish was refused; nothing was written.');
  // A file changed between the plan and now (an editor, a sync tool, another publish) would be overwritten without the plan's check.
  const edited = handEdits(bookFiles(plan.folder), { files: plan.folderHashes });
  if (edited.length) throw new Error(`books/${plan.slug} changed after the publish was planned (${edited.join(', ')}); nothing was written.`);
  const row = storeExport(ctx, plan.projectId, plan.prepared);
  const manifest: BuilderManifest = {
    projectId: plan.projectId, exportId: row.id, exportedAt: row.createdAt, builderVersion: ctx.config.version,
    files: Object.fromEntries(Object.keys(plan.files).sort().map((p) => [p, sha256(plan.files[p])])),
    findings: [...new Set(publishedFindings(plan.files).map(findingKey))].sort(),
  };
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
  writeFileSync(join(plan.folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface PublishedCheck {
  slug: string;
  /** Whether the folder has a manifest; without one every finding is new. */
  manifest: boolean;
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
      manifest: !!manifest,
      fresh: publishedFindings(bookFiles(folder)).filter((f) => !known.has(findingKey(f))),
    });
  }
  return out;
}
