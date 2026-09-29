import type { JSX } from 'react';
import type { Manga } from '@manga/shared';
import { pageSizePx } from './geometry';

/** A blank screentone page, at the manga's aspect ratio. */
export function PagePlaceholder({ manga, widthPx }: { manga: Manga; widthPx: number }): JSX.Element {
  const size = pageSizePx(manga.pageFormat, widthPx);
  return <div className="page-placeholder" style={{ width: size.w, height: size.h }} aria-hidden />;
}
