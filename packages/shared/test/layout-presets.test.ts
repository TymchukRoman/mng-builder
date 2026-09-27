import { describe, expect, it } from 'vitest';
import {
  buildPreset,
  computeRects,
  DEFAULT_PAGE_FORMAT,
  LayoutError,
  LayoutNodeSchema,
  panelIds,
  presetPanelCount,
  PRESET_NAMES,
  readingOrder,
} from '@manga/shared';

const EXPECTED_COUNTS: Record<string, number> = {
  'splash': 1, '2-rows': 2, '3-rows': 3, '4-rows': 4, '2x2': 4, '2x3': 6,
  'big-top-2': 3, 'big-top-3': 4, 'big-bottom-2': 3, '2-big-bottom': 3,
  'left-tall-2': 3, 'right-tall-2': 3, '3-rows-mid-split': 4, 'row-2-1-2': 5, 'cinematic-3': 3, '5-stagger': 5,
};

function counter(): () => string {
  let n = 0;
  return () => `pn_${String(++n).padStart(2, '0')}`;
}

describe('presets', () => {
  it('has exactly the 16 names from the spec, in spec order', () => {
    expect([...PRESET_NAMES]).toEqual(Object.keys(EXPECTED_COUNTS));
  });

  it.each(Object.entries(EXPECTED_COUNTS))('%s has %i panels and a valid tree in both directions', (name, count) => {
    expect(presetPanelCount(name)).toBe(count);
    for (const dir of ['ltr', 'rtl'] as const) {
      const tree = buildPreset(name, dir, counter());
      expect(LayoutNodeSchema.safeParse(tree).success).toBe(true);
      expect(new Set(panelIds(tree)).size).toBe(count);
    }
  });

  it.each(Object.keys(EXPECTED_COUNTS))('%s reads its panels in the same story order in LTR and RTL', (name) => {
    const ids = Array.from({ length: presetPanelCount(name) }, (_, i) => `pn_${String(i + 1).padStart(2, '0')}`);
    expect(readingOrder(buildPreset(name, 'ltr', counter()), 'ltr')).toEqual(ids);
    expect(readingOrder(buildPreset(name, 'rtl', counter()), 'rtl')).toEqual(ids);
  });

  it('puts the first panel on the right in RTL and on the left in LTR', () => {
    for (const dir of ['rtl', 'ltr'] as const) {
      const tree = buildPreset('2x2', dir, counter());
      const rects = new Map(computeRects(tree, DEFAULT_PAGE_FORMAT).map((r) => [r.panelId, r.rect]));
      const first = rects.get(readingOrder(tree, dir)[0] ?? '');
      expect(first).toBeDefined();
      if (dir === 'rtl') expect(first?.x).toBeGreaterThan(0.5);
      else expect(first?.x).toBeLessThan(0.5);
    }
  });

  it('gives every panel of every preset a usable area (more than 5% of the page each way)', () => {
    for (const name of PRESET_NAMES) {
      for (const { rect } of computeRects(buildPreset(name, 'ltr', counter()), DEFAULT_PAGE_FORMAT)) {
        expect(rect.w).toBeGreaterThan(0.05);
        expect(rect.h).toBeGreaterThan(0.05);
      }
    }
  });

  it('rejects unknown names, including Object prototype keys', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__']) {
      expect(() => presetPanelCount(name)).toThrow(LayoutError);
      expect(() => buildPreset(name, 'ltr', counter())).toThrow(/unknown layout preset/);
    }
  });
});
