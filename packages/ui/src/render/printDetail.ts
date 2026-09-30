import { useQuery } from '@tanstack/react-query';
import type { PageDetail } from '@manga/shared';
import { api, seg } from '../api';
import { qk } from '../queryKeys';

/** Contract change C-1: the exporter opens /render/page/:id?hires=1, which reads the print view with upscaled images. */
export function printDetailPath(pageId: string, hires: boolean): string {
  return hires ? `/api/pages/${seg(pageId)}/print` : `/api/pages/${seg(pageId)}`;
}

export function printDetailKey(pageId: string, hires: boolean): readonly unknown[] {
  return hires ? [...qk.page(pageId), 'print'] : qk.page(pageId);
}

/** The path is built inside queryFn, which only runs when enabled, so an undefined id never reaches seg() at render time. */
export const usePrintDetail = (pageId: string | undefined, hires: boolean) =>
  useQuery({
    queryKey: printDetailKey(pageId ?? '', hires),
    queryFn: () => api.get<PageDetail>(printDetailPath(pageId ?? '', hires)),
    enabled: !!pageId,
  });
