import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS } from '@manga/shared';
import { DEFAULT_PRESET_ID, presetColorMode, presetOptions, sortMangas } from '../src/mangas/mangaList';
import { makeManga } from './fixtures';

describe('sortMangas', () => {
  it('lists the most recently updated manga first without mutating the input', () => {
    const list = [
      makeManga({ id: 'mg_a', updatedAt: '2026-09-01T00:00:00Z' }),
      makeManga({ id: 'mg_b', updatedAt: '2026-09-20T00:00:00Z' }),
      makeManga({ id: 'mg_c', updatedAt: '2026-09-10T00:00:00Z' }),
    ];
    expect(sortMangas(list).map((m) => m.id)).toEqual(['mg_b', 'mg_c', 'mg_a']);
    expect(list[0]?.id).toBe('mg_a');
    expect(sortMangas(undefined)).toEqual([]);
  });
});

describe('style preset helpers', () => {
  const presets = Object.values(STYLE_PRESETS);

  it('offers the loaded presets, or the default one while they load', () => {
    expect(presetOptions(presets).map((p) => p.id)).toEqual(Object.keys(STYLE_PRESETS));
    expect(presetOptions(undefined)).toEqual([{ id: DEFAULT_PRESET_ID, label: DEFAULT_PRESET_ID, colorMode: 'bw' }]);
    expect(DEFAULT_PRESET_ID in STYLE_PRESETS).toBe(true);
  });

  it("gives a preset's own colour mode, and null for an unknown preset or before they load", () => {
    expect(presetColorMode(presets, 'anime-color')).toBe('color');
    expect(presetColorMode(presets, 'anima-bw')).toBe('bw');
    expect(presetColorMode(presets, 'nope')).toBeNull();
    expect(presetColorMode(undefined, 'anime-color')).toBeNull();
  });
});
