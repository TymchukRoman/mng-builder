import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, imageUrl, seg } from '../src/api';

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(status: number, body: string, calls: Call[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
}

describe('ApiClient', () => {
  it('sends JSON bodies and parses JSON responses', async () => {
    const calls: Call[] = [];
    const client = new ApiClient('http://x', fakeFetch(200, '{"id":"mg_1"}', calls));
    const out = await client.post<{ id: string }>('/api/mangas', { title: 'A' });
    expect(out).toEqual({ id: 'mg_1' });
    expect(calls[0]?.url).toBe('http://x/api/mangas');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"title":"A"}');
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
  });

  it('sends no body and no content-type for a bodiless POST', async () => {
    const calls: Call[] = [];
    const client = new ApiClient('', fakeFetch(200, '{"jobId":"jb_1"}', calls));
    await client.post('/api/characters/cr_1/sheet');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(new Headers(calls[0]?.init?.headers).has('content-type')).toBe(false);
  });

  it('maps ApiErrorBody into ApiError', async () => {
    const body = JSON.stringify({ error: { code: 'needs_confirm', message: 'Panels would be removed', details: { removedPanelIds: ['pn_1'] } } });
    const client = new ApiClient('', fakeFetch(409, body, []));
    const err = await client.post('/api/pages/pg_1/layout/preset', { preset: 'splash' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe('needs_confirm');
    expect(apiErr.message).toBe('Panels would be removed');
    expect(apiErr.details).toEqual({ removedPanelIds: ['pn_1'] });
  });

  it('falls back to code internal for non-JSON errors', async () => {
    const client = new ApiClient('', async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    const err = (await client.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('internal');
    expect(err.status).toBe(500);
    expect(err.message).toBe('500 Internal Server Error');
  });

  it('maps a network failure to code network with status 0', async () => {
    const client = new ApiClient('', async () => { throw new TypeError('fetch failed'); });
    const err = (await client.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
    expect(err.message).toContain('fetch failed');
  });

  it('uploads multipart form data under the field "file"', async () => {
    const calls: Call[] = [];
    const client = new ApiClient('', fakeFetch(200, '{"id":"im_1"}', calls));
    await client.upload('/api/panels/pn_1/upload', new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'a.png');
    const form = calls[0]?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('file') as File).name).toBe('a.png');
  });

  it('returns null for an empty 200 body', async () => {
    const client = new ApiClient('', async () => new Response('', { status: 200 }));
    expect(await client.delete('/api/images/im_1')).toBeNull();
  });

  it('builds image URLs', () => {
    expect(imageUrl('im_abc')).toBe('/files/images/im_abc.png');
  });
  it('encodes image ids in image URLs', () => {
    expect(imageUrl('x/../../api/shutdown?')).toBe('/files/images/x%2F..%2F..%2Fapi%2Fshutdown%3F.png');
  });
});

describe('seg (I1: every id placed in an API path)', () => {
  it('passes a real id through unchanged', () => {
    expect(seg('mg_k3j9x2abq7')).toBe('mg_k3j9x2abq7');
  });
  it('encodes slashes, query and fragment marks and percent signs, so an id stays one segment', () => {
    expect(seg('x/../../shutdown?')).toBe('x%2F..%2F..%2Fshutdown%3F');
    expect(seg('a#b')).toBe('a%23b');
    expect(seg('%2F')).toBe('%252F');
  });
  it('refuses the dot segments and an empty id, which the URL parser would resolve even when encoded', () => {
    for (const bad of ['.', '..', '', undefined, null]) expect(() => seg(bad), String(bad)).toThrow(ApiError);
  });
  it('a crafted id cannot leave its path position', () => {
    const url = new URL(`/api/mangas/${seg('x/../../shutdown?')}/cover`, 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/mangas/x%2F..%2F..%2Fshutdown%3F/cover');
    expect(url.search).toBe('');
  });
});
