import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import type { Manga } from '@manga/shared';
import { CreateChapterModal } from '../chapter/CreateChapterModal';
import { useChapters } from '../queries';
import { Plus } from '../ui/icons';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { ChapterRow } from './ChapterRow';
import { sortChapters } from './mangaModel';

export function ChaptersTab({ manga }: { manga: Manga }): JSX.Element {
  const chapters = useChapters(manga.id);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  return (
    <div className="tab-body">
      {chapters.isPending && <StatusLoader label="Loading chapters" />}
      {chapters.error && <ErrorState error={chapters.error} onRetry={() => void chapters.refetch()} retrying={chapters.isFetching} />}
      {!chapters.isPending && (
        <ul className="chapter-list">
          {sortChapters(chapters.data ?? []).map((c) => <ChapterRow key={c.id} manga={manga} chapter={c} />)}
          <li>
            <button type="button" className="chapter-row chapter-row--new" aria-label="New chapter" data-tip="New chapter" onClick={() => setCreating(true)}>
              <Plus size={18} aria-hidden />
            </button>
          </li>
        </ul>
      )}
      <CreateChapterModal manga={manga} open={creating} onClose={() => setCreating(false)} onCreated={(c) => navigate(`/m/${manga.id}/c/${c.id}`)} />
    </div>
  );
}
