import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';
import type { UpdateMangaBody } from '../types';

/**
 * PATCH /api/mangas/:id. A reading-direction change mirrors every page on the server, which emits one
 * `page updated` event per page, so page and thumbnail queries refresh through the socket, not here.
 */
export function usePatchManga(mangaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMangaBody) => api.patch<Manga>(`/api/mangas/${mangaId}`, body),
    onSuccess: (m) => { qc.setQueryData(qk.manga(m.id), m); void qc.invalidateQueries({ queryKey: qk.mangas() }); },
  });
}
