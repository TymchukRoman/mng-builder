import { useEffect, useRef, type JSX } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PageDetail } from '@manga/shared';
import { api, seg } from '../api';
import { ChapterEditor } from '../editor/ChapterEditor';
import { isId } from '../lib/ids';
import { useManga } from '../queries';
import { qk } from '../queryKeys';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';

interface CoverTarget { key: string; mangaId: string; chapterId: string | null }

/**
 * /m/:mangaId/cover and /m/:mangaId/c/:chapterId/cover. The cover endpoints create the page if it is absent (idempotent).
 * F12: the POST is a mutation fired once per cover from an effect, so a reconnect or a cache invalidation never re-sends it.
 * I1: the params are checked first. A crafted link renders "not found" and sends nothing.
 */
export function CoverPage(): JSX.Element {
  const { mangaId = '', chapterId } = useParams();
  const qc = useQueryClient();
  const valid = isId(mangaId, 'mg') && (chapterId === undefined || isId(chapterId, 'ch'));
  const manga = useManga(valid ? mangaId : undefined);
  const key = `${mangaId}/${chapterId ?? ''}`;
  const open = useMutation({
    mutationFn: (t: CoverTarget) => api.post<PageDetail>(t.chapterId ? `/api/chapters/${seg(t.chapterId)}/cover` : `/api/mangas/${seg(t.mangaId)}/cover`),
    onSuccess: (detail, t) => {
      qc.setQueryData(qk.page(detail.page.id), detail);
      void qc.invalidateQueries({ queryKey: t.chapterId ? qk.chapter(t.chapterId) : qk.manga(t.mangaId) });
    },
  });
  const { mutate } = open;
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!valid || fired.current === key) return; // StrictMode re-runs effects; the ref survives, so the POST goes out once
    fired.current = key;
    mutate({ key, mangaId, chapterId: chapterId ?? null });
  }, [valid, key, mangaId, chapterId, mutate]);

  if (!valid) return <section className="screen"><ErrorState text="Not found" backTo="/" backLabel="All manga" /></section>;

  // A previous cover's result is ignored until this one's arrives (the component survives a route change).
  const pageId = open.data && open.variables?.key === key ? open.data.page.id : null;
  if (!manga.data || pageId === null) {
    const err = manga.error ?? open.error;
    return (
      <section className="screen">
        {err ? (
          <ErrorState error={err} backTo={`/m/${mangaId}`} backLabel="Back to the manga"
            onRetry={() => { if (manga.error) void manga.refetch(); if (open.error) mutate({ key, mangaId, chapterId: chapterId ?? null }); }} />
        ) : <StatusLoader label="Opening cover" />}
      </section>
    );
  }
  return (
    <ChapterEditor key={pageId} manga={manga.data} mode="cover" chapterId={null} pageIds={[pageId]}
      title={chapterId ? 'Chapter cover' : 'Cover'} backTo={`/m/${mangaId}`} />
  );
}
