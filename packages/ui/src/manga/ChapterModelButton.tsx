import { useState, type JSX } from 'react';
import type { Chapter } from '@manga/shared';
import { api, seg } from '../api';
import { useOptimisticPatch } from '../lib/optimisticPatch';
import { qk } from '../queryKeys';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Check, Zap } from '../ui/icons';
import { ImageModelSelect } from '../ui/ImageModelSelect';
import { Modal } from '../ui/Modal';
import { errorText, pushToast } from '../ui/toasts';
import { applyChapterPatch } from './mangaModel';

/** The image model this chapter's panels are drawn with; empty means the manga's. */
export function ChapterModelButton({ chapter, mangaModel }: { chapter: Chapter; mangaModel: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const patch = useOptimisticPatch<Chapter[], { imageModel: string | null }, Chapter>({
    queryKey: qk.chapters(chapter.mangaId),
    mutationKey: ['chapters', chapter.mangaId, 'patch'],
    send: (body) => api.patch<Chapter>(`/api/chapters/${seg(chapter.id)}`, body),
    apply: (prev, body) => applyChapterPatch(prev, chapter.id, body),
    alsoInvalidate: [qk.chapter(chapter.id)],
  });
  return (
    <>
      <IconButton icon={Zap} label={chapter.imageModel ? `Image model: ${chapter.imageModel}` : 'Image model of this chapter'} active={chapter.imageModel !== null} onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title={`Chapter ${chapter.number}: image model`}>
        <Field label="Image model">
          <ImageModelSelect
            label="Image model" value={chapter.imageModel} inheritLabel={mangaModel ? `Same as the manga (${mangaModel})` : 'Same as the manga (Settings → Routing)'}
            onChange={(imageModel) => patch.mutate({ imageModel }, { onError: (err) => pushToast('error', errorText(err)) })}
          />
        </Field>
        <div className="form-actions"><IconButton icon={Check} tone="primary" label="Done" onClick={() => setOpen(false)} /></div>
      </Modal>
    </>
  );
}
