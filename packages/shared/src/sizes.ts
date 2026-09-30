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

/** Millimetres per typographic point (1 pt = 1/72 in): the one constant for the lettering estimate and the UI. */
export const PT_TO_MM = 25.4 / 72;

export interface SizePx { w: number; h: number }
export interface Placement { left: number; top: number; width: number; height: number }

/**
 * Where a panel image sits (Task 13 review M2: one implementation for the UI's panels and the export's upscale plan):
 * scaled to cover the panel (max of the two ratios), then by the user's zoom, centred and panned by `t` (fractions of
 * the panel size).
 */
export function coverFit(panel: SizePx, image: SizePx, t: { scale: number; x: number; y: number }): Placement {
  const base = Math.max(panel.w / image.w, panel.h / image.h);
  const width = image.w * base * t.scale;
  const height = image.h * base * t.scale;
  return { width, height, left: (panel.w - width) / 2 + t.x * panel.w, top: (panel.h - height) / 2 + t.y * panel.h };
}
