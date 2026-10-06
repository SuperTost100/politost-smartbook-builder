import type { Api, ApiError } from '@smartbuilder/domain';

type PathParams<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
  ? P | PathParams<`/${Rest}`>
  : S extends `${string}:${infer P}`
    ? P
    : never;

type BodyOf<K extends keyof Api> = Api[K] extends { body: infer B } ? B : never;
type ResOf<K extends keyof Api> = Api[K]['res'];

type Query = Record<string, string | number | boolean | undefined | null>;

export type ApiOpts<K extends keyof Api & string> = ([PathParams<K>] extends [never]
  ? { params?: undefined }
  : { params: Record<PathParams<K>, string | number> }) &
  ([BodyOf<K>] extends [never] ? { body?: undefined } : { body: BodyOf<K> }) & {
    query?: Query;
    /** multipart/form-data body, for the upload routes. */
    form?: FormData;
    signal?: AbortSignal;
  };

type NeedsOpts<K extends keyof Api & string> = [PathParams<K>] extends [never]
  ? [BodyOf<K>] extends [never]
    ? false
    : true
  : true;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly action?: string;
  readonly item?: string;
  constructor(status: number, code: string, message: string, action?: string, item?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.action = action;
    this.item = item;
  }
}

function fillPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  const s = usp.toString();
  return s ? `${path}?${s}` : path;
}

/** Builds a URL for a route, for <img src>, downloads and EventSource. */
export function apiUrl<K extends keyof Api & string>(route: K, ...args: NeedsOpts<K> extends true ? [opts: Pick<ApiOpts<K>, 'params' | 'query'>] : [opts?: Pick<ApiOpts<K>, 'params' | 'query'>]): string {
  const opts = (args[0] ?? {}) as { params?: Record<string, string | number>; query?: Query };
  const path = route.slice(route.indexOf(' ') + 1);
  return withQuery(fillPath(path, opts.params), opts.query);
}

export async function api<K extends keyof Api & string>(route: K, ...args: NeedsOpts<K> extends true ? [opts: ApiOpts<K>] : [opts?: ApiOpts<K>]): Promise<ResOf<K>> {
  const opts = (args[0] ?? {}) as { params?: Record<string, string | number>; body?: unknown; query?: Query; form?: FormData; signal?: AbortSignal };
  const space = route.indexOf(' ');
  const method = route.slice(0, space);
  const url = withQuery(fillPath(route.slice(space + 1), opts.params), opts.query);
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers, signal: opts.signal };
  if (method !== 'GET') headers['x-smartbuilder'] = '1';
  if (opts.form) {
    init.body = opts.form;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'offline', 'The Smart Builder service did not answer.', 'Check that the service is running, then reload this page.');
  }

  if (!res.ok) {
    let parsed: ApiError | null = null;
    try {
      parsed = (await res.json()) as ApiError;
    } catch {
      /* not JSON */
    }
    const err = parsed?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `The service answered with status ${res.status}.`,
      err?.action,
      err?.item,
    );
  }
  if (res.status === 204) return undefined as unknown as ResOf<K>;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return (await res.json()) as ResOf<K>;
  return (await res.blob()) as ResOf<K>;
}

/** Plain-language view of any thrown value. */
export function describeError(e: unknown): { message: string; action?: string; status?: number; code?: string } {
  if (e instanceof ApiRequestError) return { message: e.message, action: e.action, status: e.status, code: e.code };
  if (e instanceof Error) return { message: e.message };
  return { message: 'Something unexpected happened.' };
}

export function errorText(e: unknown): string {
  const d = describeError(e);
  return d.action ? `${d.message} ${d.action}` : d.message;
}

export function isConflict(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status === 409;
}
