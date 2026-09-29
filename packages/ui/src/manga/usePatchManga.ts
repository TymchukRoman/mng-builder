import type { Manga } from '@manga/shared';
import { api, seg } from '../api';
import { useOptimisticPatch } from '../lib/optimisticPatch';
import { qk } from '../queryKeys';
import type { UpdateMangaBody } from '../types';
import { applyMangaPatch } from './mangaModel';

/**
 * PATCH /api/mangas/:id through the shared optimistic pattern (lib/optimisticPatch). The cache takes the patch at once,
 * so a second edit of the same nested object (styleGuide, pageFormat), built from the cache, includes the first one;
 * the refetch waits for the last save. A reading-direction change mirrors every page on the server, which emits one
 * `page updated` event per page, so page and thumbnail queries refresh through the socket, not here.
 */
export function usePatchManga(mangaId: string) {
  return useOptimisticPatch<Manga, UpdateMangaBody, Manga>({
    queryKey: qk.manga(mangaId),
    mutationKey: ['manga', mangaId, 'patch'],
    send: (body) => api.patch<Manga>(`/api/mangas/${seg(mangaId)}`, body),
    apply: applyMangaPatch,
    alsoInvalidate: [qk.mangas()],
  });
}
