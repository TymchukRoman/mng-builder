import { describe, expect, it } from 'vitest';
import type { Character, RecipeInfo } from '@manga/shared';
import { PORTRAIT_BATCH, REF_SLOTS, canGenerateSheet, characterRecipeOptions, imagesForSlot, slotLabel } from '../src/characters/characterModel';
import { makeImage } from './fixtures';

const character = (refs: Character['refs']): Character => ({
  id: 'cr_1', mangaId: 'mg_1', name: 'Aiko', role: 'main', personality: '', speechStyle: '', appearanceTags: '',
  seed: 7, recipe: null, refs, createdAt: '', updatedAt: '',
});

const recipe = (id: string): RecipeInfo => ({
  id, label: id.toUpperCase(), maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
});

describe('character model', () => {
  it('lists a slot’s images newest first', () => {
    const images = [
      makeImage('im_1', { ownerType: 'character', role: 'portrait', createdAt: '2026-09-01T00:00:00Z' }),
      makeImage('im_2', { ownerType: 'character', role: 'fullbody', createdAt: '2026-09-02T00:00:00Z' }),
      makeImage('im_3', { ownerType: 'character', role: 'portrait', createdAt: '2026-09-03T00:00:00Z' }),
    ];
    expect(imagesForSlot(images, 'portrait').map((i) => i.id)).toEqual(['im_3', 'im_1']);
    expect(imagesForSlot(undefined, 'back')).toEqual([]);
    expect(images.map((i) => i.id)).toEqual(['im_1', 'im_2', 'im_3']);
  });

  it('needs a picked portrait before generating the sheet', () => {
    expect(canGenerateSheet(character({}))).toEqual({ enabled: false, reason: 'Generate sheet: pick a portrait first' });
    expect(canGenerateSheet(character({ portrait: 'im_1' }))).toEqual({ enabled: true, reason: 'Generate sheet (full body, side, back)' });
  });

  it('labels the four slots in order', () => {
    expect(REF_SLOTS.map(slotLabel)).toEqual(['Portrait', 'Full body', 'Side', 'Back']);
  });

  it('generates a batch of four portraits, within the server’s 1-8 range', () => {
    expect(PORTRAIT_BATCH).toBe(4);
  });

  it('offers Auto plus the portrait recipes, keeping a recipe set elsewhere selectable', () => {
    const list = ['upscale', 'anime', 'anime-ref', 'klein-ref'].map(recipe);
    expect(characterRecipeOptions(list, null)).toEqual([
      { value: '', label: 'Auto' }, { value: 'anime', label: 'ANIME' }, { value: 'klein-ref', label: 'KLEIN-REF' },
    ]);
    expect(characterRecipeOptions(list, 'anime-ref').map((o) => o.value)).toEqual(['', 'anime', 'klein-ref', 'anime-ref']);
    expect(characterRecipeOptions(list, 'anime-ref').at(-1)).toEqual({ value: 'anime-ref', label: 'ANIME-REF' });
    expect(characterRecipeOptions(undefined, 'gone')).toEqual([{ value: '', label: 'Auto' }, { value: 'gone', label: 'gone' }]);
  });
});
