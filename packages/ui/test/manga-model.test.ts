import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, type Chapter, type RecipeInfo } from '@manga/shared';
import { applyChapterPatch, applyMangaPatch, mangaBadges, pageSizeLabel, recipeOptions, sortChapters, summaryDraft, validLoras } from '../src/manga/mangaModel';
import { makeManga } from './fixtures';

const chapter = (id: string, order: number, number: number): Chapter => ({
  id, mangaId: 'mg_1', number, title: id, synopsis: '', summary: '', imageModel: null, coverPageId: null, status: 'draft', order, createdAt: '', updatedAt: '',
});

describe('chapter summary draft (W1 Q1, Task 9 minor 2)', () => {
  it('trims what is saved, and is clean while it equals the stored summary', () => {
    expect(summaryDraft('  Kai finds the key.  ', '')).toEqual({ next: 'Kai finds the key.', dirty: true });
    expect(summaryDraft('Kai finds the key. ', 'Kai finds the key.')).toEqual({ next: 'Kai finds the key.', dirty: false });
    expect(summaryDraft('', '')).toEqual({ next: '', dirty: false });
  });

  it('clearing a stored summary is a change', () => {
    expect(summaryDraft('   ', 'Kai finds the key.')).toEqual({ next: '', dirty: true });
  });
});

describe('manga model', () => {
  it('sorts chapters by order, then number', () => {
    expect(sortChapters([chapter('c', 1, 3), chapter('a', 0, 2), chapter('b', 0, 1)]).map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(sortChapters(undefined)).toEqual([]);
  });
  it('keeps only LoRAs with a name, trimmed', () => {
    expect(validLoras([{ name: ' a.safetensors ', strength: 0.8 }, { name: '  ', strength: 1 }])).toEqual([{ name: 'a.safetensors', strength: 0.8 }]);
  });
  it('summarises language, colour and direction as badges', () => {
    expect(mangaBadges(makeManga({ language: 'uk', colorMode: 'color', readingDirection: 'ltr' }))).toEqual([
      { text: 'UK', tip: 'Ukrainian' }, { text: 'Colour', tip: 'Colour pages' }, { text: 'LTR', tip: 'Reads left to right' },
    ]);
    expect(mangaBadges(makeManga()).map((b) => b.text)).toEqual(['EN', 'B&W', 'RTL']);
  });
  it('shows the fixed page size and resolution on one line', () => {
    expect(pageSizeLabel(DEFAULT_PAGE_FORMAT)).toBe('182 × 257 mm · 300 dpi');
  });
  it('merges a patch into the manga and ignores undefined fields', () => {
    const m = makeManga({ title: 'A', synopsis: 's' });
    const next = applyMangaPatch(m, { title: 'B', synopsis: undefined, readingDirection: 'ltr' });
    expect(next).toMatchObject({ title: 'B', synopsis: 's', readingDirection: 'ltr', language: 'en' });
    expect(m.title).toBe('A');
  });
  it('offers generation recipes, plus the current one when it is not among them', () => {
    const r = (id: string): RecipeInfo => ({ id, label: id.toUpperCase(), maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false });
    const list = [r('anime'), r('anime-refine'), r('anima')];
    expect(recipeOptions(list, 'anima')).toEqual([{ id: 'anime', label: 'ANIME' }, { id: 'anima', label: 'ANIMA' }]);
    expect(recipeOptions(list, 'anime-refine').map((o) => o.id)).toEqual(['anime', 'anima', 'anime-refine']);
    expect(recipeOptions(list, 'gone').at(-1)).toEqual({ id: 'gone', label: 'gone' });
  });
  it('applyChapterPatch replaces one chapter in the list', () => {
    const a = chapter('ch_a', 0, 1);
    const b = chapter('ch_b', 1, 2);
    expect(applyChapterPatch([a, b], 'ch_b', { summary: 'S.' })).toEqual([a, { ...b, summary: 'S.' }]);
  });
});
