import { describe, expect, it } from 'vitest';
import type { GalleryItem, GalleryOwner, GalleryPageResult } from '@manga/shared';
import {
  DEFAULT_GALLERY_FILTERS, describeEmpty, editorPath, flattenGallery, formatCreated, galleryKey, galleryQueryString, galleryTotal,
  itemTitle, ownerBadge, sizeLabel, sourceLabel,
} from '../src/gallery/galleryModel';
import { makeImage } from './fixtures';

const panel = (over: Partial<Extract<GalleryOwner, { kind: 'panel' }>> = {}): GalleryOwner => ({
  kind: 'panel', panelId: 'pn_1', pageId: 'pg_1', chapterId: 'ch_2', chapterNumber: 2, chapterTitle: 'Two', pageNumber: 3, isCover: false, ...over,
});
const item = (owner: GalleryOwner, over: Partial<GalleryItem> = {}): GalleryItem => ({ image: makeImage('im_1'), mangaTitle: 'Oni', owner, active: false, ...over });

describe('galleryQueryString', () => {
  it('always sends source and limit, and only the filters that are set', () => {
    expect(galleryQueryString(DEFAULT_GALLERY_FILTERS)).toBe('?source=generated&limit=60');
    expect(galleryQueryString({ mangaId: 'mg_1', source: 'all', ownerType: 'character' }, 'abc_-', 20))
      .toBe('?mangaId=mg_1&ownerType=character&source=all&limit=20&before=abc_-');
  });
  it('encodes ids', () => {
    expect(galleryQueryString({ ...DEFAULT_GALLERY_FILTERS, mangaId: 'a&b' })).toContain('mangaId=a%26b');
  });
});

describe('galleryKey', () => {
  it('starts with "gallery" and differs per filter', () => {
    expect(galleryKey(DEFAULT_GALLERY_FILTERS)[0]).toBe('gallery');
    expect(galleryKey(DEFAULT_GALLERY_FILTERS)).not.toEqual(galleryKey({ ...DEFAULT_GALLERY_FILTERS, source: 'all' }));
  });
});

describe('ownerBadge', () => {
  it('names the chapter and page of a panel image', () => {
    expect(ownerBadge(item(panel()))).toBe('Ch 2 · p3');
  });
  it('says Cover for covers, with the chapter when there is one', () => {
    expect(ownerBadge(item(panel({ isCover: true, pageNumber: null })))).toBe('Ch 2 · Cover');
    expect(ownerBadge(item(panel({ isCover: true, pageNumber: null, chapterId: null, chapterNumber: null, chapterTitle: null })))).toBe('Cover');
  });
  it('names a character with its slot, or alone without one', () => {
    expect(ownerBadge(item({ kind: 'character', characterId: 'cr_1', name: 'Aiko', role: 'portrait' }))).toBe('Aiko · portrait');
    expect(ownerBadge(item({ kind: 'character', characterId: 'cr_1', name: 'Aiko', role: null }))).toBe('Aiko');
  });
  it('falls back for an unplaced panel or a missing owner', () => {
    expect(ownerBadge(item(panel({ chapterNumber: null, pageNumber: null })))).toBe('Panel');
    expect(ownerBadge(item({ kind: 'missing' }))).toBe('Unknown owner');
  });
  it('prefixes the manga title in the item title', () => {
    expect(itemTitle(item(panel()))).toBe('Oni · Ch 2 · p3');
    expect(itemTitle(item(panel(), { mangaTitle: '' }))).toBe('Ch 2 · p3');
  });
});

describe('editorPath', () => {
  it('opens a chapter page at its page, a cover at its cover route, a character on the characters tab', () => {
    expect(editorPath(item(panel()))).toBe('/m/mg_1/c/ch_2?p=pg_1');
    expect(editorPath(item(panel({ isCover: true, pageNumber: null })))).toBe('/m/mg_1/c/ch_2/cover');
    expect(editorPath(item(panel({ isCover: true, chapterId: null })))).toBe('/m/mg_1/cover');
    expect(editorPath(item({ kind: 'character', characterId: 'cr_1', name: 'Aiko', role: null }))).toBe('/m/mg_1?tab=characters');
  });
  it('has no route for a missing owner', () => {
    expect(editorPath(item({ kind: 'missing' }))).toBeNull();
  });
});

describe('pages', () => {
  const page = (ids: string[], total: number): GalleryPageResult => ({ items: ids.map((id) => ({ ...item(panel()), image: makeImage(id) })), nextBefore: null, total });
  it('flattens loaded pages in order and reports the freshest total', () => {
    const pages = [page(['im_a', 'im_b'], 5), page(['im_c'], 4)];
    expect(flattenGallery(pages).map((i) => i.image.id)).toEqual(['im_a', 'im_b', 'im_c']);
    expect(galleryTotal(pages)).toBe(4);
    expect(flattenGallery(undefined)).toEqual([]);
    expect(galleryTotal(undefined)).toBeNull();
  });
});

describe('labels', () => {
  it('labels sources, sizes and the empty state', () => {
    expect(sourceLabel('upscaled')).toBe('Upscaled');
    expect(sizeLabel(832, 1216)).toBe('832 × 1216');
    expect(describeEmpty(DEFAULT_GALLERY_FILTERS)).toBe('No generated images yet');
    expect(describeEmpty({ ...DEFAULT_GALLERY_FILTERS, source: 'all' })).toBe('No images match these filters');
  });
  it('formats a date, and leaves a non-date as it is', () => {
    expect(formatCreated('2026-09-27T14:05:00.000Z', 'en-US')).toMatch(/Sep 27, 2026/);
    expect(formatCreated('not a date')).toBe('not a date');
  });
});
