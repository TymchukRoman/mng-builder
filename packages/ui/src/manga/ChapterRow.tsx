import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Chapter, Manga } from '@manga/shared';
import { api } from '../api';
import { PagePlaceholder } from '../page/PagePlaceholder';
import { PageThumb } from '../page/PageThumb';
import { usePages } from '../queries';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { ImageIcon } from '../ui/icons';

const THUMB_W = 40;

export function ChapterRow({ manga, chapter }: { manga: Manga; chapter: Chapter }): JSX.Element {
  const pages = usePages(chapter.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/chapters/${chapter.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.chapters(manga.id) }); },
  });
  const count = pages.data?.length;
  return (
    <li className="chapter-row" data-chapter-id={chapter.id}>
      <Link to={`/m/${manga.id}/c/${chapter.id}`} className="chapter-row__link">
        <span className="chapter-row__thumb">
          {chapter.coverPageId ? <PageThumb pageId={chapter.coverPageId} manga={manga} widthPx={THUMB_W} /> : <PagePlaceholder manga={manga} widthPx={THUMB_W} />}
        </span>
        <span className="chapter-row__num">{chapter.number}</span>
        <span className="chapter-row__title">{chapter.title}</span>
        <span className="chapter-row__pages" data-tip={count === undefined ? 'Pages' : `${count} pages`}>{count ?? '–'}</span>
        <span className={`status-chip status-chip--${chapter.status}`}>{chapter.status}</span>
      </Link>
      <IconButton icon={ImageIcon} label="Edit chapter cover" onClick={() => navigate(`/m/${manga.id}/c/${chapter.id}/cover`)} />
      <ConfirmIconButton label="Delete chapter" confirmLabel="Click again to delete this chapter" onConfirm={() => remove.mutate()} />
    </li>
  );
}
