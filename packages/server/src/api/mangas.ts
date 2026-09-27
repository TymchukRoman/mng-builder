import type { FastifyInstance } from 'fastify';
import { CreateMangaSchema, UpdateMangaSchema, type Manga, type PageDetail } from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { createCoverPage, createManga, deleteManga, updateManga } from '../domain/index.js';
import { emitEntity, OK, type IdParams } from './util.js';

export function registerMangaRoutes(app: FastifyInstance, { store, bus }: CoreDeps): void {
  app.get('/api/mangas', async (): Promise<Manga[]> => store.mangas.list());

  app.post('/api/mangas', async (req): Promise<Manga> => {
    const manga = createManga(store, CreateMangaSchema.parse(req.body ?? {}));
    emitEntity(bus, 'manga', manga.id, 'created', manga.id);
    return manga;
  });

  app.get<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => store.mangas.require(req.params.id));

  app.patch<IdParams>('/api/mangas/:id', async (req): Promise<Manga> => {
    const manga = updateManga(store, req.params.id, UpdateMangaSchema.parse(req.body ?? {}));
    emitEntity(bus, 'manga', manga.id, 'updated', manga.id);
    return manga;
  });

  app.delete<IdParams>('/api/mangas/:id', async (req) => {
    const manga = deleteManga(store, req.params.id);
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
