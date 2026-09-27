import type { Page } from '@manga/shared';
import type { Store } from '../store/index.js';

/** The chapter's story pages (not its cover), in order. */
export function chapterPages(store: Store, chapterId: string): Page[] {
  return store.pages.listByChapter(chapterId).filter((page) => page.kind === 'page');
}

/** Rewrites `order` to 0..n-1 following the given sequence. */
export function renumberPages(store: Store, pages: readonly Page[]): void {
  pages.forEach((page, index) => {
    if (page.order !== index) store.pages.update(page.id, { order: index });
  });
}
