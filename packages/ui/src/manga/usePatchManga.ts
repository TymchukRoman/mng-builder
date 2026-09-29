import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';
import type { UpdateMangaBody } from '../types';
import { applyMangaPatch } from './mangaModel';

/**
 * PATCH /api/mangas/:id, applied optimistically. The cache takes the patch at once, so a second edit of the same
 * nested object (styleGuide, pageFormat), built from the cache, includes the first one; the server settles the
 * truth on refetch. A reading-direction change mirrors every page on the server, which emits one `page updated`
 * event per page, so page and thumbnail queries refresh through the socket, not here.
 */
export function usePatchManga(mangaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMangaBody) => api.patch<Manga>(`/api/mangas/${mangaId}`, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.manga(mangaId) });
      const previous = qc.getQueryData<Manga>(qk.manga(mangaId));
      if (previous) qc.setQueryData(qk.manga(mangaId), applyMangaPatch(previous, body));
      return { previous };
    },
    onError: (_err, _body, ctx) => { if (ctx?.previous) qc.setQueryData(qk.manga(mangaId), ctx.previous); },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.manga(mangaId) });
      void qc.invalidateQueries({ queryKey: qk.mangas() });
    },
  });
}
