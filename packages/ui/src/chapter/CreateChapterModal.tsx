import { useRef, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Chapter, Manga } from '@manga/shared';
import { api } from '../api';
import { qk } from '../queryKeys';
import type { CreateChapterBody } from '../types';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Check } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { CreateChapterAiSection } from './CreateChapterAiSection';

export function CreateChapterModal({ manga, open, onClose, onCreated }: { manga: Manga; open: boolean; onClose(): void; onCreated(chapter: Chapter): void }): JSX.Element {
  const [title, setTitle] = useState('');
  const startEpisode = useRef<((chapterId: string) => Promise<void>) | null>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: CreateChapterBody) => {
      const chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, body);
      if (startEpisode.current) await startEpisode.current(chapter.id);
      return chapter;
    },
    // Settled, not success: when starting the episode fails the chapter still exists and the list must show it.
    onSettled: () => { void qc.invalidateQueries({ queryKey: qk.chapters(manga.id) }); },
    onSuccess: (chapter) => {
      setTitle('');
      onClose();
      onCreated(chapter);
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="New chapter">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); const t = title.trim(); if (t) create.mutate({ title: t }); }}>
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
        <CreateChapterAiSection mangaId={manga.id} onChange={(start) => { startEpisode.current = start; }} />
        <div className="form-actions">
          <IconButton type="submit" icon={Check} tone="primary" label="Create chapter" busy={create.isPending} disabled={!title.trim()} />
        </div>
      </form>
    </Modal>
  );
}
