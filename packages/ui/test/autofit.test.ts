import { describe, expect, it } from 'vitest';
import { AUTOFIT_MIN_PT, fitFontSize, isBelowReadable } from '../src/page/autofit';

describe('fitFontSize', () => {
  it('keeps the preferred size when it fits', () => {
    expect(fitFontSize({ maxPt: 9, box: { w: 100, h: 100 }, measure: () => ({ w: 50, h: 20 }) })).toEqual({ pt: 9, overflow: false });
  });

  it('finds the largest size that fits, on a 0.25 pt grid', () => {
    let calls = 0;
    const r = fitFontSize({ maxPt: 12, box: { w: 100, h: 30 }, measure: (pt) => { calls += 1; return { w: 50, h: pt * 3 }; } });
    expect(r.overflow).toBe(false);
    expect(r.pt).toBeGreaterThanOrEqual(9.75);
    expect(r.pt).toBeLessThanOrEqual(10);
    expect((r.pt * 4) % 1).toBe(0);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it('a word wider than the box overflows at the floor', () => {
    const r = fitFontSize({ maxPt: 9, box: { w: 100, h: 100 }, measure: (pt) => ({ w: pt * 40, h: 10 }) });
    expect(r).toEqual({ pt: AUTOFIT_MIN_PT, overflow: true });
  });

  it('respects a custom floor', () => {
    const r = fitFontSize({ maxPt: 20, minPt: 8, box: { w: 100, h: 10 }, measure: (pt) => ({ w: 10, h: pt * 2 }) });
    expect(r).toEqual({ pt: 8, overflow: true });
  });

  it('flags sizes below the readable minimum', () => {
    expect(isBelowReadable(6.75)).toBe(true);
    expect(isBelowReadable(7)).toBe(false);
  });
});
