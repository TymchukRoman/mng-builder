import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRects, DEFAULT_TRANSFORM, EMPTY_SCRIPT, LayoutError, panelIds, readingOrder, type Chapter, type Manga } from '@manga/shared';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { deletePage } from '../src/domain/delete.js';
import {
  applyPreset, createCoverPage, createPage, mergePagePanels, NeedsConfirmError, pageDetail, resizePageSplit, splitPagePanel,
} from '../src/domain/pages.js';
import { addPanelImage, makeStore, seedChapter, seedManga, type TestStore } from './helpers/store.js';

let t: TestStore;
let manga: Manga;
let chapter: Chapter;

beforeEach(() => {
  t = makeStore();
  manga = seedManga(t.store, { readingDirection: 'ltr' });
  chapter = seedChapter(t.store, manga.id);
});
afterEach(() => t.close());

function addFrame(pageId: string, panelId: string | null) {
  return t.store.frames.create({
    pageId, panelId, kind: 'speech', text: 'Hi', speakerId: null, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 },
    tail: null, rotation: 0, font: 'Shantell Sans', fontSize: 9, autoFit: true, align: 'center', order: 0,
  });
}

describe('createPage', () => {
  it('creates the preset layout with one Panel row per leaf, in chapter order', () => {
    const d1 = createPage(t.store, chapter.id, '2x2');
    expect(d1.page).toMatchObject({ kind: 'page', order: 0, chapterId: chapter.id, mangaId: manga.id });
    expect(d1.panels.map((p) => p.id)).toEqual(panelIds(d1.page.layout));
    expect(d1.panels).toHaveLength(4);
    expect(d1.panels[0]).toMatchObject({ script: EMPTY_SCRIPT, seedLock: false, activeImageId: null, refCharacterIds: [], imageTransform: DEFAULT_TRANSFORM, recipe: null });
    expect(d1.frames).toEqual([]);
    expect(d1.images).toEqual({});
    const d0 = createPage(t.store, chapter.id, 'splash', 0);
    const d2 = createPage(t.store, chapter.id, '3-rows', 99);
    expect(t.store.pages.listByChapter(chapter.id).map((p) => [p.id, p.order])).toEqual([[d0.page.id, 0], [d1.page.id, 1], [d2.page.id, 2]]);
  });

  it('mirrors the preset for RTL mangas so the tall panel of left-tall-2 is on the right and read first', () => {
    const rtl = seedManga(t.store, { readingDirection: 'rtl' });
    const ch = seedChapter(t.store, rtl.id);
    const d = createPage(t.store, ch.id, 'left-tall-2');
    const rects = new Map(computeRects(d.page.layout, rtl.pageFormat).map((r) => [r.panelId, r.rect]));
    const first = rects.get(readingOrder(d.page.layout, 'rtl')[0] ?? '');
    expect(first?.x).toBeGreaterThan(0.5);
    expect(first?.h).toBeGreaterThan(0.8);
  });

  it('rejects an unknown preset or chapter without writing anything', () => {
    expect(() => createPage(t.store, chapter.id, 'nope')).toThrow(LayoutError);
    expect(() => createPage(t.store, 'ch_missing000', '2x2')).toThrow(NotFoundError);
    expect(t.store.pages.listByChapter(chapter.id)).toEqual([]);
  });
});

describe('createCoverPage', () => {
  it('keeps covers single-panel: applying a preset or splitting is a validation error (F5)', () => {
    for (const cover of [createCoverPage(t.store, manga.id, null), createCoverPage(t.store, manga.id, chapter.id)]) {
      const panelId = cover.panels[0]?.id ?? '';
      expect(() => applyPreset(t.store, cover.page.id, '2x2', true)).toThrow(new ValidationError('a cover page has exactly one panel'));
      expect(() => splitPagePanel(t.store, cover.page.id, panelId, 'h')).toThrow(new ValidationError('a cover page has exactly one panel'));
      expect(pageDetail(t.store, cover.page.id)).toEqual(cover);
    }
  });

  it('creates one splash cover per manga or chapter and returns it again next time', () => {
    const mc = createCoverPage(t.store, manga.id, null);
    expect(mc.page).toMatchObject({ kind: 'cover', chapterId: null, order: 0 });
    expect(mc.panels).toHaveLength(1);
    expect(t.store.mangas.require(manga.id).coverPageId).toBe(mc.page.id);
    expect(createCoverPage(t.store, manga.id, null).page.id).toBe(mc.page.id);
    const cc = createCoverPage(t.store, manga.id, chapter.id);
    expect(cc.page.id).not.toBe(mc.page.id);
    expect(t.store.chapters.require(chapter.id).coverPageId).toBe(cc.page.id);
    expect(createCoverPage(t.store, manga.id, chapter.id).page.id).toBe(cc.page.id);
  });
});

describe('applyPreset', () => {
  it('maps existing panels to the new slots in reading order and adds new panels', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const [p1, p2] = readingOrder(d.page.layout, 'ltr');
    t.store.panels.update(p1 ?? '', { script: { ...EMPTY_SCRIPT, action: 'first' } });
    const next = applyPreset(t.store, d.page.id, '2x2', false);
    expect(readingOrder(next.page.layout, 'ltr').slice(0, 2)).toEqual([p1, p2]);
    expect(next.panels).toHaveLength(4);
    expect(t.store.panels.require(p1 ?? '').script.action).toBe('first');
  });

  it('refuses to drop panels without confirm, lists them, and changes nothing', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const order = readingOrder(d.page.layout, 'ltr');
    try {
      applyPreset(t.store, d.page.id, '2-rows', false);
      expect.unreachable('applyPreset should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsConfirmError);
      expect((err as NeedsConfirmError).removedPanelIds).toEqual(order.slice(2));
      expect((err as NeedsConfirmError).status).toBe(409);
    }
    expect(t.store.pages.require(d.page.id).layout).toEqual(d.page.layout);
    expect(t.store.panels.listByPage(d.page.id)).toHaveLength(4);
  });

  it('with confirm keeps the art of surviving panels and deletes removed panels with their images and files', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const order = readingOrder(d.page.layout, 'ltr');
    const kept = addPanelImage(t.store, manga.id, order[0] ?? '');
    t.store.panels.update(order[0] ?? '', { activeImageId: kept.id });
    const doomed = addPanelImage(t.store, manga.id, order[3] ?? '');
    const frame = addFrame(d.page.id, order[3] ?? null);
    const next = applyPreset(t.store, d.page.id, '2-rows', true);
    expect(readingOrder(next.page.layout, 'ltr')).toEqual(order.slice(0, 2));
    expect(next.images[kept.id]).toEqual(kept);
    expect(existsSync(t.store.files.abs(kept.path))).toBe(true);
    expect(t.store.panels.get(order[3] ?? '')).toBeNull();
    expect(t.store.images.get(doomed.id)).toBeNull();
    expect(existsSync(t.store.files.abs(doomed.path))).toBe(false);
    expect(t.store.frames.require(frame.id).panelId).toBeNull();
  });
});

describe('split, merge and resize', () => {
  it('splits a panel, creating a fresh Panel row for the new half', () => {
    const d = createPage(t.store, chapter.id, 'splash');
    const only = d.panels[0]?.id ?? '';
    const next = splitPagePanel(t.store, d.page.id, only, 'h');
    const ids = panelIds(next.page.layout);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(only);
    expect(t.store.panels.require(ids[1] ?? '').script).toEqual(EMPTY_SCRIPT);
    expect(next.panels.map((p) => p.id)).toEqual(ids);
  });

  it('merges siblings into A, moving B variants and anchored frames to A', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const [a, b] = panelIds(d.page.layout) as [string, string];
    const aImage = addPanelImage(t.store, manga.id, a);
    t.store.panels.update(a, { activeImageId: aImage.id });
    const bImage = addPanelImage(t.store, manga.id, b);
    const frame = addFrame(d.page.id, b);
    const next = mergePagePanels(t.store, d.page.id, a, b);
    expect(panelIds(next.page.layout)).toEqual([a]);
    expect(t.store.panels.get(b)).toBeNull();
    expect(t.store.panels.require(a).activeImageId).toBe(aImage.id);
    expect(t.store.images.listByOwner('panel', a).map((i) => i.id).sort()).toEqual([aImage.id, bImage.id].sort());
    expect(existsSync(t.store.files.abs(bImage.path))).toBe(true);
    expect(t.store.frames.require(frame.id).panelId).toBe(a);
  });

  it('refuses to merge non-siblings and leaves the page alone', () => {
    const d = createPage(t.store, chapter.id, '2x2');
    const [p1, , p3] = panelIds(d.page.layout);
    expect(() => mergePagePanels(t.store, d.page.id, p1 ?? '', p3 ?? '')).toThrow(LayoutError);
    expect(t.store.pages.require(d.page.id).layout).toEqual(d.page.layout);
  });

  it('resizes a split, clamped to 8–92 %', () => {
    const d = createPage(t.store, chapter.id, '2-rows');
    const next = resizePageSplit(t.store, d.page.id, [], 0.99);
    expect(next.page.layout).toMatchObject({ type: 'split', ratio: 0.92 });
  });
});

describe('pageDetail and deletePage', () => {
  it('404s for an unknown page', () => {
    expect(() => pageDetail(t.store, 'pg_missing000')).toThrow(NotFoundError);
  });

  it('removes panels, frames, images and files, and renumbers the chapter', () => {
    const a = createPage(t.store, chapter.id, 'splash');
    const b = createPage(t.store, chapter.id, '2-rows');
    const c = createPage(t.store, chapter.id, 'splash');
    const image = addPanelImage(t.store, manga.id, b.panels[0]?.id ?? '');
    const frame = addFrame(b.page.id, null);
    deletePage(t.store, b.page.id);
    expect(t.store.pages.get(b.page.id)).toBeNull();
    expect(t.store.panels.get(b.panels[0]?.id ?? '')).toBeNull();
    expect(t.store.frames.get(frame.id)).toBeNull();
    expect(t.store.images.get(image.id)).toBeNull();
    expect(existsSync(t.store.files.abs(image.path))).toBe(false);
    expect(t.store.pages.listByChapter(chapter.id).map((p) => [p.id, p.order])).toEqual([[a.page.id, 0], [c.page.id, 1]]);
  });
});
