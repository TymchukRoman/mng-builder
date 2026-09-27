import type { z } from 'zod';
import type { Chapter, CreateChapterSchema, Page } from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { chapterPages } from './order.js';

export type CreateChapterInput = z.infer<typeof CreateChapterSchema>;

/** number = max + 1 (numbers are never reused), order = after the last chapter. */
export function createChapter(store: Store, mangaId: string, input: CreateChapterInput): Chapter {
  store.mangas.require(mangaId);
  const existing = store.chapters.listByManga(mangaId);
  const number = existing.reduce((max, c) => Math.max(max, c.number), 0) + 1;
  const order = existing.reduce((max, c) => Math.max(max, c.order + 1), 0);
  return store.chapters.create({ mangaId, number, title: input.title, synopsis: input.synopsis, coverPageId: null, status: 'draft', order });
}

/** `ids` must list every story page of the chapter exactly once. */
export function reorderPages(store: Store, chapterId: string, ids: readonly string[]): Page[] {
  store.chapters.require(chapterId);
  const pages = chapterPages(store, chapterId);
  const known = new Set(pages.map((p) => p.id));
  const complete = ids.length === pages.length && new Set(ids).size === ids.length && ids.every((id) => known.has(id));
  if (!complete) throw new ValidationError('ids must list every page of the chapter exactly once', { expected: pages.map((p) => p.id) });
  store.tx(() => {
    ids.forEach((id, order) => store.pages.update(id, { order }));
  });
  return chapterPages(store, chapterId);
}
