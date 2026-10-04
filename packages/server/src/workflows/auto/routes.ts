import type { FastifyInstance } from 'fastify';
import { StartAutoMangaSchema, type AutoRun } from '@manga/shared';
import type { IdParams } from '../../api/util.js';
import type { AutoRunner } from './runner.js';

/**
 * Auto-created manga: start one from a brief, read the latest run of a manga, cancel it, or run a failed one again. Errors need no
 * mapping: the runner throws ConflictError, ValidationError or NotFoundError, and a ZodError is a 400.
 */
export function registerAutoRoutes(app: FastifyInstance, deps: { runner: AutoRunner }): void {
  const { runner } = deps;
  app.post('/api/auto-mangas', async (req): Promise<AutoRun> => runner.start(StartAutoMangaSchema.parse(req.body ?? {}).input));
  app.get<IdParams>('/api/auto-runs/:id', async (req): Promise<AutoRun> => runner.get(req.params.id));
  app.get<IdParams>('/api/mangas/:id/auto-run', async (req): Promise<AutoRun | null> => runner.latest(req.params.id));
  app.post<IdParams>('/api/auto-runs/:id/cancel', async (req): Promise<AutoRun> => runner.cancel(req.params.id));
  app.post<IdParams>('/api/auto-runs/:id/resume', async (req): Promise<AutoRun> => runner.resumeRun(req.params.id));
}
