import type { z } from 'zod';
import type { ColorMode, Language, ReadingDirection, StartAutoMangaSchema } from '@manga/shared';
import { MAX_AUTO_CHAPTERS } from '@manga/shared';

export type StartAutoMangaBody = z.input<typeof StartAutoMangaSchema>;

/** What the "from a prompt" form holds besides the fields the manual form shares (title, language, direction, style, colour). */
export interface AutoMangaDraft {
  brief: string; chapters: number; pages: number;
  /** The manga's image model, null: Settings' routing. */
  imageModel: string | null;
  /** Per chapter (index 0 = chapter 1), null: the manga's. Always as long as `chapters`. */
  chapterModels: Array<string | null>;
  poster: boolean;
}

export const EMPTY_AUTO_DRAFT: AutoMangaDraft = { brief: '', chapters: 3, pages: 8, imageModel: null, chapterModels: [null, null, null], poster: true };

/** The count of a half-typed field: unreadable falls back to `fallback`, the rest is clamped to 1..max. */
export function clampCount(text: string, max: number, fallback: number): number {
  const n = Number(text.trim().replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

export const parseChapters = (text: string): number => clampCount(text, MAX_AUTO_CHAPTERS, 3);
export const parsePagesPerChapter = (text: string): number => clampCount(text, 30, 8);

/** The per-chapter models for a new chapter count: kept where they were, null for new chapters. */
export function resizeChapterModels(models: ReadonlyArray<string | null>, chapters: number): Array<string | null> {
  return Array.from({ length: chapters }, (_, i) => models[i] ?? null);
}

export interface SharedMangaFields { title: string; language: Language; colorMode: ColorMode; direction: ReadingDirection; preset: string }

/** The request body, or null while the brief is empty. A blank title is left to the plan. */
export function toAutoInput(draft: AutoMangaDraft, shared: SharedMangaFields): StartAutoMangaBody | null {
  const brief = draft.brief.trim();
  if (brief === '') return null;
  return {
    input: {
      brief, chapters: draft.chapters, pagesPerChapter: draft.pages, title: shared.title.trim(), language: shared.language,
      colorMode: shared.colorMode, readingDirection: shared.direction, stylePreset: shared.preset,
      imageModel: draft.imageModel, chapterModels: resizeChapterModels(draft.chapterModels, draft.chapters), poster: draft.poster,
    },
  };
}
