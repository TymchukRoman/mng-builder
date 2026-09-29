import type { JSX } from 'react';

/**
 * M4 extension slot (Contract E): the episode stepper in the chapter screen. The chapter editor (Task 18)
 * renders it unconditionally; M4 loads GET /api/chapters/:id/episode here and renders only when it is
 * non-null. M3 renders nothing, because that endpoint does not exist before M4.
 */
export function EpisodePanel(_props: { chapterId: string }): JSX.Element | null {
  return null;
}
