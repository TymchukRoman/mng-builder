// packages/server/test/export-paths.test.ts
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, printSizePx } from '@manga/shared';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { chapterSlug, exportDir, mangaSlug, planExport } from '../src/export/paths.js';
import { slugify, transliterate } from '../src/export/slug.js';
import { PermanentError } from '../src/jobs/index.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

describe('slugs', () => {
  it('transliterates Ukrainian with word-initial forms', () => {
    expect(transliterate('Їжак і Юля')).toBe('yizhak i yulia');
    expect(transliterate('Щастя')).toBe('shchastia');
    expect(transliterate('Розділ перший')).toBe('rozdil pershyi');
  });

  it('slugify makes ASCII slugs and falls back when nothing is left', () => {
    expect(slugify('Кіт під дощем', 'x')).toBe('kit-pid-doshchem');
    expect(slugify('  Café Noir: Part 2! ', 'x')).toBe('cafe-noir-part-2');
    expect(slugify('Ґанок', 'x')).toBe('ganok');
    expect(slugify('!!!', 'chapter')).toBe('chapter');
    const long = slugify('word '.repeat(40), 'x');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });

  it('ignores apostrophes inside a word, so a following є ї й ю я stays in its mid-word form', () => {
    expect(transliterate('з\u2019їзд')).toBe('zizd');
    expect(transliterate("п'ять")).toBe('piat');
  });

  it('writes зг as zgh (KMU 2010), in any case, and only for that pair', () => {
    expect(transliterate('Згадка')).toBe('zghadka');
    expect(transliterate('ЗГОРІВ')).toBe('zghoriv');
    expect(transliterate('розгляд')).toBe('rozghliad');
    expect(transliterate('Гроза')).toBe('hroza');
    expect(transliterate('Жага')).toBe('zhaha');
  });

  it('normalises to NFC first, so decomposed letters map like precomposed ones', () => {
    const decomposed = 'Йой'.normalize('NFD');
    expect(decomposed).not.toBe('Йой');
    expect(transliterate(decomposed)).toBe('yoi');
    expect(transliterate('Ї'.normalize('NFD') + 'жак')).toBe('yizhak');
    expect(slugify('Кіт'.normalize('NFD'), 'x')).toBe('kit');
  });

  it('never lets a title produce a separator or a dot segment', () => {
    for (const title of ['..', '../..', '..\\..\\etc', 'a/b\\c', '/etc/passwd', 'C:\\Windows', '.', '\0x', 'con\u202Enoop', 'e\u0301\u0301x']) {
      const slug = slugify(title, 'fallback');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toMatch(/^-|-$/);
    }
    expect(slugify('..', 'fallback')).toBe('fallback');
    expect(slugify('../../etc', 'x')).toBe('etc');
  });

  it('chapter dirs never collide', () => {
    const { chapter } = seedEpisodeWorld(lib.store, { chapterTitle: 'Rain' });
    const second = lib.store.chapters.create({ mangaId: chapter.mangaId, number: 2, title: 'Rain', synopsis: '', coverPageId: null, status: 'draft', order: 1 });
    expect([chapterSlug(chapter), chapterSlug(second)]).toEqual(['01-rain', '02-rain']);
  });
});

describe('export paths', () => {
  it('computes the print pixel size of the page format', () => {
    expect(printSizePx(DEFAULT_PAGE_FORMAT)).toEqual({ w: 2150, h: 3035 });
  });

  it('puts exports under <library>/exports/<manga>/<chapter>, or in outDir', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Кіт під дощем', chapterTitle: 'Розділ перший' });
    const root = lib.store.files.exportsDir();
    expect(exportDir(root, manga, chapter)).toBe(join(root, 'kit-pid-doshchem', '01-rozdil-pershyi'));
    expect(exportDir(root, manga, null)).toBe(join(root, 'kit-pid-doshchem', 'cover'));
    expect(exportDir(root, manga, chapter, 'out/here')).toBe(resolve('out/here'));
  });

  it('keeps hostile titles inside the exports root', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: '../../..', chapterTitle: '..\\..\\secret/x' });
    const root = lib.store.files.exportsDir();
    const dir = exportDir(root, manga, chapter);
    expect(isAbsolute(dir)).toBe(true);
    expect(relative(root, dir).split(sep)).toEqual([`manga-${manga.id}`, '01-secret-x']);
  });

  it('treats an empty or blank outDir as absent and resolves a relative one to an absolute path', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    const root = lib.store.files.exportsDir();
    const dflt = join(root, 'rain-town', '01-one');
    expect(exportDir(root, manga, chapter, '')).toBe(dflt);
    expect(exportDir(root, manga, chapter, '   ')).toBe(dflt);
    expect(exportDir(root, manga, chapter, undefined)).toBe(dflt);
    expect(exportDir(root, manga, chapter, ' out/here ')).toBe(resolve('out/here'));
    expect(isAbsolute(exportDir(root, manga, chapter, '..'))).toBe(true);
  });

  it('keeps same-slug mangas apart with the last 6 id characters, and leaves a unique slug plain', () => {
    const { manga: first, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    const root = lib.store.files.exportsDir();
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const plain = join(root, 'rain-town', '01-one');
    expect(planExport(lib.store, { target: { type: 'chapter', id: chapter.id }, format: 'png' }).dir).toBe(plain);
    expect(mangaSlug(first)).toBe('rain-town');

    const { manga: second, chapter: secondChapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'rain-town!', chapterTitle: 'One' });
    createPage(lib.store, secondChapter.id, TWO_PANEL_PRESET);
    const suffix = (id: string): string => id.slice(-6).toLowerCase();
    const dirs = [chapter, secondChapter].map((c) => planExport(lib.store, { target: { type: 'chapter', id: c.id }, format: 'png' }).dir);
    expect(dirs).toEqual([
      join(root, `rain-town-${suffix(first.id)}`, '01-one'),
      join(root, `rain-town-${suffix(second.id)}`, '01-one'),
    ]);
    expect(new Set(dirs).size).toBe(2);

    const { manga: third } = seedEpisodeWorld(lib.store, { mangaTitle: 'Other' });
    expect(exportDir(root, third, null, undefined, lib.store.mangas.list())).toBe(join(root, 'other', 'cover'));
  });

  it('plans a single page and a whole chapter', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const second = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const dir = join(lib.store.files.exportsDir(), 'rain-town', '01-one');

    const one = planExport(lib.store, { target: { type: 'page', id: second.page.id }, format: 'png' });
    expect(one).toMatchObject({ dir, chapterPdf: null, format: 'png', items: [{ pageId: second.page.id, file: join(dir, 'page-02.png') }] });

    const all = planExport(lib.store, { target: { type: 'chapter', id: chapter.id }, format: 'pdf' });
    expect(all.items.map((i) => i.file)).toEqual([join(dir, 'cover.pdf'), join(dir, 'page-01.pdf'), join(dir, 'page-02.pdf')]);
    expect(all.items[0]!.pageId).toBe(cover.page.id);
    expect(all.chapterPdf).toBe(join(dir, 'chapter.pdf'));
  });

  it('plans a manga cover under <manga>/cover and honours outDir', () => {
    const { manga } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town' });
    const cover = createCoverPage(lib.store, manga.id, null);
    const plan = planExport(lib.store, { target: { type: 'page', id: cover.page.id }, format: 'png' });
    const dir = join(lib.store.files.exportsDir(), 'rain-town', 'cover');
    expect(plan).toMatchObject({ dir, chapterPdf: null, items: [{ pageId: cover.page.id, file: join(dir, 'cover.png') }], pageFormat: manga.pageFormat });
    const custom = planExport(lib.store, { target: { type: 'page', id: cover.page.id }, format: 'png', outDir: 'out/here' });
    expect(custom.dir).toBe(resolve('out/here'));
    expect(custom.items[0]!.file).toBe(join(resolve('out/here'), 'cover.png'));
  });

  it('refuses a chapter without pages', () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    expect(() => planExport(lib.store, { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).toThrow(PermanentError);
  });
});
