// Fetch a web page without letting the user point the service at its own machine or network (SSRF).
// Every hop resolves DNS, rejects non-public addresses, and connects to the address that was checked.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ExtractError } from './errors.ts';

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 20_000;

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const blocked4 = new net.BlockList();
for (const [a, p] of V4_BLOCKED) blocked4.addSubnet(a, p, 'ipv4');

function expandV6(addr: string): number[] | null {
  let a = addr.toLowerCase().split('%')[0];
  if (a.includes('.')) {
    // Trailing dotted quad.
    const i = a.lastIndexOf(':');
    const quad = a.slice(i + 1).split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => !(n >= 0 && n <= 255))) return null;
    a = a.slice(0, i + 1) + (quad[0] * 256 + quad[1]).toString(16) + ':' + (quad[2] * 256 + quad[3]).toString(16);
  }
  const [head, tail, extra] = a.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = 8 - h.length - t.length;
  if (tail === undefined ? h.length !== 8 : fill < 0) return null;
  const groups = tail === undefined ? h : [...h, ...Array(fill).fill('0'), ...t];
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.length === 8 && nums.every((n) => n >= 0 && n <= 0xffff) ? nums : null;
}

/** True when the address is not a public unicast address (loopback, private, link-local, CGNAT, multicast, unspecified, reserved). */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (family === 6) {
    const g = expandV6(address);
    if (!g) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    if (zeros(8) || (zeros(7) && g[7] === 1)) return true; // :: and ::1
    if (zeros(5) && g[5] === 0xffff) return blocked4.check(v4(g[6], g[7]), 'ipv4'); // ::ffff:a.b.c.d
    if (zeros(6)) return blocked4.check(v4(g[6], g[7]), 'ipv4'); // deprecated IPv4-compatible
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blocked4.check(v4(g[6], g[7]), 'ipv4'); // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
    if (g[0] === 0x2002) return blocked4.check(v4(g[1], g[2]), 'ipv4'); // 6to4 embeds an IPv4
    return false;
  }
  return true;
}

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  body: Buffer;
  redirects: string[];
}

export interface SafeFetchOptions {
  signal?: AbortSignal;
  /** Tests only: skip the address policy so a local fixture server can be reached. Never set from user input. */
  allowPrivate?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

/** The error for a signal that fired: timeout or cancellation. */
function abortError(signal: AbortSignal): Error {
  const timedOut = (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
  return timedOut ? new ExtractError('The page took longer than 20 seconds to answer.', 400, 'url_timeout') : Object.assign(new Error('Fetch was cancelled.'), { name: 'AbortError' });
}

/** Settles with the promise, or with the abort error as soon as the signal fires (for steps that cannot be cancelled, like DNS). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function refuse(url: string, why: string): never {
  throw new ExtractError(`That address cannot be fetched (${why}).`, 400, 'url_refused', 'Use a public http or https page, or upload the file instead.');
}

async function resolvePublic(host: string, url: string, allowPrivate: boolean): Promise<{ address: string; family: number }[]> {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  let addrs: { address: string; family: number }[];
  if (net.isIP(bare)) addrs = [{ address: bare, family: net.isIP(bare) }];
  else {
    try {
      addrs = await dns.lookup(bare, { all: true, verbatim: true });
    } catch {
      throw new ExtractError(`The host "${bare}" could not be found.`, 400, 'url_unreachable', 'Check the address and try again.');
    }
  }
  if (!addrs.length) throw new ExtractError(`The host "${bare}" has no address.`, 400, 'url_unreachable');
  if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) refuse(url, 'it points to a private or local network address');
  return addrs;
}

/** GET with manual redirects, DNS pinning, size and time limits. Only text/html and text/plain are accepted. */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  let current: URL;
  try {
    current = new URL(input.trim());
  } catch {
    throw new ExtractError('That is not a valid web address.', 400, 'url_invalid', 'Paste a full address starting with https://.');
  }
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') refuse(current.href, `only http and https are supported, not ${current.protocol}`);
    if (current.username || current.password) refuse(current.href, 'addresses with a user name or password are not supported');
    const addrs = await abortable(resolvePublic(current.hostname, current.href, !!opts.allowPrivate), signal);
    const res = await requestOnce(current, addrs, signal, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= MAX_REDIRECTS) throw new ExtractError(`The page redirected more than ${MAX_REDIRECTS} times.`, 400, 'url_redirects');
      current = new URL(res.location, current);
      redirects.push(current.href);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new ExtractError(`The page answered with status ${res.status}.`, 400, 'url_status', 'Open it in a browser to check it is public.');
    const type = res.contentType.split(';')[0].trim().toLowerCase();
    if (type !== 'text/html' && type !== 'text/plain') {
      throw new ExtractError(`Only web pages and plain text are supported (this one is ${type || 'of unknown type'}).`, 400, 'url_type', 'Download the file and upload it instead.');
    }
    return { finalUrl: current.href, contentType: res.contentType, body: res.body, redirects };
  }
}

interface Once { status: number; location: string | null; contentType: string; body: Buffer }

function requestOnce(url: URL, addrs: { address: string; family: number }[], signal: AbortSignal, maxBytes: number): Promise<Once> {
  return new Promise<Once>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const req = lib.request(
      {
        method: 'GET',
        host,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          host: url.host,
          'user-agent': 'PoliTost-Smart-Builder/0.1 (+local)',
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
        },
        // Connect only to the addresses that passed the policy check (no second, unchecked resolution).
        lookup: (_h, options, cb) => {
          const list = addrs.map((a) => ({ address: a.address, family: a.family }));
          if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: typeof list) => void)(null, list);
          else cb(null, list[0].address, list[0].family);
        },
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const type = contentType.split(';')[0].trim().toLowerCase();
        if (status >= 200 && status < 300 && type !== 'text/html' && type !== 'text/plain') {
          res.resume();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes && !res.headers['content-encoding']) {
          res.resume();
          return reject(tooLarge(maxBytes));
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
        const chunks: Buffer[] = [];
        let size = 0;
        const sink = new Writable({
          write(c: Buffer, _enc, cb) {
            size += c.length;
            if (size > maxBytes) return cb(tooLarge(maxBytes));
            chunks.push(c);
            cb();
          },
        });
        // pipeline forwards errors and premature close of the response to the decoder and sink, and the signal ends all of them.
        pipeline(decoder ? [res, decoder, sink] : [res, sink], { signal }).then(
          () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }),
          (err: Error) => {
            req.destroy();
            if (err instanceof ExtractError) return reject(err);
            if (signal.aborted) return reject(abortError(signal));
            reject(unreachable(err));
          },
        );
      },
    );
    req.on('error', (err) => reject(signal.aborted ? abortError(signal) : unreachable(err)));
    req.end();
  });
}

const unreachable = (err: Error) => new ExtractError(`The page could not be fetched (${err.message}).`, 400, 'url_unreachable', 'Check the address and your connection.');
const tooLarge = (max: number) => new ExtractError(`The page is larger than ${Math.round(max / 1024 / 1024)} MB.`, 400, 'url_size', 'Save the page as PDF and upload that instead.');
