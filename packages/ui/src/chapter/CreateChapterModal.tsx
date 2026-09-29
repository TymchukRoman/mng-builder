import { useCallback, useRef, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Chapter, Manga } from '@manga/shared';
import { api, seg } from '../api';
import { qk } from '../queryKeys';
import type { CreateChapterBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Check } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { pushToast } from '../ui/toasts';
import { CreateChapterAiSection } from './CreateChapterAiSection';
import { createChapterFlow, startFailureMessage } from './createChapterFlow';

type StartEpisode = ((chapterId: string) => Promise<void>) | null;

export function CreateChapterModal({ manga, open, onClose, onCreated }: { manga: Manga; open: boolean; onClose(): void; onCreated(chapter: Chapter): void }): JSX.Element {
  const [title, setTitle] = useState('');
  const startEpisode = useRef<StartEpisode>(null);
  const qc = useQueryClient();
  const registerStart = useCallback((start: StartEpisode) => { startEpisode.current = start; }, []);
  const reset = (): void => { setTitle(''); startEpisode.current = null; };
  const close = (): void => { reset(); onClose(); };
  const create = useMutation({
    mutationFn: (body: CreateChapterBody) => createChapterFlow({
      post: () => api.post<Chapter>(`/api/mangas/${seg(manga.id)}/chapters`, body),
      start: startEpisode.current,
      onStartError: (err) => pushToast('error', startFailureMessage(err)),
    }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: qk.chapters(manga.id) }); },
    onSuccess: (chapter) => {
      close();
      onCreated(chapter);
    },
  });
  return (
    <Modal open={open} onClose={close} title="New chapter">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); const t = title.trim(); if (t) create.mutate({ title: t }); }}>
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></Field>
        <CreateChapterAiSection mangaId={manga.id} onChange={registerStart} />
        <div className="form-actions">
          <IconButton type="submit" icon={Check} tone="primary" label="Create chapter" busy={create.isPending} disabled={!title.trim()} />
        </div>
      </form>
    </Modal>
  );
}
