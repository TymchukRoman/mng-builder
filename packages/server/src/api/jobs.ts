import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GPU_MANUAL_PAUSE_REASON, JobStatusSchema, type Job, type QueueLanes } from '@manga/shared';
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

  // W1 R2: the manual override. A manual pause is never lifted by the GPU monitor; a resume lifts any gpu pause.
  app.post('/api/queue/gpu/pause', async (): Promise<QueueLanes> => {
    queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    return { pausedLanes: queue.pausedLanes() };
  });
  app.post('/api/queue/gpu/resume', async (): Promise<QueueLanes> => {
    queue.resumeLane('gpu');
    return { pausedLanes: queue.pausedLanes() };
  });
}
