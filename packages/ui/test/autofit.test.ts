import { describe, expect, it } from 'vitest';
import { AUTOFIT_MIN_PT, fitFontSize, fitWarning, fontFamilyFor, isBelowReadable, measureBox, printMeasure } from '../src/page/autofit';

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

/** Text whose height equals its size in pt fits while pt <= t + 0.5 (the fit tolerance). */
const fitsUpTo = (t: number) => ({ box: { w: 10, h: t }, measure: (pt: number) => ({ w: 1, h: pt }) });

describe('fitFontSize: largest size on the grid', () => {
  it('finds 8.25 when the threshold is 8.26 (maxPt 9)', () => {
    // fits while pt <= 8.26, i.e. box.h = 7.76 with the 0.5 tolerance
    expect(fitFontSize({ maxPt: 9, ...fitsUpTo(7.76) })).toEqual({ pt: 8.25, overflow: false });
  });

  it('returns the largest grid size at or below the threshold across many ranges', () => {
    for (const maxPt of [9, 9.1, 10.3, 12, 16.75, 20, 33.7]) {
      for (let t = 3.4; t < maxPt + 1; t += 0.13) {
        const r = fitFontSize({ maxPt, ...fitsUpTo(t) });
        const threshold = t + 0.5;
        if (threshold >= maxPt) expect(r, `maxPt ${maxPt} t ${t}`).toEqual({ pt: maxPt, overflow: false });
        else if (threshold < AUTOFIT_MIN_PT) expect(r, `maxPt ${maxPt} t ${t}`).toEqual({ pt: AUTOFIT_MIN_PT, overflow: true });
        else expect(r, `maxPt ${maxPt} t ${t}`).toEqual({ pt: Math.floor(threshold / 0.25) * 0.25, overflow: false });
      }
    }
  });

  it('handles a non-grid minPt and maxPt', () => {
    // fits while pt <= 6.6 -> 6.5
    expect(fitFontSize({ maxPt: 9.1, minPt: 4.1, ...fitsUpTo(6.1) })).toEqual({ pt: 6.5, overflow: false });
    // only the floor itself (4.1) fits: the first grid point above it (4.25) does not
    expect(fitFontSize({ maxPt: 9.1, minPt: 4.1, ...fitsUpTo(3.7) })).toEqual({ pt: 4.1, overflow: false });
    // not even the floor fits
    expect(fitFontSize({ maxPt: 9.1, minPt: 4.1, ...fitsUpTo(3.5) })).toEqual({ pt: 4.1, overflow: true });
    // a preferred size off the grid that fits is kept as is
    expect(fitFontSize({ maxPt: 9.1, ...fitsUpTo(20) })).toEqual({ pt: 9.1, overflow: false });
  });

  it('never grows the font: a preferred size below the floor stays put', () => {
    expect(fitFontSize({ maxPt: 3, ...fitsUpTo(1) })).toEqual({ pt: 3, overflow: true });
    expect(fitFontSize({ maxPt: 3, ...fitsUpTo(10) })).toEqual({ pt: 3, overflow: false });
    expect(fitFontSize({ maxPt: 3, minPt: 6, ...fitsUpTo(1) })).toEqual({ pt: 3, overflow: true });
  });

  it('stays within 8 measurements for the default range', () => {
    let calls = 0;
    fitFontSize({ maxPt: 12, box: { w: 10, h: 7 }, measure: (pt) => { calls += 1; return { w: 1, h: pt }; } });
    expect(calls).toBeLessThanOrEqual(8);
  });
});

describe('printMeasure', () => {
  it('scales the box to the print scale and returns the print ppm', () => {
    expect(printMeasure({ w: 100, h: 40 }, 2, 6)).toEqual({ w: 300, h: 120, ppm: 6 });
  });
  it('is the identity in print mode', () => {
    expect(printMeasure({ w: 100, h: 40 }, 11.81, 11.81)).toEqual({ w: 100, h: 40, ppm: 11.81 });
  });
});

describe('fontFamilyFor', () => {
  it('uses a bundled font as is', () => {
    expect(fontFamilyFor('Unbounded')).toBe('"Unbounded", sans-serif');
  });
  it('falls back to the first bundled font for unknown or unsafe names', () => {
    expect(fontFamilyFor('Comic Sans')).toBe('"Shantell Sans", sans-serif');
    expect(fontFamilyFor('x"; color: red')).toBe('"Shantell Sans", sans-serif');
  });
});

describe('fitWarning', () => {
  it('warns about overflow', () => {
    expect(fitWarning({ pt: 4, overflow: true }, 9, true)).toBe('Text does not fit the frame');
  });
  it('says shrank in auto mode when the size dropped below 7 pt', () => {
    expect(fitWarning({ pt: 6.25, overflow: false }, 9, true)).toBe('Text shrank to 6.25 pt (below 7 pt)');
  });
  it('says "is" in manual mode or when nothing shrank, with pt rounded to 2 decimals', () => {
    expect(fitWarning({ pt: 6, overflow: false }, 6, false)).toBe('Text is 6 pt (below 7 pt)');
    expect(fitWarning({ pt: 6, overflow: false }, 6, true)).toBe('Text is 6 pt (below 7 pt)');
    expect(fitWarning({ pt: 6.123456, overflow: false }, 6.123456, false)).toBe('Text is 6.12 pt (below 7 pt)');
  });
  it('is silent at or above 7 pt', () => {
    expect(fitWarning({ pt: 7, overflow: false }, 9, true)).toBeNull();
  });
});

describe('measureBox', () => {
  it('rounds the width up so an integer scrollWidth can equal it', () => {
    // 0.3 * 0.7 of a 2150 px page: 451.49999999999994 px, which the browser measures as 452.
    const m = measureBox({ w: 451.49999999999994, h: 254.94 }, 11.813, 11.813);
    expect(m.w).toBe(452);
    expect(m.h).toBeCloseTo(254.94, 6);
    expect(measureBox({ w: 452, h: 10 }, 1, 1).w).toBe(452);
    expect(measureBox({ w: 100, h: 10 }, 1, 2)).toEqual({ w: 200, h: 20, ppm: 2 });
  });
});
