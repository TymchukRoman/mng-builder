import type { FastifyInstance } from 'fastify';
import { UpdatePanelSchema, type Image, type Panel } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { saveUploadedImage, updatePanel } from '../domain/index.js';
import { emitEntity, mangaIdOfPage, readUpload, type IdParams } from './util.js';

export function registerPanelRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get<IdParams>('/api/panels/:id', async (req): Promise<Panel> => store.panels.require(req.params.id));

  app.patch<IdParams>('/api/panels/:id', async (req): Promise<Panel> => {
    const panel = updatePanel(store, req.params.id, UpdatePanelSchema.parse(req.body ?? {}));
    emitEntity(bus, 'panel', panel.id, 'updated', mangaIdOfPage(store, panel.pageId));
    return panel;
  });

  app.get<IdParams>('/api/panels/:id/images', async (req): Promise<Image[]> => {
    store.panels.require(req.params.id);
    return store.images.listByOwner('panel', req.params.id);
  });

  /** The uploaded image becomes the panel's active variant. */
  app.post<IdParams>('/api/panels/:id/upload', async (req): Promise<Image> => {
    const panel = store.panels.require(req.params.id);
    const mangaId = mangaIdOfPage(store, panel.pageId);
    const upload = await readUpload(req);
    const image = saveUploadedImage(store, { mangaId, owner: { type: 'panel', id: panel.id }, role: null, bytes: upload.bytes, mimetype: upload.mimetype });
    store.panels.update(panel.id, { activeImageId: image.id });
    emitEntity(bus, 'image', image.id, 'created', mangaId);
    emitEntity(bus, 'panel', panel.id, 'updated', mangaId);
    return image;
  });
}
