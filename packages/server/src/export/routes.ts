// packages/server/src/export/routes.ts
import type { FastifyInstance } from 'fastify';
import { ExportSchema, type ExportRenderPayload, type JobRef, type PageDetail } from '@manga/shared';
import type { IdParams } from '../api/util.js';
import type { JobQueue } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import { printDetail } from './hires.js';

/** Contract B: POST /api/export and GET /api/pages/:id/print. A missing target is a 404 (NotFoundError), a bad body a 400 (ZodError). */
export function registerExportRoutes(app: FastifyInstance, deps: { store: Store; queue: JobQueue }): void {
  app.post('/api/export', async (req): Promise<JobRef> => {
    const body = ExportSchema.parse(req.body ?? {});
    if (body.target.type === 'page') deps.store.pages.require(body.target.id);
    else deps.store.chapters.require(body.target.id);
    const payload: ExportRenderPayload = { target: body.target, format: body.format, ...(body.outDir ? { outDir: body.outDir } : {}) };
    return { jobId: deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload, maxAttempts: 1 }).id };
  });

  app.get<IdParams>('/api/pages/:id/print', async (req): Promise<PageDetail> => printDetail(deps.store, req.params.id));
}
