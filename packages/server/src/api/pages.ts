import type { FastifyInstance } from 'fastify';
import { ApplyPresetSchema, CreateFrameSchema, MergeSchema, panelIds, ResizeSchema, SplitSchema, type PageDetail, type TextFrame } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { applyPreset, createFrame, deletePage, mergePagePanels, pageDetail, resizePageSplit, splitPagePanel } from '../domain/index.js';
import { emitEntity, mangaIdOfPage, OK, type IdParams } from './util.js';

export function registerPageRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  const changed = (detail: PageDetail): PageDetail => {
    emitEntity(bus, 'page', detail.page.id, 'updated', detail.page.mangaId);
    return detail;
  };

  /**
   * Layout ops can add/remove Panel rows (split adds one, merge deletes one, a preset can do both). Contract B's
   * two-tier event pattern requires each mutated panel to get its own `created`/`deleted` event in addition to
   * the page's `updated` event, so clients tracking a panel via GET /api/panels/:id learn it is gone or new.
   */
  const emitPanelDelta = (before: readonly string[], detail: PageDetail): void => {
    const beforeIds = new Set(before);
    const afterIds = detail.panels.map((panel) => panel.id);
    const afterSet = new Set(afterIds);
    for (const id of before) {
      if (!afterSet.has(id)) emitEntity(bus, 'panel', id, 'deleted', detail.page.mangaId);
    }
    for (const id of afterIds) {
      if (!beforeIds.has(id)) emitEntity(bus, 'panel', id, 'created', detail.page.mangaId);
    }
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
    const before = panelIds(store.pages.require(req.params.id).layout);
    const detail = applyPreset(store, req.params.id, preset, confirm);
    emitPanelDelta(before, detail);
    return changed(detail);
  });

  app.post<IdParams>('/api/pages/:id/layout/split', async (req): Promise<PageDetail> => {
    const { panelId, dir } = SplitSchema.parse(req.body ?? {});
    const before = panelIds(store.pages.require(req.params.id).layout);
    const detail = splitPagePanel(store, req.params.id, panelId, dir);
    emitPanelDelta(before, detail);
    return changed(detail);
  });

  app.post<IdParams>('/api/pages/:id/layout/merge', async (req): Promise<PageDetail> => {
    const { panelIdA, panelIdB } = MergeSchema.parse(req.body ?? {});
    const before = panelIds(store.pages.require(req.params.id).layout);
    const detail = mergePagePanels(store, req.params.id, panelIdA, panelIdB);
    emitPanelDelta(before, detail);
    return changed(detail);
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
