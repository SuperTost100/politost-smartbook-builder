// Stock photos from Pixabay and Pexels: search both, let the vision model pick one that really shows the thing, download it.
import * as mupdf from 'mupdf';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { json } from '../db/db.ts';
import { runRole, type RunRoleOptions, type RunRoleResult } from '../llm/index.ts';

export interface StockKeys { pixabay: string | null; pexels: string | null }

const KEYS_ROW = 'stock-keys';

export function stockKeys(ctx: AppContext): StockKeys {
  const row = ctx.db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, KEYS_ROW);
  const raw = json<Record<string, unknown>>(row?.value, {});
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { pixabay: clean(raw.pixabay), pexels: clean(raw.pexels) };
}

/** Empty string or null clears a key; an omitted field keeps its value. */
export function saveStockKeys(ctx: AppContext, patch: { pixabay?: string | null; pexels?: string | null }): StockKeys {
  const cur = stockKeys(ctx);
  const pick = (v: string | null | undefined, old: string | null) => (v === undefined ? old : v?.trim() || null);
  const next: StockKeys = { pixabay: pick(patch.pixabay, cur.pixabay), pexels: pick(patch.pexels, cur.pexels) };
  ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, KEYS_ROW, JSON.stringify(next));
  return next;
}

export function hasStockKeys(ctx: AppContext): boolean {
  const k = stockKeys(ctx);
  return !!(k.pixabay || k.pexels);
}

export interface StockPhoto {
  bytes: Buffer;
  ext: '.jpg' | '.png' | '.webp';
  mime: string;
  provider: 'pixabay' | 'pexels';
  author: string;
  pageUrl: string;
  id: string;
  /** Caption credit, e.g. "Foto: Mario Rossi / Pexels". */
  credit: string;
  /** One sentence: why the vision model accepted it. */
  check: string;
}

export interface StockDeps {
  fetch: typeof fetch;
  runRole: <T>(ctx: AppContext, opts: RunRoleOptions<T>) => Promise<RunRoleResult<T>>;
  /** Any supported image to PNG, for the model runner. */
  toPng: (bytes: Buffer) => Buffer;
}

const defaults: StockDeps = {
  fetch: (...a) => fetch(...a),
  runRole: (ctx, opts) => runRole(ctx, opts),
  toPng,
};

export const deps: StockDeps = { ...defaults };

/** Override collaborators (tests). Call with no argument to restore the defaults. */
export function setStockDeps(partial?: Partial<StockDeps>) {
  Object.assign(deps, defaults, partial ?? {});
}

const IMAGE_HOSTS = new Set(['pixabay.com', 'cdn.pixabay.com', 'images.pexels.com']);
const MAX_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const PER_SERVICE = 6;
const MAX_CANDIDATES = 10;
const MAX_REDIRECTS = 3;
const TYPES: Record<string, StockPhoto['ext']> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

interface Candidate {
  provider: 'pixabay' | 'pexels';
  id: string;
  author: string;
  pageUrl: string;
  /** True for Pixabay illustrations and vectors. */
  drawing: boolean;
  previewUrl: string;
  largeUrl: string;
  /** Used when the large URL cannot be downloaded. */
  largeFallbackUrl?: string;
}

export function toPng(bytes: Buffer): Buffer {
  const pix = new mupdf.Image(bytes).toPixmap();
  const cs = pix.getColorSpace();
  const rgb = cs && (cs.getType() === 'RGB' || cs.getType() === 'Gray') ? pix : pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
  return Buffer.from(rgb.asPNG());
}

const withTimeout = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));

function allowedImageUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** Downloads an image from an allowed host. Follows redirects by hand so each hop is checked. Null on any problem. */
async function downloadImage(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; ext: StockPhoto['ext']; mime: string } | null> {
  const sig = withTimeout(DOWNLOAD_TIMEOUT_MS, signal);
  try {
    let current = allowedImageUrl(url);
    for (let hop = 0; current && hop <= MAX_REDIRECTS; hop++) {
      const res = await deps.fetch(current, { redirect: 'manual', signal: sig });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        current = loc ? allowedImageUrl(new URL(loc, current).href) : null;
        continue;
      }
      if (!res.ok || !res.body) return null;
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const ext = TYPES[mime];
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (!ext || declared > MAX_BYTES) { await res.body.cancel(); return null; }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_BYTES) return null;
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), ext, mime };
    }
  } catch {
    /* network error, timeout or abort */
  }
  return null;
}

async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any | null> {
  try {
    const res = await deps.fetch(url, { headers, signal: withTimeout(SEARCH_TIMEOUT_MS, signal) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function searchPixabay(key: string, query: string, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://pixabay.com/api/?${new URLSearchParams({ key, q: query.slice(0, 100), image_type: 'all', safesearch: 'true', per_page: '10' })}`;
  const data = await getJson(url, {}, signal);
  const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];
  const out: Candidate[] = [];
  for (const h of hits) {
    const web = str(h.webformatURL);
    if (!web || !h.id) continue;
    out.push({
      provider: 'pixabay', id: String(h.id), author: str(h.user), pageUrl: str(h.pageURL),
      drawing: str(h.type) !== '' && str(h.type) !== 'photo',
      previewUrl: web, largeUrl: web.replace('_640', '_960'), largeFallbackUrl: web,
    });
    if (out.length === PER_SERVICE) break;
  }
  return out;
}

async function searchPexels(key: string, query: string, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://api.pexels.com/v1/search?${new URLSearchParams({ query: query.slice(0, 100), per_page: '10' })}`;
  const data = await getJson(url, { Authorization: key }, signal);
  const photos: any[] = Array.isArray(data?.photos) ? data.photos : [];
  const out: Candidate[] = [];
  for (const p of photos) {
    const medium = str(p.src?.medium);
    const large = str(p.src?.large);
    if (!medium || !large || !p.id) continue;
    out.push({ provider: 'pexels', id: String(p.id), author: str(p.photographer), pageUrl: str(p.url), drawing: false, previewUrl: medium, largeUrl: large });
    if (out.length === PER_SERVICE) break;
  }
  return out;
}

function interleave(a: Candidate[], b: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < MAX_CANDIDATES; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i] && out.length < MAX_CANDIDATES) out.push(b[i]);
  }
  return out;
}

const pickSchema = z.object({ pick: z.number().int().nullable(), reason: z.string() });

const PICK_SYSTEM = 'You choose pictures for a university textbook. Be strict: a wrong picture is worse than none.';

function pickPrompt(mustShow: string, count: number): string {
  return [
    `The candidates are the ${count} images attached, in order (1 to ${count}). One of them may go into a university textbook.`,
    `It must show: ${mustShow}`,
    'Answer with the number of the candidate that clearly shows exactly that, or null if none does.',
    'Reject candidates that are blurry, carry a watermark or text overlay, show people posing, or have a decorative stock look. Prefer accuracy over beauty.',
    'In "reason", give one short sentence in English: why the chosen image fits, or why none does.',
  ].join('\n');
}

function creditFor(c: Candidate, language: string): string {
  const it = language.toLowerCase().startsWith('it');
  const what = c.drawing ? (it ? 'Immagine' : 'Image') : it ? 'Foto' : 'Photo';
  const service = c.provider === 'pixabay' ? 'Pixabay' : 'Pexels';
  return `${what}: ${c.author ? `${c.author} / ` : ''}${service}`;
}

export async function findStockPhoto(ctx: AppContext, opts: {
  query: string; mustShow: string; language: string;
  projectId: string; runId?: string; taskId?: string; signal?: AbortSignal;
}): Promise<{ ok: true; photo: StockPhoto } | { ok: false; reason: string }> {
  const keys = stockKeys(ctx);
  if (!keys.pixabay && !keys.pexels) return { ok: false, reason: 'No stock photo service is set up. Add a Pixabay or Pexels key on the Connections screen.' };

  const [fromPixabay, fromPexels] = await Promise.all([
    keys.pixabay ? searchPixabay(keys.pixabay, opts.query, opts.signal) : [],
    keys.pexels ? searchPexels(keys.pexels, opts.query, opts.signal) : [],
  ]);
  const found = interleave(fromPixabay, fromPexels);
  if (!found.length) return { ok: false, reason: `No stock photos found for "${opts.query}".` };

  // Previews that cannot be fetched or converted drop out; the model sees the rest in order.
  const previews = await Promise.all(found.map(async (c) => {
    const img = await downloadImage(c.previewUrl, opts.signal);
    if (!img) return null;
    try { return { c, png: deps.toPng(img.bytes) }; } catch { return null; }
  }));
  const candidates = previews.filter((p): p is { c: Candidate; png: Buffer } => p !== null);
  if (!candidates.length) return { ok: false, reason: 'The candidate previews could not be downloaded.' };

  const { data } = await deps.runRole(ctx, {
    role: 'vision', system: PICK_SYSTEM, prompt: pickPrompt(opts.mustShow, candidates.length),
    images: candidates.map((p) => p.png), schema: pickSchema,
    projectId: opts.projectId, runId: opts.runId, taskId: opts.taskId, signal: opts.signal,
  });
  if (data.pick === null) return { ok: false, reason: `Nothing matched: ${data.reason}` };
  const chosen = Number.isInteger(data.pick) ? candidates[data.pick - 1]?.c : undefined;
  if (!chosen) return { ok: false, reason: 'Nothing matched: the model picked a candidate that does not exist.' };

  const file = (await downloadImage(chosen.largeUrl, opts.signal)) ?? (chosen.largeFallbackUrl ? await downloadImage(chosen.largeFallbackUrl, opts.signal) : null);
  if (!file) return { ok: false, reason: 'The chosen photo could not be downloaded.' };

  return {
    ok: true,
    photo: {
      ...file, provider: chosen.provider, author: chosen.author, pageUrl: chosen.pageUrl, id: chosen.id,
      credit: creditFor(chosen, opts.language), check: data.reason,
    },
  };
}
