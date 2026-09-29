import type { JSX } from 'react';
import { Link } from 'react-router';
import type { Manga } from '@manga/shared';
import { PagePlaceholder } from '../page/PagePlaceholder';
import { PageThumb } from '../page/PageThumb';
import { COVER_W } from './mangaList';

export function MangaCard({ manga }: { manga: Manga }): JSX.Element {
  return (
    <Link to={`/m/${manga.id}`} className="cover-card" data-manga-id={manga.id}>
      <span className="cover-card__art">
        {manga.coverPageId
          ? <PageThumb pageId={manga.coverPageId} manga={manga} widthPx={COVER_W} />
          : <PagePlaceholder manga={manga} widthPx={COVER_W} />}
      </span>
      <span className="cover-card__title">{manga.title}</span>
    </Link>
  );
}
