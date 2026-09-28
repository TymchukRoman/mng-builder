import { MIN_READABLE_PT } from '@manga/shared';

export const AUTOFIT_MIN_PT = 4;

export interface FitInput {
  maxPt: number;
  minPt?: number;
  box: { w: number; h: number };
  /** Size of the text rendered at `pt`, in the same pixel space as `box`. */
  measure(pt: number): { w: number; h: number };
  precision?: number;
}

export interface FitResult { pt: number; overflow: boolean }

export function fitFontSize({ maxPt, minPt = AUTOFIT_MIN_PT, box, measure, precision = 0.25 }: FitInput): FitResult {
  const fits = (pt: number): boolean => {
    const m = measure(pt);
    return m.w <= box.w + 0.5 && m.h <= box.h + 0.5;
  };
  if (fits(maxPt)) return { pt: maxPt, overflow: false };
  if (maxPt <= minPt || !fits(minPt)) return { pt: minPt, overflow: true };
  let lo = minPt;
  let hi = maxPt;
  while (hi - lo > precision) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  // Flooring to the grid keeps the result at or below a size that fitted.
  return { pt: Math.max(minPt, Math.floor(lo / precision) * precision), overflow: false };
}

export function isBelowReadable(pt: number): boolean {
  return pt < MIN_READABLE_PT;
}
