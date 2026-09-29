import type { Chapter, LoraRef, Manga, PageFormat, RecipeInfo } from '@manga/shared';
import { generationRecipes } from '../lib/recipes';
import type { UpdateMangaBody } from '../types';

export function sortChapters(list: readonly Chapter[] | undefined): Chapter[] {
  return [...(list ?? [])].sort((a, b) => a.order - b.order || a.number - b.number);
}

export function validLoras(draft: readonly LoraRef[]): LoraRef[] {
  return draft.map((l) => ({ name: l.name.trim(), strength: l.strength })).filter((l) => l.name.length > 0);
}

export function mangaBadges(m: Manga): Array<{ text: string; tip: string }> {
  return [
    m.language === 'uk' ? { text: 'UK', tip: 'Ukrainian' } : { text: 'EN', tip: 'English' },
    m.colorMode === 'color' ? { text: 'Colour', tip: 'Colour pages' } : { text: 'B&W', tip: 'Black and white with screentone' },
    m.readingDirection === 'ltr' ? { text: 'LTR', tip: 'Reads left to right' } : { text: 'RTL', tip: 'Reads right to left' },
  ];
}

/** Page size and resolution are fixed (spec §2: B5 at 300 dpi), so the settings drawer only shows them. */
export function pageSizeLabel(pf: PageFormat): string {
  return `${pf.widthMm} × ${pf.heightMm} mm · ${pf.dpi} dpi`;
}

/** The manga as it will be once `patch` is saved (an optimistic update). Fields the patch leaves undefined stay as they are. */
export function applyMangaPatch(manga: Manga, patch: UpdateMangaBody): Manga {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return { ...manga, ...defined };
}

/** Recipes the style guide can use, plus the current one when the list lacks it, so a select never shows a wrong value. */
export function recipeOptions(list: readonly RecipeInfo[] | undefined, current: string): Array<{ id: string; label: string }> {
  const options = generationRecipes(list).map((r) => ({ id: r.id, label: r.label }));
  if (options.some((o) => o.id === current)) return options;
  const known = (list ?? []).find((r) => r.id === current);
  return [...options, { id: current, label: known?.label ?? current }];
}
