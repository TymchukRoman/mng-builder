import { CHAPTER_TITLE_FROM_PREMISE } from '@manga/shared';
import { errorText } from '../ui/toasts';

/**
 * The title the new chapter is created with (M4 final M6): what the user typed, else, while the AI section has a
 * prompt, the placeholder the premise step replaces. null: nothing to create yet (no title and no AI prompt).
 */
export function chapterTitleFor(typed: string, aiPrompt: boolean): string | null {
  const title = typed.trim();
  if (title !== '') return title;
  return aiPrompt ? CHAPTER_TITLE_FROM_PREMISE : null;
}

export function startFailureMessage(err: unknown): string {
  return `Chapter created, but the episode could not start: ${errorText(err)}`;
}

/**
 * POST the chapter, then start its episode (M4 slot) if one is registered. Once the POST has succeeded the
 * chapter exists, so a failing `start` is reported through `onStartError` and never rejects the flow:
 * the caller can still open the chapter, and a retry cannot create a second one.
 */
export async function createChapterFlow<C extends { id: string }>({ post, start, onStartError }: {
  post(): Promise<C>;
  start: ((chapterId: string) => Promise<void>) | null;
  onStartError(err: unknown): void;
}): Promise<C> {
  const chapter = await post();
  if (start) {
    try { await start(chapter.id); } catch (err) { onStartError(err); }
  }
  return chapter;
}
