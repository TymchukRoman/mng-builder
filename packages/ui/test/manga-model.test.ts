import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, type Chapter } from '@manga/shared';
import { mangaBadges, pageSizeLabel, sortChapters, validLoras } from '../src/manga/mangaModel';
import { makeManga } from './fixtures';

const chapter = (id: string, order: number, number: number): Chapter => ({
  id, mangaId: 'mg_1', number, title: id, synopsis: '', coverPageId: null, status: 'draft', order, createdAt: '', updatedAt: '',
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
});
