import { applyImageModel, imageModelById, type Manga, type Panel, type Settings } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import { RECIPES } from './recipes/index.js';

export type PromptStyle = 'tags' | 'natural';

/** Qwen-Image-Edit and FLUX.2 klein follow sentences; the SDXL and Anima recipes want Danbooru tags. */
export function promptStyleFor(recipeId: string): PromptStyle {
  const family = RECIPES[recipeId]?.family;
  return family === 'qwen' || family === 'flux2' ? 'natural' : 'tags';
}

/** FLUX.2 klein zeroes its negative conditioning (ConditioningZeroOut); every other family encodes the negative prompt. */
export function takesNegative(recipeId: string): boolean {
  return RECIPES[recipeId]?.family !== 'flux2';
}

/** B&W books get an img2img pass after the reference recipes that lose the ink/screentone look. */
export function refineFor(settings: Settings, manga: Manga, recipeId: string): string | null {
  return manga.colorMode === 'bw' && promptStyleFor(recipeId) === 'natural' ? settings.routing.bwRefine : null;
}

/**
 * `imageModel`: the preset the panel's chapter or manga renders with (shared `effectiveImageModel`); its three routes replace
 * Settings' (a panel's own recipe still wins), and a panel without references then uses the model's own no-character route
 * instead of the manga style's recipe, so the whole chapter comes from one model.
 */
export function routeRecipe(input: {
  settings: Settings; manga: Manga; panel: Panel; refCount: number; charCount: number; imageModel?: string | null;
}): { recipe: string; refineWith: string | null } {
  const { manga, panel, refCount, charCount } = input;
  const settings = applyImageModel(input.settings, input.imageModel);
  let recipe: string;
  if (panel.recipe) {
    recipe = panel.recipe;
  } else if (refCount === 0) {
    const style = RECIPES[manga.styleGuide.recipe];
    // Upscale works on an existing image, not on generating a new panel from scratch.
    recipe = imageModelById(input.imageModel) === null && style && style.family !== 'sdxl' && style.family !== 'upscale' && !style.requiresRefs
      ? style.id : settings.routing.noChars;
  } else if (charCount <= 1) {
    recipe = settings.routing.oneChar;
  } else {
    recipe = settings.routing.multiChar;
  }
  if (!RECIPES[recipe]) throw new PermanentError(`unknown recipe "${recipe}" (check the panel's recipe or Settings → routing)`);
  const refineWith = refineFor(settings, manga, recipe);
  if (refineWith && !RECIPES[refineWith]) throw new PermanentError(`unknown refine recipe "${refineWith}" (check Settings → routing.bwRefine)`);
  return { recipe, refineWith };
}
