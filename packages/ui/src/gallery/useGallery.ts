import { useInfiniteQuery } from '@tanstack/react-query';
import type { GalleryPageResult } from '@manga/shared';
import { api } from '../api';
import { galleryKey, galleryQueryString, type GalleryFilters } from './galleryModel';

/** Pages of GET /api/gallery for these filters, newest first. The key starts with `gallery` (see queryKeys: image events invalidate it). */
export function useGallery(filters: GalleryFilters) {
  return useInfiniteQuery({
    queryKey: galleryKey(filters),
    queryFn: ({ pageParam }) => api.get<GalleryPageResult>(`/api/gallery${galleryQueryString(filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}
