// Photos from Wikimedia Commons, Pixabay and Pexels: search them, let the vision model pick one that really shows the thing,
// download it. Commons needs no key and has the lab and specimen photos the stock services lack.
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

/** Photos can always be searched: Wikimedia Commons needs no key. Tests turn Commons off. */
export function photosAvailable(ctx: AppContext): boolean {
  return deps.commons || hasStockKeys(ctx);
}

type Provider = 'commons' | 'pixabay' | 'pexels';

export interface StockPhoto {
  bytes: Buffer;
  ext: '.jpg' | '.png' | '.webp';
  mime: string;
  provider: Provider;
  author: string;
  pageUrl: string;
  id: string;
  /** Licence of a Commons file, e.g. "CC BY-SA 4.0"; null for Pixabay and Pexels, whose licences need no notice. */
  license: string | null;
  /** Caption credit, e.g. "Foto: Mario Rossi / Pexels" or "Foto: Mario Rossi / Wikimedia Commons, CC BY-SA 4.0". */
  credit: string;
  /** One sentence: why the vision model accepted it. */
  check: string;
}

export interface StockDeps {
  fetch: typeof fetch;
  runRole: <T>(ctx: AppContext, opts: RunRoleOptions<T>) => Promise<RunRoleResult<T>>;
  /** Any supported image to PNG, for the model runner. */
  toPng: (bytes: Buffer) => Buffer;
  /** Search Wikimedia Commons (no key needed). */
  commons: boolean;
}

const defaults: StockDeps = {
  fetch: (...a) => fetch(...a),
  runRole: (ctx, opts) => runRole(ctx, opts),
  toPng,
  commons: true,
};

export const deps: StockDeps = { ...defaults };

/** Override collaborators (tests). Call with no argument to restore the defaults. */
export function setStockDeps(partial?: Partial<StockDeps>) {
  Object.assign(deps, defaults, partial ?? {});
}

const IMAGE_HOSTS = new Set(['pixabay.com', 'cdn.pixabay.com', 'images.pexels.com', 'upload.wikimedia.org', 'thumb.wikimedia.org']);
// Wikimedia asks API clients for a User-Agent that names the tool and a way to reach its authors.
const USER_AGENT = 'PolitostSmartbookBuilder/0.2 (https://github.com/SuperTost100/politost-smartbook-builder)';
// Commons only serves thumbnails at standard widths (500 and 960 work, 640 does not).
const COMMONS_PREVIEW = 500;
const COMMONS_LARGE = 960;
// Licences a book can carry with a credit line. GFDL-only files need the whole licence text, so they are skipped.
const COMMONS_LICENSES = /^(cc0|public domain|pd\b|cc[ -]by(-sa)? \d(\.\d)?)/i;
const MAX_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const PER_SERVICE = 6;
const MAX_CANDIDATES = 10;
const MAX_REDIRECTS = 3;
const TYPES: Record<string, StockPhoto['ext']> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

interface Candidate {
  provider: Provider;
  id: string;
  author: string;
  pageUrl: string;
  license: string | null;
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
      const res = await deps.fetch(current, { redirect: 'manual', signal: sig, headers: { 'User-Agent': USER_AGENT } });
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
    const res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: withTimeout(SEARCH_TIMEOUT_MS, signal) });
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
      provider: 'pixabay', id: String(h.id), author: str(h.user), pageUrl: str(h.pageURL), license: null,
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
    out.push({ provider: 'pexels', id: String(p.id), author: str(p.photographer), pageUrl: str(p.url), license: null, drawing: false, previewUrl: medium, largeUrl: large });
    if (out.length === PER_SERVICE) break;
  }
  return out;
}

/** Commons' Artist field is HTML (often a user page link); the credit needs its text. */
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function searchCommons(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: `${query.slice(0, 100)} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '10',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: String(COMMONS_LARGE), iiextmetadatafilter: 'LicenseShortName|Artist',
  })}`;
  const data = await getJson(url, {}, signal);
  const pages: any[] = Array.isArray(data?.query?.pages) ? [...data.query.pages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  const out: Candidate[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    const license = str(ii?.extmetadata?.LicenseShortName?.value).trim();
    if (!ii || !TYPES[str(ii.mime)] || !COMMONS_LICENSES.test(license)) continue;
    const large = str(ii.thumburl) || str(ii.url);
    if (!large) continue;
    // A thumbnail URL ends in /<width>px-<name>; the preview is the same file at the smaller standard width.
    const preview = Number(ii.width) > COMMONS_PREVIEW && large.includes(`/${COMMONS_LARGE}px-`) ? large.replace(`/${COMMONS_LARGE}px-`, `/${COMMONS_PREVIEW}px-`) : large;
    out.push({
      provider: 'commons', id: str(p.title), author: plainText(str(ii.extmetadata?.Artist?.value)), pageUrl: str(ii.descriptionurl), license,
      drawing: str(ii.mime) !== 'image/jpeg', previewUrl: preview, largeUrl: large,
    });
    if (out.length === PER_SERVICE) break;
  }
  return out;
}

function interleave(...lists: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
    for (const l of lists) if (l[i] && out.length < MAX_CANDIDATES) out.push(l[i]);
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
    'Reject candidates that are blurry, carry a watermark or text overlay, are drawings or diagrams with written labels, show people posing, or have a decorative stock look. Prefer accuracy over beauty.',
    'In "reason", give one short sentence in English: why the chosen image fits, or why none does.',
  ].join('\n');
}

function creditFor(c: Candidate, language: string): string {
  const it = language.toLowerCase().startsWith('it');
  const what = c.drawing ? (it ? 'Immagine' : 'Image') : it ? 'Foto' : 'Photo';
  const service = c.provider === 'commons' ? 'Wikimedia Commons' : c.provider === 'pixabay' ? 'Pixabay' : 'Pexels';
  return `${what}: ${c.author ? `${c.author} / ` : ''}${service}${c.license ? `, ${c.license}` : ''}`;
}

export async function findStockPhoto(ctx: AppContext, opts: {
  query: string; mustShow: string; language: string;
  projectId: string; runId?: string; taskId?: string; signal?: AbortSignal;
}): Promise<{ ok: true; photo: StockPhoto } | { ok: false; reason: string }> {
  const keys = stockKeys(ctx);
  if (!photosAvailable(ctx)) return { ok: false, reason: 'No photo service is set up. Add a Pixabay or Pexels key on the Connections screen.' };

  const [fromCommons, fromPixabay, fromPexels] = await Promise.all([
    deps.commons ? searchCommons(opts.query, opts.signal) : [],
    keys.pixabay ? searchPixabay(keys.pixabay, opts.query, opts.signal) : [],
    keys.pexels ? searchPexels(keys.pexels, opts.query, opts.signal) : [],
  ]);
  const found = interleave(fromCommons, fromPixabay, fromPexels);
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
      ...file, provider: chosen.provider, author: chosen.author, pageUrl: chosen.pageUrl, id: chosen.id, license: chosen.license,
      credit: creditFor(chosen, opts.language), check: data.reason,
    },
  };
}
