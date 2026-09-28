import { buildPreset, computeRects, type PageFormat, type ReadingDirection, type Rect } from '@manga/shared';

/** Client-side preview of a preset: the same tree the server would build, with throwaway ids. */
export function presetRects(name: string, dir: ReadingDirection, format: PageFormat): Rect[] {
  let n = 0;
  const tree = buildPreset(name, dir, () => `pv_preview${n++}`);
  return computeRects(tree, format).map((r) => r.rect);
}
