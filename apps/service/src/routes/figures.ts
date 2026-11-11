// The figure dialog and "Add figure" of the manuscript. Every write names the head of the section the author was looking at
// (`baseRevId`) and gets 409 when the text moved on. A change of the picture is a new asset and a new revision, so History
// keeps what a revision looked like (figures/author.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { splitBlocks } from '@smartbuilder/content/blocks';
import type { PhotoCandidate, SectionView } from '@smartbuilder/domain';
import type { AppContext } from '../context.ts';
import { newId } from '../db/db.ts';
import { bookFigures, cleanCaption, removeImageBlock } from '../figures/materialize.ts';
import {
  copyAsset, discardAsset, figureDetails, figureOfSection, FIGURE_UPLOAD_MAX, imageBlock, insertAfterBlock, saveFigureDetails, storeUpload, swapSrc, writeFigureRevision,
} from '../figures/author.ts';
import { drawingSpec } from '../figures/drawing/edit.ts';
import { loadProject } from '../pipeline/util.ts';
import { activeRedraw } from '../pipeline/figureEdit.ts';
import { storeAsset } from '../repo/assets.ts';
import { currentHead } from '../repo/content.ts';
import { badInput, conflict, notFound } from '../repo/errors.ts';
import { HttpError } from '../server.ts';
import { deps } from './deps.ts';
import { idParam, parse, projectOf } from './util.ts';
import { buildSectionView, requireOutline } from './views.ts';
import { findNode } from '../repo/index.ts';
import type { PhotoSearch } from '../figures/stock.ts';

const baseRev = z.string().min(1);
const captionText = z.string().max(1000);
/** The lint blocks an image without alt text, so it cannot be saved empty. */
const altText = z.string().trim().min(1, 'Say what the figure shows to a reader who cannot see it').max(1000);

function nodeOf(ctx: AppContext, projectId: string, nodeId: string) {
  const node = findNode(requireOutline(ctx, projectId), nodeId);
  if (!node) throw new HttpError(404, 'not_found', 'This section is not in the outline.', 'Reload the page.');
  return node;
}

/** The head of the section, which must be the one the dialog was opened on. */
function headOf(ctx: AppContext, projectId: string, nodeId: string, baseRevId: string) {
  nodeOf(ctx, projectId, nodeId);
  const head = currentHead(ctx, projectId, nodeId);
  if (!head || head.id !== baseRevId) throw conflict('This text changed since you opened it.', undefined, nodeId);
  return head;
}

/** A multipart request with one image file and some text fields. A file over the limit is refused with 413. */
async function readUpload(req: FastifyRequest): Promise<{ file: { filename: string; bytes: Buffer }; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new HttpError(400, 'invalid', 'Send the image as a form upload.');
  let file: { filename: string; bytes: Buffer } | null = null;
  const fields: Record<string, string> = {};
  for await (const part of req.parts({ limits: { fileSize: FIGURE_UPLOAD_MAX, files: 1 } })) {
    if (part.type === 'field') { fields[part.fieldname] = String(part.value); continue; }
    const bytes = await part.toBuffer();
    if (part.file.truncated) throw new HttpError(413, 'too_large', 'This image is larger than 2 MB.', 'Reduce its size and upload it again.');
    if (!file && part.filename) file = { filename: part.filename, bytes };
  }
  if (!file) throw new HttpError(400, 'no_files', 'No image was received.', 'Choose an image file.');
  return { file, fields };
}

const afterBlockOf = (v: unknown, blocks: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= blocks) throw badInput('The block the figure goes after is not in this section.', 'Reload the page.', 'afterBlock');
  return n;
};

/** Photo searches an author ran, for the picture they then pick. They stay in memory: a restart asks for a new search. */
interface StoredSearch { projectId: string; query: string; at: number; search: PhotoSearch }
const SEARCHES = new Map<string, StoredSearch>();
const MAX_SEARCHES = 6;
const SEARCH_TTL_MS = 30 * 60_000;

function storedSearch(projectId: string, searchId: string): StoredSearch {
  const s = SEARCHES.get(searchId);
  if (!s || s.projectId !== projectId || Date.now() - s.at > SEARCH_TTL_MS) throw new HttpError(404, 'not_found', 'This photo search is no longer available.', 'Search again.');
  return s;
}

export function registerFigureRoutes(app: FastifyInstance, ctx: AppContext) {
  const base = '/api/projects/:id/sections/:nodeId/figures';
  const view = (projectId: string, nodeId: string): SectionView => buildSectionView(ctx, projectId, nodeId);

  app.get(`${base}/:assetId`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    nodeOf(ctx, projectId, nodeId);
    const head = currentHead(ctx, projectId, nodeId);
    const asset = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    return figureDetails(asset, head!, activeRedraw(ctx, projectId, asset.id));
  });

  app.patch(`${base}/:assetId`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ baseRevId: baseRev, caption: captionText.optional(), alt: altText.optional(), shows: z.string().trim().min(1).max(4000).optional() }), req.body);
    const head = headOf(ctx, projectId, nodeId, body.baseRevId);
    const asset = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    const drawing = drawingSpec(asset);
    if (body.shows !== undefined && !drawing) throw badInput('Only a drawn figure has a description to save.', undefined, 'shows');
    // The caption, the alt text and the description are read by every revision that names the asset, so the change is made on a copy (figures/author.ts).
    const rev = saveFigureDetails(ctx, projectId, nodeId, asset, { caption: body.caption === undefined ? undefined : cleanCaption(body.caption), alt: body.alt, shows: body.shows }, head.id);
    if (rev) ctx.events.emit('asset.updated', { assetId: asset.id, nodeId }, { projectId });
    return view(projectId, nodeId);
  });

  app.post(`${base}/:assetId/render`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ baseRevId: baseRev, source: z.string().min(1).max(200_000) }), req.body);
    const head = headOf(ctx, projectId, nodeId, body.baseRevId);
    const old = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    if (!drawingSpec(old)) throw badInput('This figure was not drawn from source code, so it has no source to render.');
    // The edit is made on a copy: when the source does not compile the figure is untouched, and when it does the old asset stays for History.
    const copy = copyAsset(ctx, old);
    let result: Awaited<ReturnType<typeof deps.renderEditedDrawing>>;
    try {
      result = await deps.renderEditedDrawing(ctx, copy.id, body.source);
    } catch (err) {
      discardAsset(ctx, copy);
      throw err;
    }
    if (!result.ok) {
      discardAsset(ctx, copy);
      throw new HttpError(422, 'does_not_compile', result.error, 'Fix the source and render again. The figure in the section is unchanged.');
    }
    try {
      writeFigureRevision(ctx, projectId, nodeId, (md) => swapSrc(md, old.filename, copy.filename), { expectedHeadId: head.id });
    } catch (err) {
      discardAsset(ctx, copy);
      throw err;
    }
    return view(projectId, nodeId);
  });

  app.post(`${base}/:assetId/redraw`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ baseRevId: baseRev, instruction: z.string().trim().min(1, 'Say what the drawing should change').max(1000), shows: z.string().trim().min(1).max(4000).optional() }), req.body);
    const head = headOf(ctx, projectId, nodeId, body.baseRevId);
    const asset = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    const drawing = drawingSpec(asset);
    if (!drawing) throw badInput('This figure was not drawn from source code, so it cannot be redrawn.');
    // A description the author edited goes with the redraw, which saves it on the new drawing.
    const shows = body.shows !== undefined && body.shows !== drawing.shows ? body.shows : undefined;
    return deps.startRedraw(ctx, projectId, { nodeId, assetId: asset.id, caption: asset.caption, instruction: body.instruction, ...(shows ? { shows } : {}) });
  });

  app.post(`${base}/:assetId/replace`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const { file, fields } = await readUpload(req);
    const head = headOf(ctx, projectId, nodeId, parse(z.object({ baseRevId: baseRev }), fields).baseRevId);
    const old = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    const fresh = storeUpload(ctx, projectId, nodeId, file, { caption: old.caption, alt: old.alt });
    try {
      writeFigureRevision(ctx, projectId, nodeId, (md) => swapSrc(md, old.filename, fresh.filename), { expectedHeadId: head.id });
    } catch (err) {
      discardAsset(ctx, fresh);
      throw err;
    }
    return view(projectId, nodeId);
  });

  app.post(`${base}/:assetId/remove`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const { baseRevId } = parse(z.object({ baseRevId: baseRev }), req.body);
    const head = headOf(ctx, projectId, nodeId, baseRevId);
    const asset = figureOfSection(ctx, projectId, idParam(req, 'assetId'), head);
    // The asset stays: older revisions of the section still show it.
    writeFigureRevision(ctx, projectId, nodeId, (md) => removeImageBlock(md, asset.filename), { expectedHeadId: head.id });
    return view(projectId, nodeId);
  });

  // ---------- Add figure ----------

  app.post(`${base}/draw`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ baseRevId: baseRev, afterBlock: z.number().int().min(0), description: z.string().trim().min(1, 'Say what the figure shows').max(4000), caption: captionText }), req.body);
    const head = headOf(ctx, projectId, nodeId, body.baseRevId);
    const blocks = splitBlocks(head.markdown);
    const afterBlock = afterBlockOf(body.afterBlock, blocks.length);
    if (!loadProject(ctx, projectId).options.figures) throw new HttpError(409, 'figures_off', 'Figures are off for this book.', 'Turn on figures in Setup, then try again.');
    return deps.startDraw(ctx, projectId, { nodeId, afterBlock, anchor: blocks[afterBlock].text, description: body.description, caption: body.caption });
  });

  app.post(`${base}/upload`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const { file, fields } = await readUpload(req);
    const head = headOf(ctx, projectId, nodeId, parse(z.object({ baseRevId: baseRev }), fields).baseRevId);
    const afterBlock = afterBlockOf(fields.afterBlock, splitBlocks(head.markdown).length);
    const caption = cleanCaption(fields.caption ?? '');
    const alt = caption || file.filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const asset = storeUpload(ctx, projectId, nodeId, file, { caption, alt });
    try {
      writeFigureRevision(ctx, projectId, nodeId, (md) => insertAfterBlock(md, afterBlock, imageBlock(asset.filename, alt, caption)), { expectedHeadId: head.id });
    } catch (err) {
      discardAsset(ctx, asset);
      throw err;
    }
    return view(projectId, nodeId);
  });

  app.post('/api/projects/:id/figure-photos/search', async (req) => {
    const projectId = projectOf(ctx, req);
    const { query } = parse(z.object({ query: z.string().trim().min(2, 'Type what to look for').max(100) }), req.body);
    const exclude = new Set([...bookFigures(ctx, projectId).keys()].filter((k) => k.startsWith('photo:')).map((k) => k.slice('photo:'.length)));
    const found = await deps.searchStockPhotos(ctx, { query, exclude });
    if (!found.ok) throw new HttpError(404, 'no_photos', found.reason, 'Try other words.');
    const searchId = newId();
    SEARCHES.set(searchId, { projectId, query, at: Date.now(), search: found.search });
    while (SEARCHES.size > MAX_SEARCHES) SEARCHES.delete(SEARCHES.keys().next().value!);
    const photos: PhotoCandidate[] = found.search.candidates.map(({ c }, index) => ({ index, provider: c.provider, author: c.author, license: c.license, pageUrl: c.pageUrl }));
    return { searchId, photos };
  });

  app.get('/api/projects/:id/figure-photos/:searchId/:index', async (req, reply) => {
    const projectId = projectOf(ctx, req);
    const s = storedSearch(projectId, idParam(req, 'searchId'));
    const hit = s.search.candidates[Number(idParam(req, 'index'))];
    if (!hit) throw notFound('This photo');
    reply.header('content-type', hit.preview.mime);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=600');
    return reply.send(hit.preview.bytes);
  });

  app.post(`${base}/photo`, async (req) => {
    const projectId = projectOf(ctx, req);
    const nodeId = idParam(req, 'nodeId');
    const body = parse(z.object({ baseRevId: baseRev, afterBlock: z.number().int().min(0), searchId: z.string().min(1), index: z.number().int().min(0), caption: captionText }), req.body);
    const head = headOf(ctx, projectId, nodeId, body.baseRevId);
    const afterBlock = afterBlockOf(body.afterBlock, splitBlocks(head.markdown).length);
    const s = storedSearch(projectId, body.searchId);
    const hit = s.search.candidates[body.index];
    if (!hit) throw notFound('This photo');
    // Checked again after the download: another request may have inserted the same photo meanwhile.
    const notUsed = () => {
      const twin = bookFigures(ctx, projectId).get(`photo:${hit.c.provider}:${hit.c.id}`);
      if (twin) throw new HttpError(409, 'photo_used', `This photo is already in ${twin.where}.`, 'Pick another photo.');
    };
    notUsed();
    const got = await deps.fetchChosenPhoto(hit, loadProject(ctx, projectId).language);
    if (!got.ok) throw new HttpError(502, 'photo_failed', got.reason, 'Pick another photo or try again.');
    const p = got.photo;
    // The credit line is the pipeline's own: the caption ends with it, as for a photo the writer asked for.
    const text = cleanCaption(body.caption);
    const caption = text ? `${text.replace(/[.;:,]?$/, '.')} ${p.credit}` : p.credit;
    const alt = text || s.query;
    notUsed(); // no await from here to the revision, so no other request can insert the photo in between
    const asset = storeAsset(ctx, projectId, {
      filename: `${nodeId.slice(0, 8)}-photo-${newId().slice(0, 6)}${p.ext}`, bytes: p.bytes, origin: 'stock', nodeId, caption, alt,
      spec: { provider: p.provider, id: p.id, pageUrl: p.pageUrl, author: p.author, license: p.license, query: s.query, mustShow: alt },
      checks: [{ method: 'lint', ok: true, detail: p.check }],
    });
    try {
      writeFigureRevision(ctx, projectId, nodeId, (md) => insertAfterBlock(md, afterBlock, imageBlock(asset.filename, alt, caption)), { expectedHeadId: head.id });
    } catch (err) {
      discardAsset(ctx, asset);
      throw err;
    }
    return view(projectId, nodeId);
  });
}
