import type { ImageTransform, PageFormat } from '@manga/shared';

export const MM_PER_PT = 25.4 / 72;

export interface SizePx { w: number; h: number }
export interface Placement { left: number; top: number; width: number; height: number }
interface NormRect { x: number; y: number; w: number; h: number }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Exact export pixel size (spec §10): round(mm / 25.4 × dpi). */
export function printSizePx(format: PageFormat, scale = 1): SizePx {
  return {
    w: Math.round((format.widthMm / 25.4) * format.dpi * scale),
    h: Math.round((format.heightMm / 25.4) * format.dpi * scale),
  };
}

/** Page size at a given on-screen width, consistent with printSizePx at the print width. */
export function pageSizePx(format: PageFormat, widthPx: number): SizePx {
  const exactW = (format.widthMm / 25.4) * format.dpi;
  const exactH = (format.heightMm / 25.4) * format.dpi;
  return { w: widthPx, h: Math.round((exactH * widthPx) / Math.round(exactW)) };
}

export function pxPerMm(format: PageFormat, widthPx: number): number {
  return widthPx / format.widthMm;
}

export function ptToPx(pt: number, pxPerMmValue: number): number {
  return pt * MM_PER_PT * pxPerMmValue;
}

export function rectPx(r: NormRect, size: SizePx): Placement {
  return { left: r.x * size.w, top: r.y * size.h, width: r.w * size.w, height: r.h * size.h };
}

export function coverFit(panel: SizePx, image: SizePx, t: ImageTransform): Placement {
  const base = Math.max(panel.w / image.w, panel.h / image.h);
  const width = image.w * base * t.scale;
  const height = image.h * base * t.scale;
  return { width, height, left: (panel.w - width) / 2 + t.x * panel.w, top: (panel.h - height) / 2 + t.y * panel.h };
}

export function panLimits(panelAspect: number, imageAspect: number, scale: number): { x: number; y: number } {
  const coverW = scale * Math.max(1, imageAspect / panelAspect);
  const coverH = scale * Math.max(1, panelAspect / imageAspect);
  return { x: (coverW - 1) / 2, y: (coverH - 1) / 2 };
}

export function clampTransform(t: ImageTransform, panelAspect: number, imageAspect: number): ImageTransform {
  const scale = clamp(t.scale, 1, 8);
  const lim = panLimits(panelAspect, imageAspect, scale);
  return { scale, x: clamp(t.x, -lim.x, lim.x), y: clamp(t.y, -lim.y, lim.y) };
}

export function panBy(t: ImageTransform, dxPx: number, dyPx: number, panel: SizePx, image: SizePx): ImageTransform {
  return clampTransform({ ...t, x: t.x + dxPx / panel.w, y: t.y + dyPx / panel.h }, panel.w / panel.h, image.w / image.h);
}

export function zoomBy(t: ImageTransform, factor: number, panel: SizePx, image: SizePx): ImageTransform {
  return clampTransform({ ...t, scale: t.scale * factor }, panel.w / panel.h, image.w / image.h);
}
