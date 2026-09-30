// packages/server/test/export-hires.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRects, printSizePx, type Image } from '@manga/shared';
import { createPage, pageDetail } from '../src/domain/pages.js';
import { bestUpscaled, planUpscales, printDetail } from '../src/export/hires.js';
import { seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedImage } from './helpers/seed.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

/** A splash page (one panel ≈ 1914×2752 px at 300 dpi) whose panel shows an image of the given size. */
function splashWith(size: [number, number], scale = 1) {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  const detail = createPage(lib.store, chapter.id, 'splash');
  const panel = detail.panels[0]!;
  const image = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null, size);
  lib.store.panels.update(panel.id, { activeImageId: image.id, imageTransform: { x: 0, y: 0, scale } });
  return { manga, page: detail.page, panel, image };
}

function addUpscaled(parent: Image, width: number): Image {
  return lib.store.images.create({
    mangaId: parent.mangaId, ownerType: 'panel', ownerId: parent.ownerId, role: null, path: `mangas/${parent.mangaId}/images/up-${width}.png`,
    width, height: Math.round((parent.height * width) / parent.width), source: 'upscaled', parentImageId: parent.id, gen: null, review: null,
  });
}

describe('planUpscales', () => {
  it('asks for 4× when the image is far below print resolution', () => {
    const { manga, page, panel, image } = splashWith([512, 512]);
    expect(planUpscales(lib.store, pageDetail(lib.store, page.id), manga.pageFormat)).toEqual([{ panelId: panel.id, imageId: image.id, factor: 4 }]);
  });

  it('asks for 2× when doubling is enough, and 4× once the image is zoomed in', () => {
    const a = splashWith([1216, 1600]);
    expect(planUpscales(lib.store, pageDetail(lib.store, a.page.id), a.manga.pageFormat).map((p) => p.factor)).toEqual([2]);
    const b = splashWith([1216, 1600], 1.5);
    expect(planUpscales(lib.store, pageDetail(lib.store, b.page.id), b.manga.pageFormat).map((p) => p.factor)).toEqual([4]);
  });

  it('skips large images, upscaled images and images that already have an upscaled child', () => {
    const big = splashWith([4000, 6000]);
    expect(planUpscales(lib.store, pageDetail(lib.store, big.page.id), big.manga.pageFormat)).toEqual([]);
    const done = splashWith([512, 512]);
    addUpscaled(done.image, 2048);
    expect(planUpscales(lib.store, pageDetail(lib.store, done.page.id), done.manga.pageFormat)).toEqual([]);
    const up = addUpscaled(splashWith([512, 512]).image, 2048);
    const upPanel = lib.store.panels.require(up.ownerId);
    lib.store.panels.update(upPanel.id, { activeImageId: up.id });
    expect(planUpscales(lib.store, pageDetail(lib.store, upPanel.pageId), done.manga.pageFormat)).toEqual([]);
  });
});

describe('printDetail', () => {
  it('swaps each active image for its widest upscaled child and leaves the stored page alone', () => {
    const { page, panel, image } = splashWith([512, 512]);
    addUpscaled(image, 1024);
    const wide = addUpscaled(image, 2048);
    expect(bestUpscaled(lib.store, panel.id, image.id)?.id).toBe(wide.id);
    const print = printDetail(lib.store, page.id);
    expect(print.panels[0]!.activeImageId).toBe(wide.id);
    expect(print.images[wide.id]).toMatchObject({ width: 2048, source: 'upscaled' });
    expect(pageDetail(lib.store, page.id).panels[0]!.activeImageId).toBe(image.id);
  });
});

describe('planUpscales guards', () => {
  it('plans nothing for an image without a usable size (no NaN factors)', () => {
    const { manga, page, image } = splashWith([512, 512]);
    const detail = pageDetail(lib.store, page.id);
    for (const broken of [{ width: 0, height: 512 }, { width: 512, height: 0 }, { width: Number.NaN, height: 512 }, { width: Number.POSITIVE_INFINITY, height: 512 }]) {
      const patched = { ...detail, images: { [image.id]: { ...image, ...broken } } };
      expect(planUpscales(lib.store, patched, manga.pageFormat)).toEqual([]);
    }
  });

  it('plans nothing for a panel without an active image', () => {
    const { manga, page, panel } = splashWith([512, 512]);
    lib.store.panels.update(panel.id, { activeImageId: null });
    expect(planUpscales(lib.store, pageDetail(lib.store, page.id), manga.pageFormat)).toEqual([]);
  });

  it('matches the UI cover fit at the boundaries: exactly print size needs nothing, just below needs 2x, over 2x needs 4x', () => {
    // splash panel at B5/300 dpi is about 1914 x 2752 px; an image of exactly that size covers it 1:1
    const probe = splashWith([1000, 1000]);
    const rect = computeRects(pageDetail(lib.store, probe.page.id).page.layout, probe.manga.pageFormat)[0]!.rect;
    const px = printSizePx(probe.manga.pageFormat);
    const w = rect.w * px.w;
    const h = rect.h * px.h;
    const exact = splashWith([Math.ceil(w), Math.ceil(h)]);
    expect(planUpscales(lib.store, pageDetail(lib.store, exact.page.id), exact.manga.pageFormat)).toEqual([]);
    const below = splashWith([Math.ceil(w) - 10, Math.ceil(h) - 10]);
    expect(planUpscales(lib.store, pageDetail(lib.store, below.page.id), below.manga.pageFormat).map((p) => p.factor)).toEqual([2]);
    const over = splashWith([Math.floor(w / 2) - 10, Math.floor(h / 2) - 10]);
    expect(planUpscales(lib.store, pageDetail(lib.store, over.page.id), over.manga.pageFormat).map((p) => p.factor)).toEqual([4]);
  });
});
