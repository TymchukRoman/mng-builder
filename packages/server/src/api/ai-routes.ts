import type { FastifyInstance } from 'fastify';
import { SuggestAppearanceSchema, type JobRef, type LlmStepPayload } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import type { M2Services } from '../modules/services.js';
import type { IdParams } from './util.js';

/**
 * Contract B: character suggest-appearance and panel AI-prompt. Both 404 (via `store.*.require`) before enqueuing;
 * neither changes rows directly — the `llm.step` handlers (Task 20) own the writes and their own entity events.
 */
export function registerAiRoutes(app: FastifyInstance, deps: CoreDeps, services: M2Services): void {
  const { store, queue } = deps;

  app.post<IdParams>('/api/characters/:id/suggest-appearance', async (req): Promise<JobRef> => {
    const character = store.characters.require(req.params.id);
    const { description } = SuggestAppearanceSchema.parse(req.body ?? {});
    const payload: LlmStepPayload = { type: 'appearance', characterId: character.id, description };
    return { jobId: queue.enqueue({ kind: 'llm.step', lane: services.engines.laneFor('prompts'), payload }).id };
  });

  app.post<IdParams>('/api/panels/:id/prompt', async (req): Promise<JobRef> => {
    const panel = store.panels.require(req.params.id);
    const payload: LlmStepPayload = { type: 'panel-prompt', panelId: panel.id };
    return { jobId: queue.enqueue({ kind: 'llm.step', lane: services.engines.laneFor('prompts'), payload }).id };
  });
}
