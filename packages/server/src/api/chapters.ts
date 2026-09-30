import type { FastifyInstance } from 'fastify';
import { CreateChapterSchema, CreatePageSchema, ReorderSchema, UpdateChapterSchema, type Chapter, type Page, type PageDetail } from '@manga/shared';
import { beforeChapterDelete, type CoreDeps } from '../deps.js';
import { chapterPages, createChapter, createCoverPage, createPage, deleteChapter, reorderPages, updateChapter } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerChapterRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { store, bus } = deps;
  app.get<IdParams>('/api/mangas/:id/chapters', async (req): Promise<Chapter[]> => {
    store.mangas.require(req.params.id);
    return store.chapters.listByManga(req.params.id);
  });

  app.post<IdParams>('/api/mangas/:id/chapters', async (req): Promise<Chapter> => {
    const chapter = createChapter(store, req.params.id, CreateChapterSchema.parse(req.body ?? {}));
    emitEntity(bus, 'chapter', chapter.id, 'created', chapter.mangaId);
    return chapter;
  });

  app.get<IdParams>('/api/chapters/:id', async (req): Promise<Chapter> => store.chapters.require(req.params.id));

  /** 409 conflict when another chapter of the manga has the requested number. */
  app.patch<IdParams>('/api/chapters/:id', async (req): Promise<Chapter> => {
    const chapter = updateChapter(store, req.params.id, UpdateChapterSchema.parse(req.body ?? {}));
    emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    return chapter;
  });

  /**
   * Emits `panel deleted` and `page deleted` (its cover included) for everything that went with the chapter. The
   * chapter delete hooks run first (M4 final I1: the episode module cancels the chapter's run jobs).
   */
  app.delete<IdParams>('/api/chapters/:id', async (req) => {
    store.chapters.require(req.params.id);
    const after = beforeChapterDelete(deps, [req.params.id]);
    const { chapter, pageIds, panelIds } = deleteChapter(store, req.params.id);
    after();
    for (const id of panelIds) emitEntity(bus, 'panel', id, 'deleted', chapter.mangaId);
    for (const id of pageIds) emitEntity(bus, 'page', id, 'deleted', chapter.mangaId);
    emitEntity(bus, 'chapter', chapter.id, 'deleted', chapter.mangaId);
    return OK;
  });

  app.post<IdParams>('/api/chapters/:id/cover', async (req): Promise<PageDetail> => {
    const chapter = store.chapters.require(req.params.id);
    const detail = createCoverPage(store, chapter.mangaId, chapter.id);
    if (detail.page.id !== chapter.coverPageId) {
      emitEntity(bus, 'page', detail.page.id, 'created', chapter.mangaId);
      emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    }
    return detail;
  });

  /** Story pages only (kind 'page'), ordered. */
  app.get<IdParams>('/api/chapters/:id/pages', async (req): Promise<Page[]> => {
    store.chapters.require(req.params.id);
    return chapterPages(store, req.params.id);
  });

  app.post<IdParams>('/api/chapters/:id/pages', async (req): Promise<PageDetail> => {
    const body = CreatePageSchema.parse(req.body ?? {});
    const detail = createPage(store, req.params.id, body.layoutPreset, body.index);
    emitEntity(bus, 'page', detail.page.id, 'created', detail.page.mangaId);
    return detail;
  });

  app.post<IdParams>('/api/chapters/:id/pages/reorder', async (req): Promise<Page[]> => {
    const { ids } = ReorderSchema.parse(req.body ?? {});
    const pages = reorderPages(store, req.params.id, ids);
    const chapter = store.chapters.require(req.params.id);
    emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    return pages;
  });
}
