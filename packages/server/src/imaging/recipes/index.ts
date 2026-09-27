import { anima } from './anima.js';
import { animaTurbo } from './anima-turbo.js';
import { anime } from './anime.js';
import { animePose } from './anime-pose.js';
import { animeRef } from './anime-ref.js';
import { animeRefine } from './anime-refine.js';
import { kleinRef } from './klein-ref.js';
import { qwenEditRef } from './qwen-edit-ref.js';
import type { Recipe } from './types.js';
import { upscale } from './upscale.js';

const ALL: Recipe[] = [anime, animeRef, animePose, qwenEditRef, kleinRef, anima, animaTurbo, animeRefine, upscale];

/** Contract C.7 ids: anime, anime-ref, anime-pose, qwen-edit-ref, klein-ref, anima, anima-turbo, anime-refine, upscale. */
export const RECIPES: Record<string, Recipe> = Object.fromEntries(ALL.map((r) => [r.id, r]));

export { recipeInfo, RecipeInputError, type Recipe, type RecipeParams } from './types.js';
