import type { FastifyInstance } from 'fastify';
import { CreateMangaSchema, UpdateMangaSchema, type Manga, type PageDetail } from '@manga/shared';
import { beforeChapterDelete, type CoreDeps } from '../deps.js';
import { createCoverPage, createManga, deleteManga, updateManga } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerMangaRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { store, bus } = deps;
  app.get('/api/mangas', async (): Promise<Manga[]> => store.mangas.list());

  /**
   * CreateMangaSchema defaults colorMode to 'bw', so the raw body tells whether the client chose it: when it did not,
   * the style preset's colour mode applies.
   */
  app.post('/api/mangas', async (req): Promise<Manga> => {
    const { colorMode, ...rest } = CreateMangaSchema.parse(req.body ?? {});
    const chosen = typeof req.body === 'object' && req.body !== null && (req.body as Record<string, unknown>)['colorMode'] !== undefined;
    const manga = createManga(store, chosen ? { ...rest, colorMode } : rest);
    emitEntity(bus, 'manga', manga.id, 'created', manga.id);
    return manga;
  });

  app.get<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => store.mangas.require(req.params.id));

  /** A reading-direction change mirrors every page: one `page updated` per page (the page detail includes its frames). */
  app.patch<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => {
    const { manga, mirroredPageIds } = updateManga(store, req.params.id, UpdateMangaSchema.parse(req.body ?? {}));
    for (const pageId of mirroredPageIds) emitEntity(bus, 'page', pageId, 'updated', manga.id);
    emitEntity(bus, 'manga', manga.id, 'updated', manga.id);
    return manga;
  });

  /** The chapter delete hooks run first for every chapter of the manga (M4 final I1). */
  app.delete<IdParams>('/api/mangas/:id', async (req) => {
    store.mangas.require(req.params.id);
    const after = beforeChapterDelete(deps, store.chapters.listByManga(req.params.id).map((c) => c.id));
    const manga = deleteManga(store, req.params.id);
    after();
    emitEntity(bus, 'manga', manga.id, 'deleted', manga.id);
    return OK;
  });

  app.post<IdParams>('/api/mangas/:id/cover', async (req): Promise<PageDetail> => {
    const before = store.mangas.require(req.params.id).coverPageId;
    const detail = createCoverPage(store, req.params.id, null);
    if (detail.page.id !== before) {
      emitEntity(bus, 'page', detail.page.id, 'created', detail.page.mangaId);
      emitEntity(bus, 'manga', detail.page.mangaId, 'updated', detail.page.mangaId);
    }
    return detail;
  });
}
