import type { z } from 'zod';
import type { StartEpisodeSchema } from '@manga/shared';
import { seg } from '../api';

export type StartEpisodeBody = z.input<typeof StartEpisodeSchema>;

export interface AiChapterInput {
  open: boolean; prompt: string; pages: number; tone: string; characterIds: string[]; autopilot: boolean;
  /** W1 Q2: render the cover and page 1 first, then wait for Continue. */
  previewFirst: boolean;
  /** The image model of this chapter; null: the manga's (or Settings' routing). Set on the chapter before its episode starts. */
  imageModel: string | null;
}

export const EMPTY_AI_INPUT: AiChapterInput = { open: false, prompt: '', pages: 8, tone: '', characterIds: [], autopilot: false, previewFirst: true, imageModel: null };

/** EpisodeInputSchema allows 1..30 pages; an unreadable number falls back to the default 8. */
export function clampPages(n: number): number {
  if (!Number.isFinite(n)) return 8;
  return Math.min(30, Math.max(1, Math.round(n)));
}

/** The page count of a half-typed field: an empty or unreadable field is the default, not 1 (Number('') is 0). */
export function parsePages(text: string): number {
  const t = text.trim().replace(',', '.');
  return clampPages(t === '' ? Number.NaN : Number(t));
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export function toStartEpisode(v: AiChapterInput): StartEpisodeBody | null {
  const prompt = v.prompt.trim();
  if (!v.open || prompt === '') return null;
  return {
    input: { prompt, pages: clampPages(v.pages), tone: v.tone.trim(), characterIds: v.characterIds, previewFirst: v.previewFirst },
    mode: v.autopilot ? 'autopilot' : 'review',
  };
}

/**
 * The function CreateChapterModal calls once the chapter exists: POST the episode start for that chapter (its id goes through `seg`,
 * so an invalid id throws before anything is sent). null while the section is closed or has no prompt, which means a plain chapter.
 */
export function makeStart(
  v: AiChapterInput,
  post: (path: string, body: StartEpisodeBody) => Promise<unknown>,
  patch?: (path: string, body: { imageModel: string }) => Promise<unknown>,
): ((chapterId: string) => Promise<void>) | null {
  const body = toStartEpisode(v);
  if (!body) return null;
  return async (chapterId) => {
    // The model goes on the chapter first, so the episode's prompts and images already route through it.
    if (v.imageModel !== null && patch) await patch(`/api/chapters/${seg(chapterId)}`, { imageModel: v.imageModel });
    await post(`/api/chapters/${seg(chapterId)}/episode`, body);
  };
}
