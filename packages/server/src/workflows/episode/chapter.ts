// packages/server/src/workflows/episode/chapter.ts
import { panelIds, readingOrder, type Page, type Panel, type ReadingDirection } from '@manga/shared';
import { chapterPages } from '../../domain/order.js';
import type { Store } from '../../store/index.js';

export interface ChapterPanel { page: Page; panel: Panel; pageNumber: number; isCover: boolean }

/** The chapter's story pages (not the cover), by `order`. */
export function storyPages(store: Store, chapterId: string): Page[] {
  return [...chapterPages(store, chapterId)].sort((a, b) => a.order - b.order);
}

/** Story panels page by page in reading order, then the chapter cover's panel (pageNumber 0). */
export function chapterPanels(store: Store, chapterId: string, dir: ReadingDirection): ChapterPanel[] {
  const out: ChapterPanel[] = [];
  storyPages(store, chapterId).forEach((page, i) => {
    for (const id of readingOrder(page.layout, dir)) {
      const panel = store.panels.get(id);
      if (panel) out.push({ page, panel, pageNumber: i + 1, isCover: false });
    }
  });
  const { coverPageId } = store.chapters.require(chapterId);
  const cover = coverPageId === null ? null : store.pages.get(coverPageId);
  if (cover) {
    for (const id of panelIds(cover.layout)) {
      const panel = store.panels.get(id);
      if (panel) out.push({ page: cover, panel, pageNumber: 0, isCover: true });
    }
  }
  return out;
}
