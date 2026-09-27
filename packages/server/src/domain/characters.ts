import type { z } from 'zod';
import type { Character, CreateCharacterSchema, RefSlot } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { randomSeed } from './seed.js';

export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>;

/** Seed random if omitted. */
export function createCharacter(store: Store, mangaId: string, input: CreateCharacterInput): Character {
  store.mangas.require(mangaId);
  return store.characters.create({
    mangaId,
    name: input.name,
    role: input.role,
    personality: input.personality,
    speechStyle: input.speechStyle,
    appearanceTags: input.appearanceTags,
    seed: input.seed ?? randomSeed(),
    recipe: input.recipe,
    refs: {},
  });
}

/** Points a ref slot at one of the character's own images. */
export function setCharacterRef(store: Store, characterId: string, slot: RefSlot, imageId: string): Character {
  const character = store.characters.require(characterId);
  const image = store.images.require(imageId);
  if (image.ownerType !== 'character' || image.ownerId !== characterId) {
    throw new ValidationError(`image ${imageId} does not belong to character ${characterId}`);
  }
  const refs = { ...character.refs };
  refs[slot] = imageId;
  return store.characters.update(characterId, { refs });
}
