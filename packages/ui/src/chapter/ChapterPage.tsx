import type { JSX } from 'react';
import { useParams } from 'react-router';
import { ChapterEditor } from '../editor/ChapterEditor';
import { useChapter, useManga, usePages } from '../queries';
import { StatusLoader } from '../ui/StatusLoader';
import { errorText } from '../ui/toasts';
import { EpisodePanel } from './EpisodePanel';

/** /m/:mangaId/c/:chapterId — the chapter editor, with the M4 episode stepper slot above it. */
export function ChapterPage(): JSX.Element {
  const { mangaId = '', chapterId = '' } = useParams();
  const manga = useManga(mangaId);
  const chapter = useChapter(chapterId);
  const pages = usePages(chapterId);
  if (!manga.data || !chapter.data || !pages.data) {
    const err = manga.error ?? chapter.error ?? pages.error;
    return <section className="screen">{err ? <p className="error-text">{errorText(err)}</p> : <StatusLoader label="Loading chapter" />}</section>;
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
