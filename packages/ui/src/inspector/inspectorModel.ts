import { readingOrder, type Image, type Job, type LayoutNode, type PanelScript, type ReadingDirection, type RecipeInfo, type ReviewResult } from '@manga/shared';
import { activeJobs, jobTargetsPanel } from '../jobs/jobView';

/** DialogueLine.text is min(1) on the server: hold the save while a new line is still empty. */
export function scriptSaveable(script: PanelScript): boolean {
  return script.dialogue.every((d) => d.text.trim().length > 0) && script.characters.every((c) => c.characterId.length > 0);
}

export function panelNumbers(layout: LayoutNode, dir: ReadingDirection): Map<string, number> {
  return new Map(readingOrder(layout, dir).map((id, i) => [id, i + 1]));
}

export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function reviewSummary(review: ReviewResult): string {
  if (review.pass) return 'Review passed';
  return `Review flagged: ${review.issues.map((i) => `${i.kind} (${i.note})`).join('; ')}`;
}

/** Generated and uploaded variants, newest first. Upscaled copies are caches of a variant, not variants. */
export function visibleVariants(images: readonly Image[]): Image[] {
  return images.filter((i) => i.source !== 'upscaled').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The unfinished jobs of one panel: image jobs (generate, review) show under the image, the AI prompt job under the prompt.
 * All three carry `panelId` in their payload.
 */
export function panelJobs(jobs: readonly Job[] | undefined, panelId: string): { image: Job[]; prompt: Job | undefined } {
  const mine = activeJobs(jobs).filter((j) => jobTargetsPanel(j, panelId));
  return {
    image: mine.filter((j) => j.kind === 'image.generate' || j.kind === 'image.review'),
    prompt: mine.find((j) => j.kind === 'llm.step'),
  };
}

/** The recipes the panel select lists. A stored recipe that is no longer offered stays selectable, so the select never shows a wrong value. */
export function recipeChoices(offered: readonly RecipeInfo[], current: string | null): Array<{ id: string; label: string }> {
  const list = offered.map((r) => ({ id: r.id, label: r.label }));
  return current !== null && !list.some((r) => r.id === current) ? [...list, { id: current, label: current }] : list;
}
