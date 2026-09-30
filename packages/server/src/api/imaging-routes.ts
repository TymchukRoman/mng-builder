import type { FastifyInstance } from 'fastify';
import {
  GeneratePanelSchema, PortraitsSchema,
  type CharacterRefsPayload, type ImageGeneratePayload, type ImageReviewPayload, type JobRef, type JobRefs, type RecipeInfo,
} from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { ConflictError, ValidationError } from '../errors.js';
import { enqueuePortraits } from '../imaging/portraits.js';
import { RECIPES, recipeInfo } from '../imaging/recipes/index.js';
import type { M2Services } from '../modules/services.js';
import type { IdParams } from './util.js';

/**
 * Contract B: recipes list, character portraits/sheet, panel generate/review. Every route 404s (via
 * `store.*.require`) for a missing character/panel before enqueuing (m2-rulings Task 22). None of these routes
 * change rows directly — the enqueued job handlers own the writes and their own entity events (Tasks 17-19) — so
 * there is nothing for these routes to emit themselves.
 */
export function registerImagingRoutes(app: FastifyInstance, deps: CoreDeps, services: M2Services): void {
  const { store, queue } = deps;

  app.get('/api/recipes', async (): Promise<RecipeInfo[]> => Object.values(RECIPES).map(recipeInfo));

  app.post<IdParams>('/api/characters/:id/portraits', async (req): Promise<JobRefs> => {
    const character = store.characters.require(req.params.id);
    const { n } = PortraitsSchema.parse(req.body ?? {});
    return { jobIds: enqueuePortraits(queue, character, n).map((j) => j.id) };
  });

  app.post<IdParams>('/api/characters/:id/sheet', async (req): Promise<JobRef> => {
    const character = store.characters.require(req.params.id);
    const portrait = character.refs.portrait ? store.images.get(character.refs.portrait) : null;
    if (!portrait) throw new ConflictError(`${character.name} has no portrait yet: generate portraits and pick one first`);
    const payload: CharacterRefsPayload = { characterId: character.id };
    return { jobId: queue.enqueue({ kind: 'character.refs', lane: 'gpu', payload }).id };
  });

  app.post<IdParams>('/api/panels/:id/generate', async (req): Promise<JobRef> => {
    const panel = store.panels.require(req.params.id);
    const { recipe, seed } = GeneratePanelSchema.parse(req.body ?? {});
    if (recipe !== undefined && !RECIPES[recipe]) {
      throw new ValidationError(`Unknown recipe "${recipe}". Known recipes: ${Object.keys(RECIPES).join(', ')}`);
    }
    const payload: ImageGeneratePayload = {
      target: 'panel', panelId: panel.id, ...(recipe !== undefined ? { recipe } : {}), ...(seed !== undefined ? { seed } : {}),
    };
    return { jobId: queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload }).id };
  });

  app.post<IdParams>('/api/panels/:id/review', async (req): Promise<JobRef> => {
    const panel = store.panels.require(req.params.id);
    if (!panel.activeImageId) throw new ConflictError('This panel has no image to review yet');
    const payload: ImageReviewPayload = { imageId: panel.activeImageId, panelId: panel.id };
    return { jobId: queue.enqueue({ kind: 'image.review', lane: services.engines.laneFor('review'), payload }).id };
  });
}
