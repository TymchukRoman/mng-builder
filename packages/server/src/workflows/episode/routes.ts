import type { FastifyInstance } from 'fastify';
import {
  EpisodeStepNameSchema, RerunStepSchema, StartEpisodeSchema, StepOutputSchema, type EpisodeRun, type PageDetail,
} from '@manga/shared';
import { emitEntity, mangaIdOfPage, type IdParams } from '../../api/util.js';
import { letterPage } from '../../domain/lettering.js';
import { pageDetail } from '../../domain/pages.js';
import type { EventBus } from '../../events/bus.js';
import type { Store } from '../../store/index.js';
import type { EpisodeRunner } from './runner.js';

interface StepParams { Params: { id: string; step: string } }

/**
 * Contract B, M4 rows (except /api/export) plus auto-letter. Errors need no mapping: the runner throws ConflictError,
 * ValidationError, NeedsConfirmError, NotFoundError or a ZodError, and M1's error handler answers for them. The bodyless
 * POSTs (approve, autopilot, cancel, auto-letter) never read a body.
 */
export function registerEpisodeRoutes(app: FastifyInstance, deps: { store: Store; bus: EventBus; runner: EpisodeRunner }): void {
  const { store, bus, runner } = deps;

  app.post<IdParams>('/api/chapters/:id/episode', async (req): Promise<EpisodeRun> => {
    const body = StartEpisodeSchema.parse(req.body ?? {});
    return runner.start(req.params.id, body.input, body.mode);
  });
  app.get<IdParams>('/api/chapters/:id/episode', async (req): Promise<EpisodeRun | null> => runner.latest(req.params.id));

  app.post<IdParams>('/api/episodes/:id/approve', async (req): Promise<EpisodeRun> => runner.approve(req.params.id));
  app.post<IdParams>('/api/episodes/:id/autopilot', async (req): Promise<EpisodeRun> => runner.autopilot(req.params.id));
  app.post<IdParams>('/api/episodes/:id/cancel', async (req): Promise<EpisodeRun> => runner.cancel(req.params.id));

  app.put<StepParams>('/api/episodes/:id/steps/:step/output', async (req): Promise<EpisodeRun> => {
    const step = EpisodeStepNameSchema.parse(req.params.step);
    const { output } = StepOutputSchema.parse(req.body ?? {});
    return runner.editOutput(req.params.id, step, output);
  });
  app.post<StepParams>('/api/episodes/:id/steps/:step/rerun', async (req): Promise<EpisodeRun> => {
    const step = EpisodeStepNameSchema.parse(req.params.step);
    const { confirm } = RerunStepSchema.parse(req.body ?? {});
    return runner.rerun(req.params.id, step, confirm);
  });

  // letterPage emits nothing; like POST /api/pages/:id/frames, this route announces each frame it created.
  app.post<IdParams>('/api/pages/:id/auto-letter', async (req): Promise<PageDetail> => {
    const created = letterPage(store, req.params.id);
    const mangaId = mangaIdOfPage(store, req.params.id);
    for (const frame of created) emitEntity(bus, 'textFrame', frame.id, 'created', mangaId);
    return pageDetail(store, req.params.id);
  });
}
