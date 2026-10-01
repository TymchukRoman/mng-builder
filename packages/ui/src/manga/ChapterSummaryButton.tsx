import { useState, type JSX } from 'react';
import type { Chapter } from '@manga/shared';
import { api, seg } from '../api';
import { useOptimisticPatch } from '../lib/optimisticPatch';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { Check, FileText, X } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { errorText, pushToast } from '../ui/toasts';
import { applyChapterPatch } from './mangaModel';

/** W1 Q1: the chapter's "what happened" (an episode run writes it; later chapters' premise and outline read it). */
export function ChapterSummaryButton({ chapter }: { chapter: Chapter }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(chapter.summary);
  const patch = useOptimisticPatch<Chapter[], { summary: string }, Chapter>({
    queryKey: qk.chapters(chapter.mangaId),
    mutationKey: ['chapters', chapter.mangaId, 'patch'],
    send: (body) => api.patch<Chapter>(`/api/chapters/${seg(chapter.id)}`, body),
    apply: (prev, body) => applyChapterPatch(prev, chapter.id, body),
    alsoInvalidate: [qk.chapter(chapter.id)],
  });
  const next = text.trim();
  return (
    <>
      <IconButton icon={FileText} label={chapter.summary ? 'Edit chapter summary' : 'Add chapter summary'} onClick={() => { setText(chapter.summary); setOpen(true); }} />
      <Modal open={open} onClose={() => setOpen(false)} title="Chapter summary">
        <textarea className="textarea" rows={5} aria-label="Chapter summary" data-autofocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="form-actions">
          <IconButton icon={X} label="Discard changes" onClick={() => setOpen(false)} />
          <IconButton icon={Check} tone="primary" label="Save summary" disabled={next === chapter.summary}
            onClick={() => { patch.mutate({ summary: next }, { onError: (err) => pushToast('error', errorText(err)) }); setOpen(false); }} />
        </div>
      </Modal>
    </>
  );
}
