import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateCharacterSchema, PickImageSchema, RefSlotSchema, UpdateCharacterSchema, type Character, type Image } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { createCharacter, deleteCharacter, saveUploadedImage, setCharacterRef } from '../domain/index.js';
import { defined } from '../util/defined.js';
import { emitEntity, OK, readUpload, type IdParams } from './util.js';

// Controller ruling (M1 pre-flight R3): the brief defines two identical schemas, `SlotParams` and `SlotQuery`
// (both `z.object({ slot: RefSlotSchema })`). One `SlotSchema` covers both `req.params` and `req.query`.
const SlotSchema = z.object({ slot: RefSlotSchema });

export function registerCharacterRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/mangas/:id/characters', async (req): Promise<Character[]> => {
    store.mangas.require(req.params.id);
    return store.characters.listByManga(req.params.id);
  });

  app.post<IdParams>('/api/mangas/:id/characters', async (req): Promise<Character> => {
    const character = createCharacter(store, req.params.id, CreateCharacterSchema.parse(req.body ?? {}));
    emitEntity(bus, 'character', character.id, 'created', character.mangaId);
    return character;
  });

  app.get<IdParams>('/api/characters/:id', async (req): Promise<Character> => store.characters.require(req.params.id));

  app.patch<IdParams>('/api/characters/:id', async (req): Promise<Character> => {
    const character = store.characters.update(req.params.id, defined(UpdateCharacterSchema.parse(req.body ?? {})));
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return character;
  });

  /** Also emits `panel updated` for scripts/refs that lost the character and `textFrame updated` for frames that lost their speaker. */
  app.delete<IdParams>('/api/characters/:id', async (req) => {
    const { character, panelIds, frameIds } = deleteCharacter(store, req.params.id);
    for (const id of panelIds) emitEntity(bus, 'panel', id, 'updated', character.mangaId);
    for (const id of frameIds) emitEntity(bus, 'textFrame', id, 'updated', character.mangaId);
    emitEntity(bus, 'character', character.id, 'deleted', character.mangaId);
    return OK;
  });

  app.get<IdParams>('/api/characters/:id/images', async (req): Promise<Image[]> => {
    store.characters.require(req.params.id);
    return store.images.listByOwner('character', req.params.id);
  });

  app.post<{ Params: { id: string; slot: string } }>('/api/characters/:id/refs/:slot', async (req): Promise<Character> => {
    const { slot } = SlotSchema.parse(req.params);
    const { imageId } = PickImageSchema.parse(req.body ?? {});
    const character = setCharacterRef(store, req.params.id, slot, imageId);
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return character;
  });

  /** Sets refs[slot] in the transaction that re-checks the character still exists. */
  app.post<{ Params: { id: string }; Querystring: { slot?: string } }>('/api/characters/:id/upload', async (req): Promise<Image> => {
    const character = store.characters.require(req.params.id);
    const { slot } = SlotSchema.parse(req.query);
    const upload = await readUpload(req);
    const owner = { type: 'character' as const, id: character.id };
    const image = saveUploadedImage(store, { mangaId: character.mangaId, owner, role: slot, bytes: upload.bytes }, (saved) => {
      setCharacterRef(store, character.id, slot, saved.id);
    });
    emitEntity(bus, 'image', image.id, 'created', image.mangaId);
    emitEntity(bus, 'character', character.id, 'updated', character.mangaId);
    return image;
  });
}
