import type { PageFormat } from './schemas.js';

export const SDXL_SIZES: Array<[number, number]> = [
  [1024, 1024], [896, 1152], [832, 1216], [768, 1344], [640, 1536], [1152, 896], [1216, 832], [1344, 768], [1536, 640],
];

/** Picks the size whose w/h is closest to `aspect` (compares log ratios). */
export function pickSize(aspect: number, sizes: Array<[number, number]>): [number, number] {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError(`aspect must be a positive number, got ${aspect}`);
  const [first, ...rest] = sizes;
  if (first === undefined) throw new RangeError('sizes must not be empty');
  const target = Math.log(aspect);
  let best = first;
  let bestDistance = Math.abs(Math.log(first[0] / first[1]) - target);
  for (const size of rest) {
    const distance = Math.abs(Math.log(size[0] / size[1]) - target);
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}

/** Exact export pixel size of a page (spec §10): round(mm / 25.4 × dpi × scale). Used by the export and the print route. */
export function printSizePx(format: PageFormat, scale = 1): { w: number; h: number } {
  return {
    w: Math.round((format.widthMm / 25.4) * format.dpi * scale),
    h: Math.round((format.heightMm / 25.4) * format.dpi * scale),
  };
}
