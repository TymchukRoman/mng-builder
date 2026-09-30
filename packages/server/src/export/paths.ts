import { join, resolve } from 'node:path';
import type { Chapter, ExportRenderPayload, Manga, Page, PageFormat } from '@manga/shared';
import { PermanentError } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import { storyPages } from '../workflows/episode/chapter.js';
import { slugify } from './slug.js';

export function chapterSlug(chapter: Chapter): string {
  return `${String(chapter.number).padStart(2, '0')}-${slugify(chapter.title, 'chapter')}`;
}

function baseMangaSlug(manga: Manga): string {
  return slugify(manga.title, `manga-${manga.id}`);
}

/** The manga folder name. Plain slug of the title; when another manga has the same slug, the last 6 characters of the id are appended, so two mangas never share a folder. */
export function mangaSlug(manga: Manga, all: readonly Manga[] = []): string {
  const base = baseMangaSlug(manga);
  const clash = all.some((other) => other.id !== manga.id && baseMangaSlug(other) === base);
  return clash ? `${base}-${slugify(manga.id.slice(-6), 'id')}` : base;
}

/**
 * `outDir` (when non-blank) replaces the whole directory (the path, never its contents); otherwise <exportsRoot>/<manga>/<chapter>.
 * Titles are slugged, so they cannot escape the root. Pass `mangas` (every manga in the store) to keep same-titled mangas apart.
 */
export function exportDir(exportsRoot: string, manga: Manga, chapter: Chapter | null, outDir?: string, mangas: readonly Manga[] = []): string {
  if (typeof outDir === 'string' && outDir.trim() !== '') return resolve(outDir.trim());
  return join(exportsRoot, mangaSlug(manga, mangas), chapter ? chapterSlug(chapter) : 'cover');
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
    const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir, store.mangas.list());
    return { dir, items: [{ pageId: page.id, file: join(dir, pageFileName(page, Math.max(0, index), ext)) }], chapterPdf: null, format: ext, pageFormat: manga.pageFormat };
  }
  const chapter = store.chapters.require(payload.target.id);
  const manga = store.mangas.require(chapter.mangaId);
  const dir = exportDir(store.files.exportsDir(), manga, chapter, payload.outDir, store.mangas.list());
  const cover = chapter.coverPageId !== null ? store.pages.get(chapter.coverPageId) : null;
  const story = storyPages(store, chapter.id);
  if (!cover && story.length === 0) throw new PermanentError(`chapter ${chapter.id} has no pages to export`);
  const items: ExportItem[] = [
    ...(cover ? [{ pageId: cover.id, file: join(dir, pageFileName(cover, 0, ext)) }] : []),
    ...story.map((p, i) => ({ pageId: p.id, file: join(dir, pageFileName(p, i, ext)) })),
  ];
  return { dir, items, chapterPdf: ext === 'pdf' ? join(dir, 'chapter.pdf') : null, format: ext, pageFormat: manga.pageFormat };
}
