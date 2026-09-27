import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SCRIPT, panelIds, readingOrder,
  type Chapter, type Character, type Image, type Manga, type Page, type PageDetail, type Panel, type ServerEvent, type TextFrame,
} from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { multipart, uploadWhile } from './helpers/multipart.js';
import { makePng } from './helpers/png.js';

type ErrorReply = { error: { code: string; message: string; details?: { removedPanelIds?: string[] } } };

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

async function seed(readingDirection: 'ltr' | 'rtl' = 'ltr'): Promise<{ manga: Manga; chapter: Chapter }> {
  const manga = (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Oni', readingDirection })).body;
  const chapter = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  return { manga, chapter };
}

async function addPage(chapterId: string, body: Record<string, unknown> = {}): Promise<PageDetail> {
  const r = await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapterId}/pages`, body);
  expect(r.status).toBe(200);
  return r.body;
}

function uploadTo(panelId: string, data: Buffer) {
  const form = multipart('file', 'art.png', 'image/png', data);
  return t.app.inject({ method: 'POST', url: `/api/panels/${panelId}/upload`, payload: form.payload, headers: form.headers });
}

describe('chapters', () => {
  it('numbers chapters 1, 2, … and lists, patches and deletes them', async () => {
    const { manga, chapter } = await seed();
    expect(chapter).toMatchObject({ number: 1, title: 'One', status: 'draft', order: 0, coverPageId: null, synopsis: '' });
    const two = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'Two' })).body;
    expect(two.number).toBe(2);
    expect((await call<Chapter[]>(t.app, 'GET', `/api/mangas/${manga.id}/chapters`)).body.map((c) => c.id)).toEqual([chapter.id, two.id]);
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${two.id}`, { title: 'Second', status: 'ready' })).body).toMatchObject({ title: 'Second', status: 'ready' });
    expect((await call(t.app, 'PATCH', `/api/chapters/${two.id}`, { status: 'done' })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, {})).status).toBe(400);
    expect(await call(t.app, 'DELETE', `/api/chapters/${two.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/chapters/${two.id}`)).status).toBe(404);
  });

  it('renumbers a chapter only to a number no other chapter of the manga has: 409 conflict otherwise (F9)', async () => {
    const { manga, chapter } = await seed();
    const two = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'Two' })).body;
    const clash = await call<ErrorReply>(t.app, 'PATCH', `/api/chapters/${two.id}`, { number: 1, title: 'Renamed' });
    expect([clash.status, clash.body.error.code, clash.body.error.message]).toEqual([409, 'conflict', `chapter number 1 is already used by ${chapter.id}`]);
    expect((await call<Chapter>(t.app, 'GET', `/api/chapters/${two.id}`)).body).toMatchObject({ number: 2, title: 'Two' });
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${two.id}`, { number: 2 })).status).toBe(200);
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${two.id}`, { number: 5 })).body.number).toBe(5);
    const other = (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Other' })).body;
    const elsewhere = (await call<Chapter>(t.app, 'POST', `/api/mangas/${other.id}/chapters`, { title: 'Elsewhere' })).body;
    expect((await call<Chapter>(t.app, 'PATCH', `/api/chapters/${elsewhere.id}`, { number: 5 })).body.number).toBe(5);
  });

  it('refuses to add panels to a cover with 400 validation (F5)', async () => {
    const { manga } = await seed();
    const cover = (await call<PageDetail>(t.app, 'POST', `/api/mangas/${manga.id}/cover`)).body;
    const refused = { status: 400, body: { error: { code: 'validation', message: 'a cover page has exactly one panel' } } };
    expect(await call(t.app, 'POST', `/api/pages/${cover.page.id}/layout/preset`, { preset: '2x2', confirm: true })).toEqual(refused);
    expect(await call(t.app, 'POST', `/api/pages/${cover.page.id}/layout/split`, { panelId: cover.panels[0]?.id, dir: 'v' })).toEqual(refused);
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${cover.page.id}`)).body.panels).toHaveLength(1);
  });

  it('creates the chapter cover once, outside the page list', async () => {
    const { chapter } = await seed();
    const cover = await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`);
    expect(cover.body.page).toMatchObject({ kind: 'cover', chapterId: chapter.id });
    expect((await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`)).body.page.id).toBe(cover.body.page.id);
    expect((await call<Chapter>(t.app, 'GET', `/api/chapters/${chapter.id}`)).body.coverPageId).toBe(cover.body.page.id);
    expect((await call<Page[]>(t.app, 'GET', `/api/chapters/${chapter.id}/pages`)).body).toEqual([]);
  });
});

describe('pages', () => {
  it('adds pages with a preset (default 2x2) at an index and lists story pages in order', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    expect(a.panels).toHaveLength(4);
    const b = await addPage(chapter.id, { layoutPreset: 'splash', index: 0 });
    expect(b.panels).toHaveLength(1);
    expect((await call<Page[]>(t.app, 'GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => [p.id, p.order])).toEqual([[b.page.id, 0], [a.page.id, 1]]);
    expect(events).toContainEqual({ type: 'entity', entity: 'page', id: a.page.id, op: 'created', mangaId: a.page.mangaId });
    expect(await call(t.app, 'POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: 'nope' })).toMatchObject({ status: 400, body: { error: { code: 'validation' } } });
    expect((await call(t.app, 'POST', '/api/chapters/ch_missing000/pages', {})).status).toBe(404);
  });

  it('reorders pages and rejects an incomplete id list', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    const b = await addPage(chapter.id);
    const r = await call<Page[]>(t.app, 'POST', `/api/chapters/${chapter.id}/pages/reorder`, { ids: [b.page.id, a.page.id] });
    expect(r.body.map((p) => p.id)).toEqual([b.page.id, a.page.id]);
    expect((await call<ErrorReply>(t.app, 'POST', `/api/chapters/${chapter.id}/pages/reorder`, { ids: [a.page.id] })).body.error.code).toBe('validation');
  });

  it('GET returns the PageDetail and DELETE removes the page', async () => {
    const { chapter } = await seed();
    const a = await addPage(chapter.id);
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${a.page.id}`)).body).toEqual(a);
    expect(await call(t.app, 'DELETE', `/api/pages/${a.page.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/pages/${a.page.id}`)).status).toBe(404);
  });
});

describe('layout', () => {
  it('applies a preset, asking for confirmation before it removes panels', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const order = readingOrder(d.page.layout, 'ltr');
    const refused = await call<ErrorReply>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '2-rows' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'needs_confirm', details: { removedPanelIds: order.slice(2) } });
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.panels).toHaveLength(4);
    const applied = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '2-rows', confirm: true });
    expect(applied.status).toBe(200);
    expect(readingOrder(applied.body.page.layout, 'ltr')).toEqual(order.slice(0, 2));
    for (const id of order.slice(2)) {
      expect(events).toContainEqual({ type: 'entity', entity: 'panel', id, op: 'deleted', mangaId: d.page.mangaId });
    }
    expect((await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: '3-rows' })).body.panels).toHaveLength(3);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/preset`, { preset: 'nope' })).status).toBe(400);
  });

  it('splits, merges siblings only, and resizes with clamping', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: '2-rows' });
    const [top, bottom] = panelIds(d.page.layout) as [string, string];
    const split = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/split`, { panelId: top, dir: 'v' });
    expect(split.body.panels).toHaveLength(3);
    const added = panelIds(split.body.page.layout).find((id) => id !== top && id !== bottom) ?? '';
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: added, op: 'created', mangaId: d.page.mangaId });
    expect(await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/merge`, { panelIdA: added, panelIdB: bottom })).toMatchObject({ status: 400, body: { error: { code: 'validation' } } });
    const merged = await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/merge`, { panelIdA: top, panelIdB: added });
    expect(panelIds(merged.body.page.layout)).toEqual([top, bottom]);
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: added, op: 'deleted', mangaId: d.page.mangaId });
    expect((await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: [], ratio: 0.99 })).body.page.layout).toMatchObject({ ratio: 0.92 });
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: ['a', 'a'], ratio: 0.5 })).status).toBe(404);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: ['x'], ratio: 0.5 })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/resize`, { path: [], ratio: 1 })).status).toBe(400);
    expect((await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/split`, { panelId: 'pn_missing000', dir: 'h' })).status).toBe(404);
    expect((await call(t.app, 'POST', '/api/pages/pg_missing000/layout/split', { panelId: top, dir: 'h' })).status).toBe(404);
  });
});

describe('panels', () => {
  it('reads and patches a panel, validating values, the active image and characters', async () => {
    const { manga, chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: '2-rows' });
    const [a, b] = panelIds(d.page.layout) as [string, string];
    const aiko = (await call<Character>(t.app, 'POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko' })).body;
    const script = {
      ...EMPTY_SCRIPT, action: 'Aiko bows',
      characters: [{ characterId: aiko.id, pose: 'bowing', expression: 'calm', position: 'center' }],
      dialogue: [{ speakerId: aiko.id, kind: 'speech', text: 'Welcome.' }],
    };
    const patched = await call<Panel>(t.app, 'PATCH', `/api/panels/${a}`, { script, seedLock: true, seed: 7, imageTransform: { x: 0.1, y: 0, scale: 1.5 } });
    expect(patched.body).toMatchObject({ script, seedLock: true, seed: 7, imageTransform: { x: 0.1, y: 0, scale: 1.5 } });
    expect((await call<Panel>(t.app, 'GET', `/api/panels/${a}`)).body).toEqual(patched.body);
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { imageTransform: { x: 0, y: 0, scale: 0.5 } })).status).toBe(400);
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { script: { ...EMPTY_SCRIPT, shot: 'sideways' } })).status).toBe(400);
    const other = (await uploadTo(b, makePng(4, 4))).json() as Image;
    expect((await call(t.app, 'PATCH', `/api/panels/${a}`, { activeImageId: other.id })).status).toBe(400);
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: a, op: 'updated', mangaId: manga.id });
  });

  it('re-checks the panel after reading the upload: deleted meanwhile gives 404 and leaves no Image row or file (F7)', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: 'splash' });
    const panelId = d.panels[0]?.id ?? '';
    const res = await uploadWhile(t.app, `/api/panels/${panelId}/upload`, makePng(4, 4), async () => {
      expect((await call(t.app, 'DELETE', `/api/pages/${d.page.id}`)).status).toBe(200);
    });
    expect([res.statusCode, res.json()]).toEqual([404, { error: { code: 'not_found', message: `panel ${panelId} not found` } }]);
    expect(t.deps.store.images.listByManga(d.page.mangaId)).toEqual([]);
    expect(readdirSync(join(t.lib, 'mangas', d.page.mangaId, 'images'))).toEqual([]);
  });

  it('uploads panel images that become the active variant, and lists the variants', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id, { layoutPreset: 'splash' });
    const panelId = d.panels[0]?.id ?? '';
    const first = (await uploadTo(panelId, makePng(10, 20))).json() as Image;
    const second = (await uploadTo(panelId, makePng(30, 40))).json() as Image;
    expect(second).toMatchObject({ ownerType: 'panel', ownerId: panelId, role: null, width: 30, height: 40 });
    expect((await call<Panel>(t.app, 'GET', `/api/panels/${panelId}`)).body.activeImageId).toBe(second.id);
    expect((await call<Image[]>(t.app, 'GET', `/api/panels/${panelId}/images`)).body.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(Object.keys((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.images)).toEqual([second.id]);
    expect((await call<Panel>(t.app, 'PATCH', `/api/panels/${panelId}`, { activeImageId: first.id })).body.activeImageId).toBe(first.id);
  });
});

describe('frames', () => {
  it('creates a frame with defaults, then reads, patches and deletes it', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const anchor = d.panels[0]?.id ?? '';
    const created = await call<TextFrame>(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'speech', text: 'Hi', panelId: anchor });
    expect(created.body).toMatchObject({ kind: 'speech', text: 'Hi', panelId: anchor, font: 'Shantell Sans', fontSize: 9, order: 0, autoFit: true, align: 'center', rotation: 0, tail: null });
    expect((await call<TextFrame>(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'sfx', text: 'BAM' })).body).toMatchObject({ font: 'Dela Gothic One', fontSize: 20, order: 1 });
    const id = created.body.id;
    expect((await call<TextFrame>(t.app, 'GET', `/api/frames/${id}`)).body).toEqual(created.body);
    const patched = await call<TextFrame>(t.app, 'PATCH', `/api/frames/${id}`, { text: 'Hello!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, tail: { x: 0.3, y: 0.4 } });
    expect(patched.body).toMatchObject({ text: 'Hello!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, tail: { x: 0.3, y: 0.4 } });
    expect((await call<PageDetail>(t.app, 'GET', `/api/pages/${d.page.id}`)).body.frames.map((f) => f.id)).toContain(id);
    expect(await call(t.app, 'DELETE', `/api/frames/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call(t.app, 'GET', `/api/frames/${id}`)).status).toBe(404);
  });

  it('rejects a title frame on a story page, a foreign anchor, a bad box and an unknown kind', async () => {
    const { chapter } = await seed();
    const d = await addPage(chapter.id);
    const other = await addPage(chapter.id);
    const post = (body: Record<string, unknown>) => call(t.app, 'POST', `/api/pages/${d.page.id}/frames`, body);
    expect((await post({ kind: 'title', text: 'ONI' })).status).toBe(400);
    expect((await post({ kind: 'speech', panelId: other.panels[0]?.id })).status).toBe(400);
    expect((await post({ kind: 'speech', box: { x: 0, y: 0, w: 0, h: 0.1 } })).status).toBe(400);
    expect((await post({ kind: 'caption' })).status).toBe(400);
  });
});
