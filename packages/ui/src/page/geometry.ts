import { PT_TO_MM, type ImageTransform, type PageFormat, type Placement, type SizePx } from '@manga/shared';

// One implementation for the editor and the export's upscale plan (Task 13 review M2), one pt→mm constant (Task 3).
export { coverFit, type Placement, type SizePx } from '@manga/shared';

interface NormRect { x: number; y: number; w: number; h: number }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  return pt * PT_TO_MM * pxPerMmValue;
}

export function rectPx(r: NormRect, size: SizePx): Placement {
  return { left: r.x * size.w, top: r.y * size.h, width: r.w * size.w, height: r.h * size.h };
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
