import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeRects, DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, newId, readingOrder, STYLE_PRESETS, type Image, type Manga,
} from '@manga/shared';
import { NotFoundError, ValidationError } from '../src/errors.js';
import {
  createChapter, createCharacter, createFrame, createManga, createPage, createCoverPage, deleteChapter, deleteCharacter, deletePage,
  deleteImage, deleteManga, reorderPages, saveUploadedImage, setCharacterRef, updateFrame, updateManga, updatePanel,
} from '../src/domain/index.js';
import { makeJpegHeader, makePng } from './helpers/png.js';
import { addPanelImage, makeStore, type TestStore } from './helpers/store.js';

let t: TestStore;
let manga: Manga;

beforeEach(() => {
  t = makeStore();
  manga = createManga(t.store, { title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
});
afterEach(() => t.close());

const frameInput = { text: 'Hi', panelId: null, speakerId: null, rotation: 0, autoFit: true, align: 'center' as const };

function character(name = 'Aiko', mangaId = manga.id) {
  return createCharacter(t.store, mangaId, { name, role: 'main', personality: '', speechStyle: '', appearanceTags: '1girl', recipe: null });
}

function characterImage(characterId: string, role: 'portrait' | null = 'portrait') {
  return saveUploadedImage(t.store, { mangaId: manga.id, owner: { type: 'character', id: characterId }, role, bytes: makePng(8, 8) });
}

describe('mangas', () => {
  it('applies the style preset and the default page format', () => {
    expect(manga).toMatchObject({ title: 'Oni', pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: STYLE_PRESETS['manga-bw']?.styleGuide, coverPageId: null });
  });

  it("uses the style preset's colour mode when none is given (F3)", () => {
    expect(createManga(t.store, { title: 'Neon', synopsis: '', language: 'en', readingDirection: 'rtl', stylePreset: 'anime-color' }).colorMode).toBe('color');
    expect(createManga(t.store, { title: 'Ink', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset: 'anime-color' }).colorMode).toBe('bw');
  });

  it('rejects an unknown style preset, including prototype keys', () => {
    for (const stylePreset of ['nope', 'constructor']) {
      expect(() => createManga(t.store, { title: 'X', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'rtl', stylePreset })).toThrow(ValidationError);
    }
  });

  it('mirrors page layouts and frames when the reading direction changes, so story order is kept', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'left-tall-2');
    const before = readingOrder(d.page.layout, 'ltr');
    const f = createFrame(t.store, d.page.id, { ...frameInput, kind: 'sfx', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, tail: { x: 0.2, y: 0.5 }, rotation: -10 });
    updateManga(t.store, manga.id, { readingDirection: 'rtl' });
    const page = t.store.pages.require(d.page.id);
    expect(readingOrder(page.layout, 'rtl')).toEqual(before);
    const rects = new Map(computeRects(page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
    expect(rects.get(before[0] ?? '')?.x).toBeGreaterThan(0.5);
    const moved = t.store.frames.require(f.id);
    expect(moved.box.x).toBeCloseTo(0.6);
    expect(moved.tail).toEqual({ x: 0.8, y: 0.5 });
    expect(moved.rotation).toBe(10);
    updateManga(t.store, manga.id, { readingDirection: 'rtl', title: 'Oni II' });
    expect(t.store.pages.require(d.page.id).layout).toEqual(page.layout);
  });
});

describe('characters', () => {
  it('gets a random seed unless one is given', () => {
    const a = character();
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.refs).toEqual({});
    const b = createCharacter(t.store, manga.id, { name: 'Ren', role: 'supporting', personality: '', speechStyle: '', appearanceTags: '', recipe: null, seed: 42 });
    expect(b.seed).toBe(42);
    expect(() => character('Ghost', 'mg_missing000')).toThrow(NotFoundError);
  });

  it('sets a ref slot only to an image of that character', () => {
    const a = character();
    const b = character('Ren');
    const img = characterImage(a.id);
    expect(setCharacterRef(t.store, a.id, 'fullbody', img.id).refs).toEqual({ fullbody: img.id });
    expect(() => setCharacterRef(t.store, b.id, 'portrait', img.id)).toThrow(ValidationError);
  });
});

describe('chapters', () => {
  it('numbers chapters max + 1 and reorders pages only with the complete list', () => {
    const c1 = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const c2 = createChapter(t.store, manga.id, { title: 'Two', synopsis: '' });
    expect([c1.number, c2.number, c1.order, c2.order]).toEqual([1, 2, 0, 1]);
    deleteChapter(t.store, c1.id);
    expect(createChapter(t.store, manga.id, { title: 'Three', synopsis: '' }).number).toBe(3);
    const p1 = createPage(t.store, c2.id, 'splash').page;
    const p2 = createPage(t.store, c2.id, 'splash').page;
    createCoverPage(t.store, manga.id, c2.id);
    expect(reorderPages(t.store, c2.id, [p2.id, p1.id]).map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect(() => reorderPages(t.store, c2.id, [p2.id])).toThrow(ValidationError);
    expect(() => reorderPages(t.store, c2.id, [p2.id, p2.id])).toThrow(ValidationError);
  });
});

describe('panels', () => {
  it('accepts only its own variants as the active image and characters of its manga', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, '2-rows');
    const [a, b] = [d.panels[0]?.id ?? '', d.panels[1]?.id ?? ''];
    const own = addPanelImage(t.store, manga.id, a);
    const other = addPanelImage(t.store, manga.id, b);
    expect(updatePanel(t.store, a, { activeImageId: own.id }).activeImageId).toBe(own.id);
    expect(() => updatePanel(t.store, a, { activeImageId: other.id })).toThrow(ValidationError);
    const aiko = character();
    const stranger = createManga(t.store, { title: 'Other', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
    const foreign = character('Foreign', stranger.id);
    expect(updatePanel(t.store, a, { refCharacterIds: [aiko.id] }).refCharacterIds).toEqual([aiko.id]);
    expect(() => updatePanel(t.store, a, { refCharacterIds: [foreign.id] })).toThrow(ValidationError);
    expect(() => updatePanel(t.store, a, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: foreign.id, kind: 'speech', text: 'hey' }] } })).toThrow(ValidationError);
  });
});

describe('frames', () => {
  it('centres the default box in the anchor panel, or on the page, with the kind font and size', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, '2x2');
    const anchor = d.panels[0]?.id ?? '';
    const f1 = createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', panelId: anchor });
    const rect = computeRects(d.page.layout, manga.pageFormat).find((r) => r.panelId === anchor)?.rect;
    expect(f1.box.x).toBeCloseTo((rect?.x ?? 0) + (rect?.w ?? 0) / 2 - 0.15);
    expect(f1.box.y).toBeCloseTo((rect?.y ?? 0) + (rect?.h ?? 0) / 2 - 0.06);
    expect([f1.box.w, f1.box.h, f1.font, f1.fontSize, f1.order]).toEqual([0.3, 0.12, 'Shantell Sans', 9, 0]);
    const f2 = createFrame(t.store, d.page.id, { ...frameInput, kind: 'narration' });
    expect(f2.box).toEqual({ x: 0.35, y: 0.44, w: 0.3, h: 0.12 });
    expect([f2.font, f2.fontSize, f2.order]).toEqual(['Sofia Sans Condensed', 8, 1]);
  });

  it('validates the anchor, the speaker and title frames, on create and on update', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const other = createPage(t.store, ch.id, 'splash');
    const stranger = createManga(t.store, { title: 'Other', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr', stylePreset: 'manga-bw' });
    const foreign = character('Foreign', stranger.id);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', panelId: other.panels[0]?.id ?? '' })).toThrow(ValidationError);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech', speakerId: foreign.id })).toThrow(ValidationError);
    expect(() => createFrame(t.store, d.page.id, { ...frameInput, kind: 'title' })).toThrow(ValidationError);
    const cover = createCoverPage(t.store, manga.id, null);
    expect(createFrame(t.store, cover.page.id, { ...frameInput, kind: 'title', text: 'ONI' }).font).toBe('Unbounded');
    const f = createFrame(t.store, d.page.id, { ...frameInput, kind: 'speech' });
    expect(updateFrame(t.store, f.id, { text: 'Hello', box: { x: 0, y: 0, w: 0.5, h: 0.2 } })).toMatchObject({ text: 'Hello', box: { x: 0, y: 0, w: 0.5, h: 0.2 } });
    expect(() => updateFrame(t.store, f.id, { kind: 'title' })).toThrow(ValidationError);
    expect(() => updateFrame(t.store, f.id, { speakerId: foreign.id })).toThrow(ValidationError);
  });
});

describe('uploads', () => {
  it('stores PNG and JPEG bytes as-is with their dimensions', () => {
    const a = character();
    const png = characterImage(a.id);
    expect(png).toMatchObject({ width: 8, height: 8, source: 'uploaded', role: 'portrait', path: `mangas/${manga.id}/images/${png.id}.png` });
    const jpg = saveUploadedImage(t.store, { mangaId: manga.id, owner: { type: 'character', id: a.id }, role: null, bytes: makeJpegHeader(300, 200) });
    expect([jpg.width, jpg.height]).toEqual([300, 200]);
  });

  it('rejects other types and unreadable files, judged by their bytes, without writing anything (F6)', () => {
    const a = character();
    const owner = { type: 'character' as const, id: a.id };
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner, role: null, bytes: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1') })).toThrow(ValidationError);
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner, role: null, bytes: Buffer.from('not a png') })).toThrow(ValidationError);
    expect(existsSync(join(t.path, 'mangas'))).toBe(false);
    expect(t.store.images.listByManga(manga.id)).toEqual([]);
  });

  it('re-checks the owner and runs attach in the transaction that inserts the row; a failure leaves no row or file (F7)', () => {
    const a = character();
    const gone = { type: 'character' as const, id: 'cr_missing000' };
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner: gone, role: null, bytes: makePng(2, 2) })).toThrow(NotFoundError);
    const owner = { type: 'character' as const, id: a.id };
    expect(() => saveUploadedImage(t.store, { mangaId: manga.id, owner, role: 'portrait', bytes: makePng(2, 2) }, () => {
      throw new NotFoundError('character', a.id);
    })).toThrow(NotFoundError);
    expect(t.store.images.listByManga(manga.id)).toEqual([]);
    expect(readdirSync(join(t.path, 'mangas', manga.id, 'images'))).toEqual([]);
    const kept = saveUploadedImage(t.store, { mangaId: manga.id, owner, role: 'portrait', bytes: makePng(2, 2) }, (image) => {
      setCharacterRef(t.store, a.id, 'portrait', image.id);
    });
    expect(t.store.characters.require(a.id).refs).toEqual({ portrait: kept.id });
  });
});

describe('cascade deletes', () => {
  it('deleteImage removes the file and derived images and clears character refs and the active pointer', () => {
    const a = character();
    const img = characterImage(a.id);
    setCharacterRef(t.store, a.id, 'portrait', img.id);
    const upscaled = t.store.images.create({ ...img, id: newId('im'), path: t.store.files.writeImage(manga.id, 'im_derived00', makePng(16, 16)), source: 'upscaled', parentImageId: img.id });
    deleteImage(t.store, img.id);
    expect(t.store.characters.require(a.id).refs).toEqual({});
    expect(t.store.images.get(upscaled.id)).toBeNull();
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    expect(existsSync(t.store.files.abs(upscaled.path))).toBe(false);
  });

  it('deleteImage removes the whole derivation chain (children of children) and their files, and nothing else (F17)', () => {
    const a = character();
    const img = characterImage(a.id);
    const derived = (parent: Image, width: number): Image => {
      const id = newId('im');
      return t.store.images.create({ ...parent, id, path: t.store.files.writeImage(manga.id, id, makePng(width, width)), width, height: width, source: 'upscaled', parentImageId: parent.id });
    };
    const child = derived(img, 16);
    const grandchild = derived(child, 32);
    const sibling = characterImage(a.id);
    setCharacterRef(t.store, a.id, 'portrait', grandchild.id);
    setCharacterRef(t.store, a.id, 'side', sibling.id);
    expect(deleteImage(t.store, img.id).images.map((i) => i.id)).toEqual([img.id, child.id, grandchild.id]);
    for (const gone of [img, child, grandchild]) {
      expect(t.store.images.get(gone.id)).toBeNull();
      expect(existsSync(t.store.files.abs(gone.path))).toBe(false);
    }
    expect(t.store.images.get(sibling.id)).not.toBeNull();
    expect(existsSync(t.store.files.abs(sibling.path))).toBe(true);
    expect(t.store.characters.require(a.id).refs).toEqual({ side: sibling.id });
  });

  it('deleteCharacter removes its images and strips it from panel scripts and refs', () => {
    const a = character();
    const img = characterImage(a.id);
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const panelId = d.panels[0]?.id ?? '';
    updatePanel(t.store, panelId, {
      refCharacterIds: [a.id],
      script: { ...EMPTY_SCRIPT, characters: [{ characterId: a.id, pose: '', expression: '', position: 'center' }], dialogue: [{ speakerId: a.id, kind: 'speech', text: 'Hi' }] },
    });
    deleteCharacter(t.store, a.id);
    const panel = t.store.panels.require(panelId);
    expect(panel.refCharacterIds).toEqual([]);
    expect(panel.script.characters).toEqual([]);
    expect(panel.script.dialogue).toEqual([{ speakerId: null, kind: 'speech', text: 'Hi' }]);
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    expect(t.store.characters.get(a.id)).toBeNull();
  });

  it('never throws after the commit when a file cannot be removed: each failure is logged and the rest still go (F8)', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, '2-rows');
    const [locked, free] = [addPanelImage(t.store, manga.id, d.panels[0]?.id ?? ''), addPanelImage(t.store, manga.id, d.panels[1]?.id ?? '')];
    const remove = t.store.files.remove;
    t.store.files.remove = (rel) => {
      if (rel === locked.path) throw new Error('EBUSY: resource busy or locked');
      remove(rel);
    };
    t.store.files.removeMangaDir = () => {
      throw new Error('EPERM: operation not permitted');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(deletePage(t.store, d.page.id).page.id).toBe(d.page.id);
      expect(t.store.images.get(locked.id)).toBeNull();
      expect(existsSync(t.store.files.abs(locked.path))).toBe(true);
      expect(existsSync(t.store.files.abs(free.path))).toBe(false);
      expect(deleteManga(t.store, manga.id).id).toBe(manga.id);
      expect(t.store.mangas.get(manga.id)).toBeNull();
      expect(logged.mock.calls.map((call) => String(call[0]))).toEqual([
        `[manga] could not remove ${locked.path}:`,
        `[manga] could not remove the folder of manga ${manga.id}:`,
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('deleteChapter removes its pages and their image files; deleteManga removes the manga folder', () => {
    const ch = createChapter(t.store, manga.id, { title: 'One', synopsis: '' });
    const d = createPage(t.store, ch.id, 'splash');
    const img = addPanelImage(t.store, manga.id, d.panels[0]?.id ?? '');
    deleteChapter(t.store, ch.id);
    expect(t.store.pages.get(d.page.id)).toBeNull();
    expect(existsSync(t.store.files.abs(img.path))).toBe(false);
    const a = character();
    characterImage(a.id);
    deleteManga(t.store, manga.id);
    expect(t.store.mangas.get(manga.id)).toBeNull();
    expect(t.store.characters.get(a.id)).toBeNull();
    expect(existsSync(join(t.path, 'mangas', manga.id))).toBe(false);
  });
});
