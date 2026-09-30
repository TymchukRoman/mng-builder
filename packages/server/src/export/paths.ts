import { join, resolve } from 'node:path';
import { printSizePx, type Chapter, type ExportRenderPayload, type Manga, type Page, type PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import { storyPages } from '../workflows/episode/chapter.js';
import { slugify } from './slug.js';

/** The print size of a page format in pixels (2150 x 3035 for B5 at 300 dpi). One implementation, shared with the UI print route. */
export function printPx(format: PageFormat): { width: number; height: number } {
  const { w, h } = printSizePx(format);
  return { width: w, height: h };
}

export function chapterSlug(chapter: Chapter): string {
  return `${String(chapter.number).padStart(2, '0')}-${slugify(chapter.title, 'chapter')}`;
}

/** `outDir` (when non-blank) replaces the whole directory; otherwise <exportsRoot>/<manga>/<chapter>. Titles are slugged, so they cannot escape the root. */
export function exportDir(exportsRoot: string, manga: Manga, chapter: Chapter | null, outDir?: string): string {
  if (typeof outDir === 'string' && outDir.trim() !== '') return resolve(outDir.trim());
  return join(exportsRoot, slugify(manga.title, `manga-${manga.id}`), chapter ? chapterSlug(chapter) : 'cover');
}

export function pageFileName(page: Page, storyIndex: number, ext: 'png' | 'pdf'): string {
  return page.kind === 'cover' ? `cover.${ext}` : `page-${String(storyIndex + 1).padStart(2, '0')}.${ext}`;
}

export interface ExportItem { pageId: string; file: string }
export interface ExportPlan { dir: string; items: ExportItem[]; chapterPdf: string | null; format: 'png' | 'pdf'; pageFormat: PageFormat }

/** Which pages go to which files. A chapter export is its cover (if any) followed by its story pages. */
export function planExport(store: Store, payload: ExportRenderPayload): ExportPlan {
  const ext = payload.format;
  if (payload.target.type === 'page') {
    const page = store.pages.require(payload.target.id);
    const manga = store.mangas.require(page.mangaId);
    const chapter = page.chapterId !== null ? store.chapters.require(page.chapterId) : null;
    const index = chapter ? storyPages(store, chapter.id).findIndex((p) => p.id === page.id) : 0;
    const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir);
    return { dir, items: [{ pageId: page.id, file: join(dir, pageFileName(page, Math.max(0, index), ext)) }], chapterPdf: null, format: ext, pageFormat: manga.pageFormat };
  }
  const chapter = store.chapters.require(payload.target.id);
  const manga = store.mangas.require(chapter.mangaId);
  const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir);
  const cover = chapter.coverPageId !== null ? store.pages.get(chapter.coverPageId) : null;
  const story = storyPages(store, chapter.id);
  if (!cover && story.length === 0) throw new PermanentError(`chapter ${chapter.id} has no pages to export`);
  const items: ExportItem[] = [
    ...(cover ? [{ pageId: cover.id, file: join(dir, pageFileName(cover, 0, ext)) }] : []),
    ...story.map((p, i) => ({ pageId: p.id, file: join(dir, pageFileName(p, i, ext)) })),
  ];
  return { dir, items, chapterPdf: ext === 'pdf' ? join(dir, 'chapter.pdf') : null, format: ext, pageFormat: manga.pageFormat };
}
