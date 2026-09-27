import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, STYLE_PRESETS, type Character, type Image, type Manga, type PageDetail, type ServerEvent } from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { multipart, uploadWhile } from './helpers/multipart.js';
import { makeJpegHeader, makePng } from './helpers/png.js';

type ErrorReply = { error: { code: string; message: string; details?: unknown } };

let t: TestApp;
let events: ServerEvent[];

beforeEach(async () => {
  t = await makeTestApp();
  events = [];
  t.deps.bus.on((e) => events.push(e));
});
afterEach(async () => {
  await t.close();
});

async function newManga(title = 'Oni'): Promise<Manga> {
  return (await call<Manga>(t.app, 'POST', '/api/mangas', { title })).body;
}
async function newCharacter(mangaId: string, name = 'Aiko'): Promise<Character> {
  return (await call<Character>(t.app, 'POST', `/api/mangas/${mangaId}/characters`, { name })).body;
}
function upload(url: string, filename: string, contentType: string, data: Buffer) {
  const form = multipart('file', filename, contentType, data);
  return t.app.inject({ method: 'POST', url, payload: form.payload, headers: form.headers });
}

describe('mangas', () => {
  it('creates with defaults, lists, reads, updates, and emits entity events', async () => {
    const created = await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Oni' });
    expect(created.status).toBe(200);
    const m = created.body;
    expect(m).toMatchObject({
      title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl',
      pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']?.styleGuide, coverPageId: null,
    });
    expect((await call<Manga[]>(t.app, 'GET', '/api/mangas')).body).toEqual([m]);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${m.id}`)).body).toEqual(m);
    expect((await call<Manga>(t.app, 'PATCH', `/api/mangas/${m.id}`, { title: 'Oni II', language: 'uk' })).body).toMatchObject({ title: 'Oni II', language: 'uk' });
    expect(events).toEqual([
      { type: 'entity', entity: 'manga', id: m.id, op: 'created', mangaId: m.id },
      { type: 'entity', entity: 'manga', id: m.id, op: 'updated', mangaId: m.id },
    ]);
  });

  it('takes the colour mode from the style preset unless the request sets one, which then wins (F3)', async () => {
    const create = async (body: Record<string, unknown>) => (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'X', ...body })).body.colorMode;
    expect(await create({ stylePreset: 'anime-color' })).toBe('color');
    expect(await create({ stylePreset: 'anime-color', colorMode: 'bw' })).toBe('bw');
    expect(await create({ stylePreset: 'manga-bw', colorMode: 'color' })).toBe('color');
    expect(await create({})).toBe('bw');
  });

  it('rejects bad input with 400 validation and unknown ids with 404 not_found', async () => {
    const noTitle = await call<ErrorReply>(t.app, 'POST', '/api/mangas', {});
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error.code).toBe('validation');
    expect(noTitle.body.error.message).toMatch(/^title: /);
    expect((await call<ErrorReply>(t.app, 'POST', '/api/mangas', { title: 'X', stylePreset: 'nope' })).body.error.code).toBe('validation');
    const m = await newManga();
    expect((await call(t.app, 'PATCH', `/api/mangas/${m.id}`, { language: 'fr' })).status).toBe(400);
    expect(await call(t.app, 'GET', '/api/mangas/mg_missing000')).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'manga mg_missing000 not found' } } });
    expect((await call(t.app, 'DELETE', '/api/mangas/mg_missing000')).status).toBe(404);
  });

  it('creates the manga cover once', async () => {
    const m = await newManga();
    const first = await call<PageDetail>(t.app, 'POST', `/api/mangas/${m.id}/cover`);
    expect(first.body.page).toMatchObject({ kind: 'cover', chapterId: null, mangaId: m.id });
    expect(first.body.panels).toHaveLength(1);
    expect((await call<PageDetail>(t.app, 'POST', `/api/mangas/${m.id}/cover`)).body.page.id).toBe(first.body.page.id);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${m.id}`)).body.coverPageId).toBe(first.body.page.id);
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'page')).toHaveLength(1);
  });

  it('deletes a manga with everything under it and its image folder', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    expect((await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(8, 8))).statusCode).toBe(200);
    expect(existsSync(join(t.lib, 'mangas', m.id))).toBe(true);
    expect(await call(t.app, 'DELETE', `/api/mangas/${m.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/mangas/${m.id}`)).status).toBe(404);
    expect((await call(t.app, 'GET', `/api/characters/${c.id}`)).status).toBe(404);
    expect(existsSync(join(t.lib, 'mangas', m.id))).toBe(false);
  });
});

describe('characters', () => {
  it('creates with a random seed unless one is given, lists, updates and deletes', async () => {
    const m = await newManga();
    const a = await newCharacter(m.id);
    expect(a).toMatchObject({ name: 'Aiko', role: 'supporting', refs: {}, recipe: null, mangaId: m.id });
    expect(Number.isInteger(a.seed)).toBe(true);
    const b = (await call<Character>(t.app, 'POST', `/api/mangas/${m.id}/characters`, { name: 'Ren', seed: 42, role: 'main' })).body;
    expect(b).toMatchObject({ seed: 42, role: 'main' });
    expect((await call<Character[]>(t.app, 'GET', `/api/mangas/${m.id}/characters`)).body.map((c) => c.name)).toEqual(['Aiko', 'Ren']);
    expect((await call<Character>(t.app, 'PATCH', `/api/characters/${a.id}`, { appearanceTags: '1girl, red hair' })).body.appearanceTags).toBe('1girl, red hair');
    expect((await call(t.app, 'PATCH', `/api/characters/${a.id}`, { role: 'hero' })).status).toBe(400);
    expect((await call(t.app, 'GET', '/api/mangas/mg_missing000/characters')).status).toBe(404);
    expect(await call(t.app, 'DELETE', `/api/characters/${b.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/characters/${b.id}`)).status).toBe(404);
  });

  it('uploads a PNG into a ref slot, lists it, sets refs, and serves it under /files', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const png = makePng(64, 96);
    const res = await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'portrait.png', 'image/png', png);
    expect(res.statusCode).toBe(200);
    const image = res.json() as Image;
    expect(image).toMatchObject({
      ownerType: 'character', ownerId: c.id, role: 'portrait', width: 64, height: 96, source: 'uploaded',
      path: `mangas/${m.id}/images/${image.id}.png`, gen: null, review: null, parentImageId: null,
    });
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({ portrait: image.id });
    expect((await call<Image[]>(t.app, 'GET', `/api/characters/${c.id}/images`)).body.map((i) => i.id)).toEqual([image.id]);
    expect((await call<Image>(t.app, 'GET', `/api/images/${image.id}`)).body).toEqual(image);
    const file = await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(png)).toBe(true);
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'created', mangaId: m.id });
  });

  it('judges an upload by its bytes, not its declared type: a PNG sent as application/octet-stream is accepted (F6)', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const res = await upload(`/api/characters/${c.id}/upload?slot=back`, 'back.bin', 'application/octet-stream', makePng(6, 9));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 6, height: 9, role: 'back' });
  });

  it('re-checks the character after reading the upload: deleted meanwhile gives 404 and leaves no Image row or file (F7)', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const res = await uploadWhile(t.app, `/api/characters/${c.id}/upload?slot=portrait`, makePng(4, 4), async () => {
      expect((await call(t.app, 'DELETE', `/api/characters/${c.id}`)).status).toBe(200);
    });
    expect([res.statusCode, res.json()]).toEqual([404, { error: { code: 'not_found', message: `character ${c.id} not found` } }]);
    expect(t.deps.store.images.listByManga(m.id)).toEqual([]);
    expect(readdirSync(join(t.lib, 'mangas', m.id, 'images'))).toEqual([]);
  });

  it('keeps an uploaded JPEG as-is and serves it as image/jpeg', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const jpeg = makeJpegHeader(300, 200);
    const image = (await upload(`/api/characters/${c.id}/upload?slot=side`, 'side.jpg', 'image/jpeg', jpeg)).json() as Image;
    expect([image.width, image.height, image.role]).toEqual([300, 200, 'side']);
    const file = await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` });
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.rawPayload.equals(jpeg)).toBe(true);
  });

  it('rejects uploads that are not PNG/JPEG or lack a slot or a file, writing nothing', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const base = `/api/characters/${c.id}/upload`;
    const cases: Array<[string, string, string, Buffer]> = [
      [`${base}?slot=portrait`, 'notes.png', 'image/png', Buffer.from('definitely not a png')],
      [`${base}?slot=portrait`, 'anim.gif', 'image/gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
      [`${base}?slot=face`, 'p.png', 'image/png', makePng(2, 2)],
      [base, 'p.png', 'image/png', makePng(2, 2)],
    ];
    for (const [url, name, type, data] of cases) {
      const res = await upload(url, name, type, data);
      expect(res.statusCode, `${url} ${name}`).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    }
    const json = await call<ErrorReply>(t.app, 'POST', `${base}?slot=portrait`, { file: 'x' });
    expect(json.status).toBe(400);
    expect(json.body.error.message).toMatch(/multipart/);
    expect(existsSync(join(t.lib, 'mangas'))).toBe(false);
    expect((await call<Image[]>(t.app, 'GET', `/api/characters/${c.id}/images`)).body).toEqual([]);
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({});
  });

  it("picks an owned image as a ref and refuses another character's image or an unknown slot", async () => {
    const m = await newManga();
    const a = await newCharacter(m.id);
    const b = await newCharacter(m.id, 'Ren');
    const image = (await upload(`/api/characters/${a.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(4, 4))).json() as Image;
    const picked = await call<Character>(t.app, 'POST', `/api/characters/${a.id}/refs/fullbody`, { imageId: image.id });
    expect(picked.body.refs).toEqual({ portrait: image.id, fullbody: image.id });
    expect((await call<ErrorReply>(t.app, 'POST', `/api/characters/${b.id}/refs/portrait`, { imageId: image.id })).body.error.code).toBe('validation');
    expect((await call(t.app, 'POST', `/api/characters/${a.id}/refs/face`, { imageId: image.id })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/characters/${a.id}/refs/portrait`, { imageId: 'im_missing000' })).status).toBe(404);
  });

  it('deletes an image, clearing the refs and the file', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const image = (await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'p.png', 'image/png', makePng(4, 4))).json() as Image;
    expect(await call(t.app, 'DELETE', `/api/images/${image.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call<Character>(t.app, 'GET', `/api/characters/${c.id}`)).body.refs).toEqual({});
    expect(existsSync(join(t.lib, image.path))).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` })).statusCode).toBe(404);
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: c.id, op: 'updated', mangaId: m.id });
  });
});

describe('/files/images', () => {
  it('streams the file from disk with its length and sniffed type, and 404s when the file is gone (F16)', async () => {
    const m = await newManga();
    const c = await newCharacter(m.id);
    const png = makePng(640, 480);
    const image = (await upload(`/api/characters/${c.id}/upload?slot=portrait`, 'p.png', 'image/png', png)).json() as Image;
    const res = await t.app.inject({ method: 'GET', url: `/files/images/${image.id}.png` });
    expect([res.statusCode, res.headers['content-type'], res.headers['content-length']]).toEqual([200, 'image/png', String(png.length)]);
    expect(res.rawPayload.equals(png)).toBe(true);
    rmSync(join(t.lib, image.path));
    expect(await call(t.app, 'GET', `/files/images/${image.id}.png`)).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('404s for unknown ids, other extensions and path tricks', async () => {
    for (const url of ['/files/images/im_missing000.png', '/files/images/im_missing000', '/files/images/..%2F..%2Flibrary.sqlite', '/files/images/..%2Fx.png']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});
