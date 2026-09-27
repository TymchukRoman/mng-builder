import type { FastifyInstance } from 'fastify';
import { ApplyPresetSchema, CreateFrameSchema, MergeSchema, ResizeSchema, SplitSchema, type PageDetail, type TextFrame } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { applyPreset, createFrame, deletePage, mergePagePanels, pageDetail, resizePageSplit, splitPagePanel } from '../domain/index.js';
import { emitEntity, mangaIdOfPage, OK, type IdParams } from './util.js';

export function registerPageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  const changed = (detail: PageDetail): PageDetail => {
    emitEntity(bus, 'page', detail.page.id, 'updated', detail.page.mangaId);
    return detail;
  };

  app.get<IdParams>('/api/pages/:id', async (req): Promise<PageDetail> => pageDetail(store, req.params.id));

  app.delete<IdParams>('/api/pages/:id', async (req) => {
    const page = deletePage(store, req.params.id);
    emitEntity(bus, 'page', page.id, 'deleted', page.mangaId);
    return OK;
  });

  /** 409 needs_confirm (details { removedPanelIds }) when the preset has fewer panels and confirm is false. */
  app.post<IdParams>('/api/pages/:id/layout/preset', async (req): Promise<PageDetail> => {
    const { preset, confirm } = ApplyPresetSchema.parse(req.body ?? {});
    return changed(applyPreset(store, req.params.id, preset, confirm));
  });

  app.post<IdParams>('/api/pages/:id/layout/split', async (req): Promise<PageDetail> => {
    const { panelId, dir } = SplitSchema.parse(req.body ?? {});
    return changed(splitPagePanel(store, req.params.id, panelId, dir));
  });

  app.post<IdParams>('/api/pages/:id/layout/merge', async (req): Promise<PageDetail> => {
    const { panelIdA, panelIdB } = MergeSchema.parse(req.body ?? {});
    return changed(mergePagePanels(store, req.params.id, panelIdA, panelIdB));
  });

  app.post<IdParams>('/api/pages/:id/layout/resize', async (req): Promise<PageDetail> => {
    const { path, ratio } = ResizeSchema.parse(req.body ?? {});
    return changed(resizePageSplit(store, req.params.id, path, ratio));
  });

  app.post<IdParams>('/api/pages/:id/frames', async (req): Promise<TextFrame> => {
    const frame = createFrame(store, req.params.id, CreateFrameSchema.parse(req.body ?? {}));
    emitEntity(bus, 'textFrame', frame.id, 'created', mangaIdOfPage(store, frame.pageId));
    return frame;
  });
}
