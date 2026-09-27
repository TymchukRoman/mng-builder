import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ApiErrorBody } from '@manga/shared';

/** status 0 = no HTTP response: code 'unreachable' (no server) or 'file' (upload file unreadable). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.json<T>('DELETE', path);
  }

  /** multipart/form-data with the file in field `file`; content type from the extension. */
  async upload<T>(path: string, filePath: string): Promise<T> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      throw new ApiError(0, 'file', `cannot read ${filePath}`);
    }
    const form = new FormData();
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), basename(filePath));
    return this.send<T>('POST', path, { body: form });
  }

  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  private async send<T>(method: string, path: string, init: { body?: NonNullable<RequestInit['body']>; headers?: Record<string, string> }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, ...init });
    } catch {
      throw new ApiError(0, 'unreachable', `server not reachable at ${this.baseUrl}`);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const error = (data as Partial<ApiErrorBody> | null)?.error;
      throw new ApiError(res.status, error?.code ?? `http_${res.status}`, error?.message ?? `${method} ${path} failed with HTTP ${res.status}`, error?.details);
    }
    return data as T;
  }
}
