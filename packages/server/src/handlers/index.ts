import type { CharacterRefsPayload, ImageGeneratePayload, ImageReviewPayload, ImageUpscalePayload } from '@manga/shared';
import { PermanentError, type JobHandler, type JobQueue } from '../jobs/index.js';
import { generateCharacterRefs, generatePortrait, generateSlot } from './character-images.js';
import { generatePanelImage } from './panel-image.js';
import { reviewImage } from './review.js';
import type { HandlerServices } from './types.js';
import { upscaleImage } from './upscale.js';

export function imageGenerateHandler(services: HandlerServices): JobHandler {
  return async (ctx) => {
    const payload = ctx.job.payload as ImageGeneratePayload;
    switch (payload.target) {
      case 'panel':
        return generatePanelImage(ctx, services, payload);
      case 'character-portrait':
        return generatePortrait(ctx, services, payload);
      case 'character-slot':
        return generateSlot(ctx, services, payload);
      default:
        throw new PermanentError(`Unknown image.generate target "${String((payload as { target?: unknown }).target)}"`);
    }
  };
}

export function registerImagingJobs(queue: JobQueue, services: HandlerServices): void {
  queue.register('image.generate', imageGenerateHandler(services));
  queue.register('image.review', (ctx) => reviewImage(ctx, services, ctx.job.payload as ImageReviewPayload));
  queue.register('image.upscale', (ctx) => upscaleImage(ctx, services, ctx.job.payload as ImageUpscalePayload));
  queue.register('character.refs', (ctx) => generateCharacterRefs(ctx, services, ctx.job.payload as CharacterRefsPayload));
}
