import type { ApiErrorBody } from '@manga/shared';

/** Thrown for every non-2xx response, and for network failures (status 0, code 'network'). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null || !('error' in v)) return false;
  const e = (v as { error: unknown }).error;
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/** Same method set as the CLI ApiClient (Contract D), except that `upload` takes a Blob instead of a file path. */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  get<T>(path: string): Promise<T> { return this.json<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.json<T>('POST', path, body); }
  patch<T>(path: string, body: unknown): Promise<T> { return this.json<T>('PATCH', path, body); }
  put<T>(path: string, body: unknown): Promise<T> { return this.json<T>('PUT', path, body); }
  delete<T>(path: string): Promise<T> { return this.json<T>('DELETE', path); }

  /** Images may be PNG or JPEG (the server sniffs the bytes), so the caller passes the real file name. */
  upload<T>(path: string, file: Blob, filename = 'upload'): Promise<T> {
    const form = new FormData();
    form.append('file', file, filename);
    return this.send<T>(path, { method: 'POST', body: form });
  }

  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    // Fastify rejects an empty body declared as JSON, so a bodiless call sends no content-type.
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return this.send<T>(path, init);
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (err) {
      throw new ApiError(0, 'network', `Server not reachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    const data = text ? parseJson(text) : null;
    if (!res.ok) {
      const body = isErrorBody(data) ? data.error : null;
      throw new ApiError(res.status, body?.code ?? 'internal', body?.message ?? `${res.status} ${res.statusText}`.trim(), body?.details);
    }
    return data as T;
  }
}

export const api = new ApiClient('');

/**
 * One API path segment (I1). Every id placed in an API path goes through this, so a crafted id (a route param, say)
 * can never add path segments, a query or a fragment. The URL parser resolves `.` and `..` segments even when they are
 * percent-encoded, so those (and an empty id) are refused with an ApiError before any request is sent.
 */
export function seg(id: string | null | undefined): string {
  if (id === undefined || id === null || id === '' || id === '.' || id === '..') throw new ApiError(0, 'validation', `Invalid id "${id ?? ''}"`);
  return encodeURIComponent(id);
}

/** The `.png` suffix keeps the segment from ever being a dot segment, so this only encodes. */
export function imageUrl(imageId: string): string {
  return `/files/images/${encodeURIComponent(imageId)}.png`;
}
