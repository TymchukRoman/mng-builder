import type { PageFormat } from '@manga/shared';

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** `factor` is relative to the fitted width. */
export type Zoom = { mode: 'fit' } | { mode: 'fixed'; factor: number };

export function fitWidth(container: { w: number; h: number }, format: PageFormat, pad = 48): number {
  const availW = Math.max(80, container.w - pad);
  const availH = Math.max(80, container.h - pad);
  return Math.floor(Math.min(availW, (availH * format.widthMm) / format.heightMm));
}

export function zoomFactor(z: Zoom): number {
  return z.mode === 'fit' ? 1 : z.factor;
}

export function stepZoom(z: Zoom, dir: 1 | -1): Zoom {
  const f = zoomFactor(z);
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > f + 1e-9) : [...ZOOM_STEPS].reverse().find((s) => s < f - 1e-9);
  return next === undefined ? z : { mode: 'fixed', factor: next };
}

export function zoomLabel(z: Zoom): string {
  return z.mode === 'fit' ? 'Fit' : `${Math.round(z.factor * 100)}%`;
}

/** The zoom button's name and tooltip. It contains the text the button shows ("Fit", "150%"), as WCAG 2.5.3 asks (M9). */
export function zoomButtonLabel(z: Zoom): string {
  return z.mode === 'fit' ? 'Fit page to screen' : `Zoom ${zoomLabel(z)}: fit page to screen`;
}
