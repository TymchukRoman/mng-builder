import type { Page } from '@manga/shared';
import type { Store } from '../store/index.js';
import { chapterPages, renumberPages } from './order.js';

/** Removes image files after the transaction that deleted their rows has committed. Missing files are ignored. */
export function removeFiles(store: Store, rels: readonly string[]): void {
  for (const rel of rels) store.files.remove(rel);
}

/** Deletes a panel and its image rows (frames anchored to it are un-anchored by the FK). Returns files to remove after commit. */
export function deletePanelRows(store: Store, panelId: string): string[] {
  const images = store.images.listByOwner('panel', panelId);
  for (const image of images) store.images.delete(image.id);
  store.panels.delete(panelId);
  return images.map((image) => image.path);
}

export function deletePage(store: Store, pageId: string): Page {
  const page = store.pages.require(pageId);
  const files: string[] = [];
  store.tx(() => {
    for (const panel of store.panels.listByPage(pageId)) files.push(...deletePanelRows(store, panel.id));
    store.pages.delete(pageId);
    if (page.kind === 'page' && page.chapterId !== null) renumberPages(store, chapterPages(store, page.chapterId));
  });
  removeFiles(store, files);
  return page;
}
