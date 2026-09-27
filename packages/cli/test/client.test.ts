import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readingOrder, type Chapter, type Character, type Image, type Manga, type PageDetail, type Settings } from '@manga/shared';
import { ApiClient, ApiError } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('ApiClient', () => {
  it('returns parsed JSON and raises ApiError with the server code, message and details', async () => {
    const api = new ApiClient(h.url);
    expect((await api.get<{ ok: boolean }>('/api/health')).ok).toBe(true);
    const manga = await api.post<Manga>('/api/mangas', { title: 'Client Test', readingDirection: 'ltr' });
    const chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title: 'One' });
    const page = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: '2x2' });
    await expect(api.post(`/api/pages/${page.page.id}/layout/preset`, { preset: 'splash' })).rejects.toMatchObject({
      name: 'ApiError', status: 409, code: 'needs_confirm', details: { removedPanelIds: readingOrder(page.page.layout, 'ltr').slice(1) },
    });
    await expect(api.get('/api/mangas/mg_missing000')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'manga mg_missing000 not found' });
    expect((await api.patch<Settings>('/api/settings', { review: { rounds: 1 } })).review.rounds).toBe(1);
    expect(await api.delete(`/api/mangas/${manga.id}`)).toEqual({ ok: true });
    await expect(api.put('/api/nope', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('uploads a file as multipart with the content type of its extension', async () => {
    const api = new ApiClient(h.url);
    const manga = await api.post<Manga>('/api/mangas', { title: 'Upload Test' });
    const character = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Aiko' });
    const file = join(h.lib, 'portrait.png');
    writeFileSync(file, makePng(12, 16));
    const image = await api.upload<Image>(`/api/characters/${character.id}/upload?slot=portrait`, file);
    expect([image.width, image.height, image.role]).toEqual([12, 16, 'portrait']);
    const unknownExtension = join(h.lib, 'side.dat'); // sent as application/octet-stream; the server reads the bytes (F6)
    writeFileSync(unknownExtension, makePng(5, 7));
    expect((await api.upload<Image>(`/api/characters/${character.id}/upload?slot=side`, unknownExtension)).width).toBe(5);
    await expect(api.upload(`/api/characters/${character.id}/upload?slot=portrait`, join(h.lib, 'missing.png'))).rejects.toMatchObject({ code: 'file' });
  });

  it('reports an unreachable server', async () => {
    await expect(new ApiClient('http://127.0.0.1:9').get('/api/health')).rejects.toMatchObject({
      code: 'unreachable', message: 'server not reachable at http://127.0.0.1:9',
    });
  });
});
