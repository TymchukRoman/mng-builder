import type { FastifyInstance } from 'fastify';
import { UpdateFrameSchema, type TextFrame } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { updateFrame } from '../domain/index.js';
import { emitEntity, mangaIdOfPage, OK, type IdParams } from './util.js';

export function registerFrameRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/frames/:id', async (req): Promise<TextFrame> => store.frames.require(req.params.id));

  app.patch<IdParams>('/api/frames/:id', async (req): Promise<TextFrame> => {
    const frame = updateFrame(store, req.params.id, UpdateFrameSchema.parse(req.body ?? {}));
    emitEntity(bus, 'textFrame', frame.id, 'updated', mangaIdOfPage(store, frame.pageId));
    return frame;
  });

  app.delete<IdParams>('/api/frames/:id', async (req) => {
    const frame = store.frames.require(req.params.id);
    store.frames.delete(frame.id);
    emitEntity(bus, 'textFrame', frame.id, 'deleted', mangaIdOfPage(store, frame.pageId));
    return OK;
  });
}
