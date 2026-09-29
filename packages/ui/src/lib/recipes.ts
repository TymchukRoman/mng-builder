import type { RecipeInfo } from '@manga/shared';

/** Post-processing recipes: they refine or upscale an existing image, so nothing can be generated with them from scratch. */
const POST_PROCESS: ReadonlySet<string> = new Set(['anime-refine', 'upscale']);

/** Recipes a panel (or a routing slot) can generate with. */
export function generationRecipes(list: readonly RecipeInfo[] | undefined): RecipeInfo[] {
  return (list ?? []).filter((r) => !POST_PROCESS.has(r.id));
}

/** Recipes that make sense for a character portrait (no reference images needed, or a single one), in display order. */
const PORTRAIT_IDS = ['anime', 'anima', 'anima-turbo', 'klein-ref'] as const;

export function portraitRecipes(list: readonly RecipeInfo[] | undefined): RecipeInfo[] {
  const byId = new Map((list ?? []).map((r) => [r.id, r]));
  return PORTRAIT_IDS.flatMap((id) => byId.get(id) ?? []);
}
