import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga, Page, PageDetail } from '@manga/shared';
import { api } from '../api';
import { cx } from '../lib/cx';
import { PageThumb } from '../page/PageThumb';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { FilePlus2 } from '../ui/icons';
import { insertBody, neighbourAfterDelete } from './editorModel';
import { dropIndex, moveId } from './reorder';

const THUMB_W = 96;

/** Page thumbnails (spec §9.1). Page operations are not undoable (spec §9.3); refused calls are toasted by the mutation cache. */
export function PageList({ chapterId, manga, pageIds, currentId, onSelectPage }: {
  chapterId: string; manga: Manga; pageIds: string[]; currentId: string | null; onSelectPage(id: string | null): void;
}): JSX.Element {
  const qc = useQueryClient();
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);

  const add = useMutation({
    mutationFn: () => api.post<PageDetail>(`/api/chapters/${chapterId}/pages`, insertBody(pageIds, currentId)),
    onSuccess: async (d) => {
      qc.setQueryData(qk.page(d.page.id), d);
      await qc.invalidateQueries({ queryKey: qk.pages(chapterId) });
      onSelectPage(d.page.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/pages/${id}`),
    onSuccess: (_res, id) => {
      if (id === currentId) onSelectPage(neighbourAfterDelete(pageIds, id));
      qc.setQueryData<Page[]>(qk.pages(chapterId), (prev) => prev?.filter((p) => p.id !== id));
      qc.removeQueries({ queryKey: qk.page(id), exact: true });
      void qc.invalidateQueries({ queryKey: qk.pages(chapterId) });
    },
  });
  // Optimistic: the list shows the new order at once and rolls back when the server refuses it.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post<Page[]>(`/api/chapters/${chapterId}/pages/reorder`, { ids }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.pages(chapterId), exact: true });
      const prev = qc.getQueryData<Page[]>(qk.pages(chapterId));
      if (prev) qc.setQueryData(qk.pages(chapterId), ids.map((id) => prev.find((p) => p.id === id)).filter((p): p is Page => p !== undefined));
      return { prev };
    },
    onError: (_err, _ids, ctx) => { if (ctx?.prev) qc.setQueryData(qk.pages(chapterId), ctx.prev); },
    onSuccess: (pages) => { qc.setQueryData(qk.pages(chapterId), pages); },
  });

  const drop = (dragged: string, to: number): void => {
    setDrag(null);
    const next = moveId(pageIds, dragged, to);
    if (next.join() !== pageIds.join()) reorder.mutate(next);
  };

  return (
    <nav className="page-list" aria-label="Pages">
      <ol className="page-list__items">
        {pageIds.map((id, i) => (
          <li
            key={id}
            data-page-id={id}
            draggable
            className={cx('page-list__item', id === currentId && 'is-current', drag?.over === i && 'is-drop-before', drag?.over === i + 1 && 'is-drop-after')}
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id, over: i }); }}
            onDragOver={(e) => {
              if (!drag) return; // not one of our thumbnails (a file, or text from elsewhere)
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              const over = dropIndex(r.top, r.height, e.clientY, i);
              setDrag((d) => (d && d.over !== over ? { ...d, over } : d));
            }}
            onDrop={(e) => {
              if (!drag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              drop(drag.id, dropIndex(r.top, r.height, e.clientY, i));
            }}
            onDragEnd={() => setDrag(null)}
          >
            <button type="button" className="page-list__thumb" aria-label={`Page ${i + 1}`} data-tip={`Page ${i + 1}`} data-tip-side="right"
              aria-current={id === currentId ? 'page' : undefined} onClick={() => onSelectPage(id)}>
              <PageThumb pageId={id} manga={manga} widthPx={THUMB_W} />
            </button>
            <div className="page-list__foot">
              <span className="page-list__num">{i + 1}</span>
              <ConfirmIconButton size="sm" label="Delete page" confirmLabel="Click again to delete this page" onConfirm={() => remove.mutate(id)} />
            </div>
          </li>
        ))}
      </ol>
      <IconButton icon={FilePlus2} label="Add page" tipSide="right" className="page-list__add" busy={add.isPending} onClick={() => add.mutate()} />
    </nav>
  );
}
