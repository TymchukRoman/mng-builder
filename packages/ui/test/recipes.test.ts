import { describe, expect, it } from 'vitest';
import type { RecipeInfo } from '@manga/shared';
import { generationRecipes, portraitRecipes } from '../src/lib/recipes';

const recipe = (id: string): RecipeInfo => ({
  id, label: id, maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
});
const ALL = ['anime', 'anime-ref', 'anime-pose', 'qwen-edit-ref', 'klein-ref', 'anima', 'anima-turbo', 'anime-refine', 'upscale'].map(recipe);

describe('recipe lists', () => {
  it('leaves out the refine and upscale post-processing recipes from what a panel can generate with', () => {
    expect(generationRecipes(ALL).map((r) => r.id)).toEqual(['anime', 'anime-ref', 'anime-pose', 'qwen-edit-ref', 'klein-ref', 'anima', 'anima-turbo']);
    expect(generationRecipes(undefined)).toEqual([]);
  });

  it('offers the four portrait recipes in a fixed order', () => {
    expect(portraitRecipes(ALL).map((r) => r.id)).toEqual(['anime', 'anima', 'anima-turbo', 'klein-ref']);
    expect(portraitRecipes(ALL.slice(0, 2)).map((r) => r.id)).toEqual(['anime']);
    expect(portraitRecipes(undefined)).toEqual([]);
  });
});
