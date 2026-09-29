import type { JSX } from 'react';
import { useParams } from 'react-router';
import { ChapterEditor } from '../editor/ChapterEditor';
import { isId } from '../lib/ids';
import { useChapter, useManga, usePages } from '../queries';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import { EpisodePanel } from './EpisodePanel';

/** /m/:mangaId/c/:chapterId — the chapter editor, with the M4 episode stepper slot above it. */
export function ChapterPage(): JSX.Element {
  const { mangaId = '', chapterId = '' } = useParams();
  const valid = isId(mangaId, 'mg') && isId(chapterId, 'ch'); // I1: a crafted id never reaches a request
  const manga = useManga(valid ? mangaId : undefined);
  const chapter = useChapter(valid ? chapterId : undefined);
  const pages = usePages(valid ? chapterId : undefined);
  if (!valid) return <section className="screen"><ErrorState text="Not found" backTo="/" backLabel="All manga" /></section>;
  if (!manga.data || !chapter.data || !pages.data) {
    const err = manga.error ?? chapter.error ?? pages.error;
    const retry = (): void => { for (const q of [manga, chapter, pages]) if (q.isError) void q.refetch(); };
    return (
      <section className="screen">
        {err ? <ErrorState error={err} onRetry={retry} backTo={`/m/${mangaId}`} backLabel="Back to the manga" /> : <StatusLoader label="Loading chapter" />}
      </section>
    );
  }
  return (
    <ChapterEditor
      key={chapterId}
      manga={manga.data}
      mode="chapter"
      chapterId={chapterId}
      pageIds={pages.data.map((p) => p.id)}
      title={`${chapter.data.number}. ${chapter.data.title}`}
      backTo={`/m/${mangaId}`}
      aside={<EpisodePanel chapterId={chapterId} />}
    />
  );
}
