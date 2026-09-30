// packages/server/test/lettering-domain.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRects, CreateFrameSchema } from '@manga/shared';
import { createFrame } from '../src/domain/frames.js';
import { letterPage } from '../src/domain/lettering.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

function letteredWorld() {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
  const detail = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
  const [a, b] = detail.panels;
  updatePanel(lib.store, a!.id, {
    characters: [{ characterId: aiko.id, pose: '', expression: '', position: 'left' }],
    dialogue: [{ speakerId: null, kind: 'narration', text: 'Autumn.' }, { speakerId: aiko.id, kind: 'speech', text: 'Line 1' }],
  });
  updatePanel(lib.store, b!.id, { dialogue: [{ speakerId: null, kind: 'sfx', text: 'BANG' }] });
  return { manga, chapter, aiko, page: detail.page, a: a!, b: b! };
}

describe('letterPage', () => {
  it('letters every dialogue line of the page exactly once', () => {
    const { page, a, b } = letteredWorld();
    const frames = letterPage(lib.store, page.id);
    expect(frames.map((f) => [f.panelId, f.kind, f.text])).toEqual([
      [a.id, 'narration', 'Autumn.'], [a.id, 'speech', 'Line 1'], [b.id, 'sfx', 'BANG'],
    ]);
    expect(frames.map((f) => f.order)).toEqual([0, 1, 2]);
    expect(letterPage(lib.store, page.id)).toEqual([]);
    expect(lib.store.frames.listByPage(page.id)).toHaveLength(3);
  });

  it('places every frame inside its panel', () => {
    const { manga, page } = letteredWorld();
    const rects = new Map(computeRects(page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
    for (const f of letterPage(lib.store, page.id)) {
      const r = rects.get(f.panelId!)!;
      expect(f.box.x).toBeGreaterThanOrEqual(r.x);
      expect(f.box.y).toBeGreaterThanOrEqual(r.y);
      expect(f.box.x + f.box.w).toBeLessThanOrEqual(r.x + r.w + 1e-9);
      expect(f.box.y + f.box.h).toBeLessThanOrEqual(r.y + r.h + 1e-9);
    }
  });

  it('keeps lines the user already lettered by hand', () => {
    const { page, a } = letteredWorld();
    createFrame(lib.store, page.id, CreateFrameSchema.parse({ kind: 'speech', text: 'Line 1', panelId: a.id }));
    expect(letterPage(lib.store, page.id).map((f) => f.text)).toEqual(['Autumn.', 'BANG']);
  });

  it('adds the chapter title to a cover page once', () => {
    const { manga, chapter } = letteredWorld();
    lib.store.chapters.update(chapter.id, { title: 'The Cat in the Rain' });
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const frames = letterPage(lib.store, cover.page.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'title', text: 'The Cat in the Rain', panelId: cover.panels[0]!.id, tail: null });
    expect(letterPage(lib.store, cover.page.id)).toEqual([]);
  });

  it('titles the manga cover with the manga title', () => {
    const { manga } = letteredWorld();
    const cover = createCoverPage(lib.store, manga.id, null);
    expect(letterPage(lib.store, cover.page.id).map((f) => [f.kind, f.text])).toEqual([['title', manga.title]]);
  });

  it('matches by exact text: an edited bubble is lettered again and a deleted cover title comes back', () => {
    const { manga, page, a } = letteredWorld();
    const [line] = letterPage(lib.store, page.id).filter((f) => f.text === 'Line 1');
    lib.store.frames.update(line!.id, { text: 'Line one' });
    expect(letterPage(lib.store, page.id).map((f) => [f.panelId, f.text])).toEqual([[a.id, 'Line 1']]);
    const cover = createCoverPage(lib.store, manga.id, null);
    const [title] = letterPage(lib.store, cover.page.id);
    lib.store.frames.delete(title!.id);
    expect(letterPage(lib.store, cover.page.id).map((f) => f.kind)).toEqual(['title']);
  });
});
