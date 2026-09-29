import { useState, type DragEvent, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Manga, Page, PageDetail } from '@manga/shared';
import { api } from '../api';
import { cx } from '../lib/cx';
import { PageThumb } from '../page/PageThumb';
import { qk } from '../queryKeys';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { FilePlus2 } from '../ui/icons';
import { insertBody } from './editorModel';
import { dropIndex, isNoopMove, moveId } from './reorder';

const THUMB_W = 96;

/** The drop position for a pointer over the list: measured from the items themselves, so gaps and the space below count. */
function overIndex(e: DragEvent<HTMLElement>): number {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-page-id]')].map((el) => el.getBoundingClientRect());
  return dropIndex(rows, e.clientY);
}

/**
 * Page thumbnails (spec §9.1). Add and reorder are not undoable and never invalidate recorded commands, so they run
 * here; delete goes to the editor (`onDelete`), which runs it as a history barrier. Refusals are toasted by the mutation cache.
 */
export function PageList({ chapterId, manga, pageIds, currentId, onSelectPage, onDelete }: {
  chapterId: string; manga: Manga; pageIds: string[]; currentId: string | null; onSelectPage(id: string | null): void; onDelete(pageId: string): void;
}): JSX.Element {
  const qc = useQueryClient();
  // `over` stays null until the pointer moves over a new position, so the dragged item shows no indicator at start.
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null);

  const add = useMutation({
    mutationFn: () => api.post<PageDetail>(`/api/chapters/${chapterId}/pages`, insertBody(pageIds, currentId)),
    onSuccess: async (d) => {
      qc.setQueryData(qk.page(d.page.id), d);
      await qc.invalidateQueries({ queryKey: qk.pages(chapterId) });
      onSelectPage(d.page.id);
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

  const shown = drag && drag.over !== null && !isNoopMove(pageIds, drag.id, drag.over) ? drag.over : null;

  return (
    <nav className="page-list" aria-label="Pages">
      <ol
        className="page-list__items"
        onDragOver={(e) => {
          if (!drag) return; // not one of our thumbnails (a file, or text from elsewhere)
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const over = overIndex(e);
          setDrag((d) => (d && d.over !== over ? { ...d, over } : d));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag((d) => (d ? { ...d, over: null } : d));
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          const next = moveId(pageIds, drag.id, overIndex(e));
          setDrag(null);
          if (next.join() !== pageIds.join()) reorder.mutate(next);
        }}
      >
        {pageIds.map((id, i) => (
          <li
            key={id}
            data-page-id={id}
            draggable
            className={cx('page-list__item', id === currentId && 'is-current', drag?.id === id && 'is-dragging',
              shown === i && 'is-drop-before', shown === pageIds.length && i === pageIds.length - 1 && 'is-drop-after')}
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id, over: null }); }}
            onDragEnd={() => setDrag(null)}
          >
            <button type="button" className="page-list__thumb" aria-label={`Page ${i + 1}`} data-tip={`Page ${i + 1}`} data-tip-side="right"
              aria-current={id === currentId ? 'page' : undefined} onClick={() => onSelectPage(id)}>
              <PageThumb pageId={id} manga={manga} widthPx={THUMB_W} />
            </button>
            <div className="page-list__foot">
              <span className="page-list__num">{i + 1}</span>
              <ConfirmIconButton size="sm" label="Delete page" confirmLabel="Click again to delete this page" onConfirm={() => onDelete(id)} />
            </div>
          </li>
        ))}
      </ol>
      <IconButton icon={FilePlus2} label="Add page" tipSide="right" className="page-list__add" busy={add.isPending} onClick={() => add.mutate()} />
    </nav>
  );
}
