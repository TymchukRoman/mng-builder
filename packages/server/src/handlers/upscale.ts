import type { ImageUpscalePayload, ImageUpscaleResult } from '@manga/shared';
import { generateImage } from '../imaging/generate.js';
import type { JobContext } from '../jobs/index.js';
import { emitEntity } from './context.js';
import type { HandlerServices } from './types.js';

/**
 * Print upscale (spec §9.2): a 4x-AnimeSharp pass through the `upscale` recipe, cached as an 'upscaled' Image
 * with `parentImageId` set to the source (M4's export enqueues it). `generateImage` already owns the owner
 * re-check and file cleanup (Task 15/17 pattern) — this handler never writes PNGs or Image rows itself.
 */
export async function upscaleImage(ctx: JobContext, services: HandlerServices, p: ImageUpscalePayload): Promise<ImageUpscaleResult> {
  const source = ctx.store.images.require(p.imageId);
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: source.mangaId, owner: { type: source.ownerType, id: source.ownerId }, role: null, recipe: 'upscale', prompt: '', negative: '',
    width: source.width * p.factor, height: source.height * p.factor, seed: 0, loras: [], refImageIds: [], control: null,
    initImageId: source.id, denoise: null, upscale: p.factor,
  }, { signal: ctx.signal, progress: ctx.progress });
  emitEntity(ctx.bus, 'image', image.id, 'created', source.mangaId);
  return { imageId: image.id };
}
