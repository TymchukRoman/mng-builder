import type { z } from 'zod';
import { DEFAULT_TRANSFORM, EMPTY_SCRIPT, type Panel, type UpdatePanelSchema } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { NewPanel, Store } from '../store/index.js';
import { defined } from '../util/defined.js';
import { randomSeed } from './seed.js';

export type UpdatePanelInput = z.infer<typeof UpdatePanelSchema>;

/** A blank panel row for a layout leaf. */
export function newPanelInput(pageId: string, id: string): NewPanel {
  return {
    id, pageId, script: structuredClone(EMPTY_SCRIPT), prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: randomSeed(), refCharacterIds: [], activeImageId: null, imageTransform: { ...DEFAULT_TRANSFORM },
  };
}

function requireCharacterOf(store: Store, mangaId: string, characterId: string): void {
  const character = store.characters.require(characterId);
  if (character.mangaId !== mangaId) throw new ValidationError(`character ${characterId} belongs to another manga`);
}

export function updatePanel(store: Store, panelId: string, patch: UpdatePanelInput): Panel {
  const panel = store.panels.require(panelId);
  const { mangaId } = store.pages.require(panel.pageId);
  if (patch.activeImageId) {
    const image = store.images.require(patch.activeImageId);
    if (image.ownerType !== 'panel' || image.ownerId !== panelId) throw new ValidationError(`image ${image.id} is not a variant of panel ${panelId}`);
  }
  for (const id of patch.refCharacterIds ?? []) requireCharacterOf(store, mangaId, id);
  for (const c of patch.script?.characters ?? []) requireCharacterOf(store, mangaId, c.characterId);
  for (const line of patch.script?.dialogue ?? []) {
    if (line.speakerId !== null) requireCharacterOf(store, mangaId, line.speakerId);
  }
  return store.panels.update(panelId, defined(patch));
}
