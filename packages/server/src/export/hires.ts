// packages/server/src/export/hires.ts
import { computeRects, printSizePx, type Image, type PageDetail, type PageFormat, type Panel } from '@manga/shared';
import { pageDetail } from '../domain/pages.js';
import type { Store } from '../store/index.js';

export interface UpscalePlan { panelId: string; imageId: string; factor: 2 | 4 }

export function bestUpscaled(store: Store, panelId: string, parentImageId: string): Image | null {
  return store.images.listByOwner('panel', panelId)
    .filter((i) => i.source === 'upscaled' && i.parentImageId === parentImageId)
    .sort((a, b) => b.width - a.width)[0] ?? null;
}

/** Spec §9.2: images printed under the format's dpi get one upscale, cached as an 'upscaled' child. */
export function planUpscales(store: Store, detail: PageDetail, format: PageFormat): UpscalePlan[] {
  const px = printSizePx(format);
  const rects = new Map(computeRects(detail.page.layout, format).map((r) => [r.panelId, r.rect]));
  const plans: UpscalePlan[] = [];
  for (const panel of detail.panels) {
    if (panel.activeImageId === null) continue;
    const image = detail.images[panel.activeImageId] ?? store.images.get(panel.activeImageId);
    const rect = rects.get(panel.id);
    if (!image || !rect || image.source === 'upscaled' || bestUpscaled(store, panel.id, image.id)) continue;
    // An image without a usable size cannot be planned (the UI falls back to plain CSS cover): no upscale is planned for it.
    if (!(Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0)) continue;
    // cover-fit, as the UI's `coverFit` renders it: scaled by max(panelW/imgW, panelH/imgH), then by the user's zoom
    const need = Math.max((rect.w * px.w) / image.width, (rect.h * px.h) / image.height) * panel.imageTransform.scale;
    if (!Number.isFinite(need) || need <= 1) continue;
    plans.push({ panelId: panel.id, imageId: image.id, factor: need <= 2 ? 2 : 4 });
  }
  return plans;
}

/** GET /api/pages/:id/print (proposed contract change C-1). */
export function printDetail(store: Store, pageId: string): PageDetail {
  const detail = pageDetail(store, pageId);
  const images = { ...detail.images };
  const panels = detail.panels.map((panel): Panel => {
    if (panel.activeImageId === null) return panel;
    const up = bestUpscaled(store, panel.id, panel.activeImageId);
    if (!up) return panel;
    images[up.id] = up;
    return { ...panel, activeImageId: up.id };
  });
  return { ...detail, panels, images };
}
