import type { JSX } from 'react';
import type { Manga } from '@manga/shared';
import { usePageDetail } from '../queries';
import { PagePlaceholder } from './PagePlaceholder';
import { PageView } from './PageView';

export function PageThumb({ pageId, manga, widthPx }: { pageId: string; manga: Manga; widthPx: number }): JSX.Element {
  const detail = usePageDetail(pageId);
  if (!detail.data) return <PagePlaceholder manga={manga} widthPx={widthPx} />;
  return <div className="page-thumb"><PageView detail={detail.data} manga={manga} widthPx={widthPx} mode="thumb" /></div>;
}
