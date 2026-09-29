import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga } from '@manga/shared';
import { api } from '../api';
import { PagePlaceholder } from '../page/PagePlaceholder';
import { PageThumb } from '../page/PageThumb';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { SlidersHorizontal } from '../ui/icons';
import { InlineEdit } from '../ui/InlineEdit';
import { mangaBadges } from './mangaModel';
import { usePatchManga } from './usePatchManga';

const COVER_W = 120;

export function MangaHeader({ manga, onOpenSettings }: { manga: Manga; onOpenSettings(): void }): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const patch = usePatchManga(manga.id);
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/mangas/${manga.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.mangas() }); navigate('/'); },
  });
  return (
    <header className="manga-head">
      <button type="button" className="manga-head__cover" aria-label="Edit cover" data-tip="Edit cover" onClick={() => navigate(`/m/${manga.id}/cover`)}>
        {manga.coverPageId ? <PageThumb pageId={manga.coverPageId} manga={manga} widthPx={COVER_W} /> : <PagePlaceholder manga={manga} widthPx={COVER_W} />}
      </button>
      <div className="manga-head__text">
        <h1><InlineEdit value={manga.title} label="title" required onCommit={(title) => patch.mutate({ title })} /></h1>
        <InlineEdit value={manga.synopsis} label="synopsis" multiline placeholder="Synopsis" onCommit={(synopsis) => patch.mutate({ synopsis })} />
        <div className="manga-head__badges">
          {mangaBadges(manga).map((b) => <span key={b.text} className="status-chip" data-tip={b.tip}>{b.text}</span>)}
        </div>
      </div>
      <div className="manga-head__actions">
        <IconButton icon={SlidersHorizontal} label="Manga settings" onClick={onOpenSettings} />
        <ConfirmIconButton label="Delete manga" confirmLabel="Click again to delete this manga and everything in it" onConfirm={() => remove.mutate()} />
      </div>
    </header>
  );
}
