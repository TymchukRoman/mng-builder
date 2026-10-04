import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GalleryPageResult, Image, PageDetail } from '@manga/shared';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { seedCharacter, seedManga } from './helpers/seed.js';

type ErrorReply = { error: { code: string } };

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

function addImage(mangaId: string, owner: { type: 'character' | 'panel'; id: string }, source: Image['source'] = 'generated', role: Image['role'] = null): Image {
  return t.deps.store.images.create({
    mangaId, ownerType: owner.type, ownerId: owner.id, role, path: `mangas/${mangaId}/images/x.png`, width: 64, height: 64,
    source, parentImageId: null, gen: null, review: null,
  });
}

async function gallery(query = ''): Promise<GalleryPageResult> {
  const r = await call<GalleryPageResult>(t.app, 'GET', `/api/gallery${query}`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('GET /api/gallery', () => {
  it('lists generated images newest first by default, with a total', async () => {
    const { manga, panels } = seedManga(t.deps.store);
    const a = addImage(manga.id, { type: 'panel', id: panels[0]!.id });
    const b = addImage(manga.id, { type: 'panel', id: panels[1]!.id });
    addImage(manga.id, { type: 'panel', id: panels[0]!.id }, 'uploaded');
    addImage(manga.id, { type: 'panel', id: panels[0]!.id }, 'upscaled');
    const r = await gallery();
    expect(r.items.map((i) => i.image.id)).toEqual([b.id, a.id]);
    expect(r).toMatchObject({ nextBefore: null, total: 2 });
    expect(r.items[0]?.mangaTitle).toBe(manga.title);
  });

  it('filters by source; "all" has no source filter', async () => {
    const { manga, panels } = seedManga(t.deps.store);
    const owner = { type: 'panel' as const, id: panels[0]!.id };
    const gen = addImage(manga.id, owner);
    const up = addImage(manga.id, owner, 'upscaled');
    const upl = addImage(manga.id, owner, 'uploaded');
    expect((await gallery('?source=upscaled')).items.map((i) => i.image.id)).toEqual([up.id]);
    expect((await gallery('?source=uploaded')).items.map((i) => i.image.id)).toEqual([upl.id]);
    const all = await gallery('?source=all');
    expect(all.items.map((i) => i.image.id)).toEqual([upl.id, up.id, gen.id]);
    expect(all.total).toBe(3);
  });

  it('filters by manga and owner type', async () => {
    const one = seedManga(t.deps.store);
    const two = seedManga(t.deps.store);
    const inOne = addImage(one.manga.id, { type: 'panel', id: one.panels[0]!.id });
    const inTwo = addImage(two.manga.id, { type: 'panel', id: two.panels[0]!.id });
    const portrait = addImage(two.manga.id, { type: 'character', id: seedCharacter(t.deps.store, two.manga.id, 'Aiko').id }, 'generated', 'portrait');
    expect((await gallery(`?mangaId=${one.manga.id}`)).items.map((i) => i.image.id)).toEqual([inOne.id]);
    expect((await gallery(`?mangaId=${two.manga.id}`)).items.map((i) => i.image.id)).toEqual([portrait.id, inTwo.id]);
    expect((await gallery(`?mangaId=${two.manga.id}&ownerType=character`)).items.map((i) => i.image.id)).toEqual([portrait.id]);
    expect((await gallery('?ownerType=panel')).total).toBe(2);
  });

  it('pages through nextBefore without gaps or repeats', async () => {
    const { manga, panels } = seedManga(t.deps.store);
    const made = Array.from({ length: 5 }, () => addImage(manga.id, { type: 'panel', id: panels[0]!.id }).id).reverse();
    const first = await gallery('?limit=2');
    expect(first.items.map((i) => i.image.id)).toEqual(made.slice(0, 2));
    expect(first.nextBefore).not.toBeNull();
    expect(first.total).toBe(5);
    const second = await gallery(`?limit=2&before=${first.nextBefore}`);
    expect(second.items.map((i) => i.image.id)).toEqual(made.slice(2, 4));
    const third = await gallery(`?limit=2&before=${second.nextBefore}`);
    expect(third.items.map((i) => i.image.id)).toEqual(made.slice(4));
    expect(third.nextBefore).toBeNull();
    expect(third.total).toBe(5);
  });

  it('drops deleted images', async () => {
    const { manga, panels } = seedManga(t.deps.store);
    const keep = addImage(manga.id, { type: 'panel', id: panels[0]!.id });
    const drop = addImage(manga.id, { type: 'panel', id: panels[1]!.id });
    expect((await gallery()).total).toBe(2);
    expect((await call(t.app, 'DELETE', `/api/images/${drop.id}`)).status).toBe(200);
    const r = await gallery();
    expect(r.items.map((i) => i.image.id)).toEqual([keep.id]);
    expect(r.total).toBe(1);
  });

  it('resolves a panel owner to its chapter and page number, and flags the active image', async () => {
    const { manga, chapter, page, panels } = seedManga(t.deps.store);
    const second = (await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/pages`, {})).body;
    const active = addImage(manga.id, { type: 'panel', id: panels[0]!.id });
    const other = addImage(manga.id, { type: 'panel', id: second.panels[0]!.id });
    t.deps.store.panels.update(panels[0]!.id, { activeImageId: active.id });
    const byId = new Map((await gallery()).items.map((i) => [i.image.id, i]));
    expect(byId.get(active.id)).toMatchObject({
      active: true,
      owner: { kind: 'panel', panelId: panels[0]!.id, pageId: page.id, chapterId: chapter.id, chapterNumber: 1, chapterTitle: 'One', pageNumber: 1, isCover: false },
    });
    expect(byId.get(other.id)).toMatchObject({ active: false, owner: { kind: 'panel', pageNumber: 2, isCover: false } });
  });

  it('resolves chapter and manga covers without a page number', async () => {
    const { manga, chapter } = seedManga(t.deps.store);
    const chapterCover = (await call<PageDetail>(t.app, 'POST', `/api/chapters/${chapter.id}/cover`)).body;
    const mangaCover = (await call<PageDetail>(t.app, 'POST', `/api/mangas/${manga.id}/cover`)).body;
    const a = addImage(manga.id, { type: 'panel', id: chapterCover.panels[0]!.id });
    const b = addImage(manga.id, { type: 'panel', id: mangaCover.panels[0]!.id });
    const byId = new Map((await gallery()).items.map((i) => [i.image.id, i]));
    expect(byId.get(a.id)?.owner).toMatchObject({ kind: 'panel', chapterId: chapter.id, pageNumber: null, isCover: true });
    expect(byId.get(b.id)?.owner).toMatchObject({ kind: 'panel', chapterId: null, chapterNumber: null, pageNumber: null, isCover: true });
  });

  it('resolves a character owner and marks ref images active', async () => {
    const { manga } = seedManga(t.deps.store);
    const aiko = seedCharacter(t.deps.store, manga.id, 'Aiko');
    const portrait = addImage(manga.id, { type: 'character', id: aiko.id }, 'generated', 'portrait');
    const spare = addImage(manga.id, { type: 'character', id: aiko.id }, 'generated', 'portrait');
    t.deps.store.characters.update(aiko.id, { refs: { portrait: portrait.id } });
    const byId = new Map((await gallery()).items.map((i) => [i.image.id, i]));
    expect(byId.get(portrait.id)).toMatchObject({ active: true, owner: { kind: 'character', characterId: aiko.id, name: 'Aiko', role: 'portrait' } });
    expect(byId.get(spare.id)).toMatchObject({ active: false, owner: { kind: 'character', name: 'Aiko' } });
  });

  it('reports a missing owner', async () => {
    const { manga } = seedManga(t.deps.store);
    addImage(manga.id, { type: 'character', id: 'cr_gone' });
    expect((await gallery()).items[0]?.owner).toEqual({ kind: 'missing' });
  });

  it('rejects a bad query with 400 validation', async () => {
    for (const q of ['?limit=0', '?limit=500', '?source=nope', '?ownerType=page', '?before=%00%00']) {
      const r = await call<ErrorReply>(t.app, 'GET', `/api/gallery${q}`);
      expect([q, r.status, r.body.error.code]).toEqual([q, 400, 'validation']);
    }
  });
});

