import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SCRIPT, panelIds,
  type Chapter, type Character, type EntityName, type Image, type Manga, type PageDetail, type ServerEvent, type TextFrame,
} from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { multipart } from './helpers/multipart.js';
import { makePng } from './helpers/png.js';

// F1: every entity a cascade mutation changes gets its own entity event (Contract B).

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

const ev = (entity: EntityName, id: string, op: 'created' | 'updated' | 'deleted', mangaId: string): ServerEvent => ({ type: 'entity', entity, id, op, mangaId });

async function seed(): Promise<{ manga: Manga; chapter: Chapter }> {
  const manga = (await call<Manga>(t.app, 'POST', '/api/mangas', { title: 'Oni', readingDirection: 'ltr' })).body;
  const chapter = (await call<Chapter>(t.app, 'POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  return { manga, chapter };
}
async function addPage(chapterId: string, layoutPreset: string): Promise<PageDetail> {
  return (await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapterId}/pages`, { layoutPreset })).body;
}
async function upload(panelId: string): Promise<Image> {
  const form = multipart('file', 'art.png', 'image/png', makePng(4, 4));
  return (await t.app.inject({ method: 'POST', url: `/api/panels/${panelId}/upload`, payload: form.payload, headers: form.headers })).json() as Image;
}
/** Starts the capture just before the mutation under test. */
function capture(): void {
  events.length = 0;
}

describe('cascade mutation events', () => {
  it('DELETE /api/characters/:id: panel updated for stripped scripts/refs, textFrame updated for cleared speakers, then character deleted', async () => {
    const { manga, chapter } = await seed();
    const aiko = (await call<Character>(t.app, 'POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko' })).body;
    const d = await addPage(chapter.id, '2x2');
    const [a, b, c] = panelIds(d.page.layout) as [string, string, string];
    await call(t.app, 'PATCH', `/api/panels/${a}`, { script: { ...EMPTY_SCRIPT, characters: [{ characterId: aiko.id, pose: '', expression: '', position: 'center' }] } });
    await call(t.app, 'PATCH', `/api/panels/${b}`, { refCharacterIds: [aiko.id] });
    await call(t.app, 'PATCH', `/api/panels/${c}`, { script: { ...EMPTY_SCRIPT, action: 'nobody here' } });
    const spoken = (await call<TextFrame>(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'speech', speakerId: aiko.id })).body;
    await call(t.app, 'POST', `/api/pages/${d.page.id}/frames`, { kind: 'narration' });
    capture();
    expect((await call(t.app, 'DELETE', `/api/characters/${aiko.id}`)).status).toBe(200);
    expect(events).toEqual([
      ev('panel', a, 'updated', manga.id),
      ev('panel', b, 'updated', manga.id),
      ev('textFrame', spoken.id, 'updated', manga.id),
      ev('character', aiko.id, 'deleted', manga.id),
    ]);
    expect((await call<TextFrame>(t.app, 'GET', `/api/frames/${spoken.id}`)).body.speakerId).toBeNull();
  });

  it('PATCH /api/mangas/:id with a new reading direction: page updated for every mirrored page, then manga updated', async () => {
    const { manga, chapter } = await seed();
    await addPage(chapter.id, '2x2');
    await addPage(chapter.id, 'left-tall-2');
    await call(t.app, 'POST', `/api/mangas/${manga.id}/cover`);
    await call(t.app, 'POST', `/api/chapters/${chapter.id}/cover`);
    const pageIds = t.deps.store.pages.listByManga(manga.id).map((p) => p.id);
    expect(pageIds).toHaveLength(4);
    capture();
    await call(t.app, 'PATCH', `/api/mangas/${manga.id}`, { readingDirection: 'rtl' });
    expect(events).toEqual([...pageIds.map((id) => ev('page', id, 'updated', manga.id)), ev('manga', manga.id, 'updated', manga.id)]);
    capture();
    await call(t.app, 'PATCH', `/api/mangas/${manga.id}`, { readingDirection: 'rtl', title: 'Oni II' });
    expect(events).toEqual([ev('manga', manga.id, 'updated', manga.id)]);
  });

  it('DELETE /api/pages/:id of a story page: panel deleted for each panel, then page deleted', async () => {
    const { manga, chapter } = await seed();
    const d = await addPage(chapter.id, '2x2');
    await upload(d.panels[0]?.id ?? '');
    capture();
    await call(t.app, 'DELETE', `/api/pages/${d.page.id}`);
    expect(events).toEqual([...d.panels.map((p) => ev('panel', p.id, 'deleted', manga.id)), ev('page', d.page.id, 'deleted', manga.id)]);
  });

  it('DELETE /api/pages/:id of a cover: panel deleted, page deleted, then the manga or chapter whose coverPageId was cleared', async () => {
    const { manga, chapter } = await seed();
    const mangaCover = (await call<PageDetail>(t.app, 'POST', `/api/mangas/${manga.id}/cover`)).body;
    const chapterCover = (await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`)).body;
    capture();
    await call(t.app, 'DELETE', `/api/pages/${mangaCover.page.id}`);
    expect(events).toEqual([
      ev('panel', mangaCover.panels[0]?.id ?? '', 'deleted', manga.id),
      ev('page', mangaCover.page.id, 'deleted', manga.id),
      ev('manga', manga.id, 'updated', manga.id),
    ]);
    expect((await call<Manga>(t.app, 'GET', `/api/mangas/${manga.id}`)).body.coverPageId).toBeNull();
    capture();
    await call(t.app, 'DELETE', `/api/pages/${chapterCover.page.id}`);
    expect(events).toEqual([
      ev('panel', chapterCover.panels[0]?.id ?? '', 'deleted', manga.id),
      ev('page', chapterCover.page.id, 'deleted', manga.id),
      ev('chapter', chapter.id, 'updated', manga.id),
    ]);
    expect((await call<Chapter>(t.app, 'GET', `/api/chapters/${chapter.id}`)).body.coverPageId).toBeNull();
  });

  it('DELETE /api/chapters/:id: panel deleted and page deleted for everything in it (cover included), then chapter deleted', async () => {
    const { manga, chapter } = await seed();
    await addPage(chapter.id, '2-rows');
    await addPage(chapter.id, 'splash');
    await call(t.app, 'POST', `/api/chapters/${chapter.id}/cover`);
    const pages = t.deps.store.pages.listByChapter(chapter.id);
    expect(pages).toHaveLength(3);
    const panels = pages.flatMap((p) => t.deps.store.panels.listByPage(p.id).map((panel) => panel.id));
    capture();
    await call(t.app, 'DELETE', `/api/chapters/${chapter.id}`);
    expect(events).toEqual([
      ...panels.map((id) => ev('panel', id, 'deleted', manga.id)),
      ...pages.map((p) => ev('page', p.id, 'deleted', manga.id)),
      ev('chapter', chapter.id, 'deleted', manga.id),
    ]);
  });

  it('POST /api/pages/:id/layout/merge: panel deleted, image updated for each moved variant, then page updated', async () => {
    const { manga, chapter } = await seed();
    const d = await addPage(chapter.id, 'splash');
    const kept = d.panels[0]?.id ?? '';
    const split = (await call<PageDetail>(t.app, 'POST', `/api/pages/${d.page.id}/layout/split`, { panelId: kept, dir: 'v' })).body;
    const removed = split.panels.find((p) => p.id !== kept)?.id ?? '';
    const first = await upload(removed);
    const second = await upload(removed);
    await upload(kept);
    capture();
    await call(t.app, 'POST', `/api/pages/${d.page.id}/layout/merge`, { panelIdA: kept, panelIdB: removed });
    expect(events).toEqual([
      ev('panel', removed, 'deleted', manga.id),
      ev('image', first.id, 'updated', manga.id),
      ev('image', second.id, 'updated', manga.id),
      ev('page', d.page.id, 'updated', manga.id),
    ]);
    expect((await call<Image[]>(t.app, 'GET', `/api/panels/${kept}/images`)).body.map((i) => i.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });
});
