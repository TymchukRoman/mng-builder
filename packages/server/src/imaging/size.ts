import { SDXL_SIZES, computeRects, pickSize, type Page, type PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import type { Recipe } from './recipes/index.js';

/** Character portraits and sheet views: SDXL's tall bucket. */
export const PORTRAIT_SIZE: [number, number] = [832, 1216];

/** Width/height of the panel on paper (rects are normalized separately per axis, so convert to mm first). */
export function panelAspect(page: Page, format: PageFormat, panelId: string): number {
  const hit = computeRects(page.layout, format).find((r) => r.panelId === panelId);
  if (!hit) throw new PermanentError(`Panel ${panelId} is not in the layout of page ${page.id}`);
  return (hit.rect.w * format.widthMm) / (hit.rect.h * format.heightMm);
}

export function panelSize(page: Page, format: PageFormat, panelId: string, recipe: Recipe): [number, number] {
  return pickSize(panelAspect(page, format, panelId), recipe.sizes.length > 0 ? recipe.sizes : SDXL_SIZES);
}
