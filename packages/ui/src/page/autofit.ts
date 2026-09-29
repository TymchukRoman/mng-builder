import { BUNDLED_FONTS, MIN_READABLE_PT } from '@manga/shared';

export const AUTOFIT_MIN_PT = 4;

export interface FitInput {
  /** The preferred size. Auto-fit only ever shrinks from it. */
  maxPt: number;
  minPt?: number;
  box: { w: number; h: number };
  /** Size of the text rendered at `pt`, in the same pixel space as `box`. */
  measure(pt: number): { w: number; h: number };
  precision?: number;
}

export interface FitResult { pt: number; overflow: boolean }

/**
 * The largest size on the `precision` grid (or `maxPt` itself) at which the text fits.
 * If nothing fits, returns the floor, `min(minPt, maxPt)`, with `overflow: true`, so the result never exceeds `maxPt`.
 */
export function fitFontSize({ maxPt, minPt = AUTOFIT_MIN_PT, box, measure, precision = 0.25 }: FitInput): FitResult {
  const fits = (pt: number): boolean => {
    const m = measure(pt);
    return m.w <= box.w + 0.5 && m.h <= box.h + 0.5;
  };
  if (fits(maxPt)) return { pt: maxPt, overflow: false };
  const floorPt = Math.min(minPt, maxPt);
  if (floorPt === maxPt || !fits(floorPt)) return { pt: floorPt, overflow: true };
  // Search grid indices. Invariant: `a` fits (a < first grid index means the floor itself), `b` does not.
  const first = Math.ceil(floorPt / precision);
  const last = Math.floor(maxPt / precision);
  let a = first - 1;
  // maxPt already failed, so a grid point equal to it needs no second measurement.
  let b = last * precision === maxPt ? last : last + 1;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (fits(mid * precision)) a = mid;
    else b = mid;
  }
  return { pt: a < first ? floorPt : a * precision, overflow: false };
}

export function isBelowReadable(pt: number): boolean {
  return pt < MIN_READABLE_PT;
}

/**
 * The measuring box: `printMeasure` with the width rounded up to a whole pixel. `scrollWidth` is an integer, so a box of
 * 451.4999... px would otherwise read every fitting line as 1px too wide and shrink the text to the floor.
 */
export function measureBox(box: { w: number; h: number }, ppm: number, printPpm: number): { w: number; h: number; ppm: number } {
  const m = printMeasure(box, ppm, printPpm);
  return { ...m, w: Math.ceil(m.w - 1e-6) };
}

/** The fitted size is measured once at the print scale, so screen, thumbnail and print all show the same pt. */
export function printMeasure(box: { w: number; h: number }, ppm: number, printPpm: number): { w: number; h: number; ppm: number } {
  const s = printPpm / ppm;
  return { w: box.w * s, h: box.h * s, ppm: printPpm };
}

const FALLBACK_FONT = 'Shantell Sans';

/** Only bundled fonts are ever interpolated into CSS. */
export function fontFamilyFor(font: string): string {
  const name = BUNDLED_FONTS.includes(font) ? font : (BUNDLED_FONTS[0] ?? FALLBACK_FONT);
  return `"${name}", sans-serif`;
}

/** Tooltip text for the frame warning, or null when there is nothing to warn about. */
export function fitWarning(fit: FitResult, preferredPt: number, autoFit: boolean): string | null {
  if (fit.overflow) return 'Text does not fit the frame';
  if (!isBelowReadable(fit.pt)) return null;
  const pt = Math.round(fit.pt * 100) / 100;
  return autoFit && fit.pt < preferredPt
    ? `Text shrank to ${pt} pt (below ${MIN_READABLE_PT} pt)`
    : `Text is ${pt} pt (below ${MIN_READABLE_PT} pt)`;
}
