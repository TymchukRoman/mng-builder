import type { JSX } from 'react';

export interface CreateChapterAiSectionProps {
  mangaId: string;
  /** Register the function that starts an episode for the new chapter, or null to create a plain chapter. */
  onChange(start: ((chapterId: string) => Promise<void>) | null): void;
}

/**
 * M4 extension slot (Contract E): the collapsible "Generate with AI" section of CreateChapterModal
 * (prompt, pages, characters, autopilot). M3 renders nothing.
 */
export function CreateChapterAiSection(_props: CreateChapterAiSectionProps): JSX.Element | null {
  return null;
}
