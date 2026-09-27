import type { FastifyInstance } from 'fastify';
import { CreateChapterSchema, CreatePageSchema, ReorderSchema, UpdateChapterSchema, type Chapter, type Page, type PageDetail } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { chapterPages, createChapter, createCoverPage, createPage, deleteChapter, reorderPages } from '../domain/index.js';
import { defined } from '../util/defined.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerChapterRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
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

  app.patch<IdParams>('/api/chapters/:id', async (req): Promise<Chapter> => {
    const chapter = store.chapters.update(req.params.id, defined(UpdateChapterSchema.parse(req.body ?? {})));
    emitEntity(bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
    return chapter;
  });

  /** Emits `panel deleted` and `page deleted` (its cover included) for everything that went with the chapter. */
  app.delete<IdParams>('/api/chapters/:id', async (req) => {
    const { chapter, pageIds, panelIds } = deleteChapter(store, req.params.id);
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
