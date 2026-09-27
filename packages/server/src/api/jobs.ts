import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JobStatusSchema, type Job } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import type { IdParams } from './util.js';

const JobListQuery = z.object({
  status: JobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export function registerJobRoutes(app: FastifyInstance, { store, queue }: CoreDeps): void {
  /** Newest first. */
  app.get('/api/jobs', async (req): Promise<Job[]> => {
    const query = JobListQuery.parse(req.query ?? {});
    return store.jobs.list({ ...(query.status === undefined ? {} : { status: query.status }), limit: query.limit });
  });

  app.get<IdParams>('/api/jobs/:id', async (req): Promise<Job> => store.jobs.require(req.params.id));

  app.post<IdParams>('/api/jobs/:id/cancel', async (req): Promise<Job> => queue.cancel(req.params.id));
}
