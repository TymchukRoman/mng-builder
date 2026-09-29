import { errorText } from '../ui/toasts';

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
