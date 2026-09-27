import { z } from 'zod';
import {
  ReviewIssueKindSchema,
  type Character, type ImageReviewPayload, type ImageReviewResult, type Panel, type ReviewResult,
} from '@manga/shared';
import type { JobContext } from '../jobs/index.js';
import { loadPrompt } from '../prompts/load.js';
import { scriptBlock } from '../prompts/script-block.js';
import { emitEntity, panelContext } from './context.js';
import type { HandlerServices } from './types.js';

export const ReviewOutputSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.object({ kind: ReviewIssueKindSchema, note: z.string().min(1) })),
});

export function reviewRequest(panel: Panel | null, characters: Character[], referenceNames: string[]): string {
  const lines = [
    panel
      ? scriptBlock(panel.script, characters)
      : `No panel script: this is a character reference image of ${characters.map((c) => c.name).join(', ') || 'a character'}. Check only character-count, identity, anatomy and text.`,
    '',
    'Pictures:',
    '- Picture 1: the generated image to check.',
  ];
  referenceNames.forEach((name, i) => lines.push(`- Picture ${i + 2}: reference portrait of ${name}.`));
  lines.push('', 'Check picture 1 against the script and the references.');
  return lines.join('\n');
}

/**
 * Spec §8: the review engine sees the panel script, the generated image and the character portraits, and
 * decides pass/fail. Controller ruling (Task 19): the final write re-checks the image still exists in the same
 * `store.tx` (it may have been deleted while the LLM was looking at it) and emits `image updated` exactly once.
 */
export async function reviewImage(ctx: JobContext, services: HandlerServices, p: ImageReviewPayload): Promise<ImageReviewResult> {
  const { store } = ctx;
  const image = store.images.require(p.imageId);
  const panelId = p.panelId ?? (image.ownerType === 'panel' ? image.ownerId : null);
  const pc = panelId ? panelContext(store, panelId) : null;
  const characters = pc ? pc.characters : image.ownerType === 'character' ? [store.characters.require(image.ownerId)] : [];
  const references = characters.flatMap((c) => {
    const ref = c.refs.portrait ? store.images.get(c.refs.portrait) : null;
    return ref && ref.id !== image.id ? [{ name: c.name, path: store.files.abs(ref.path) }] : [];
  });
  const engine = services.engines.for('review');
  ctx.progress(engine.name === 'claude' ? 'Reviewing with Claude' : 'Reviewing with the local model');
  const out = await engine.completeJson({
    name: 'review', task: 'review', system: loadPrompt('review'),
    prompt: reviewRequest(pc?.panel ?? null, characters, references.map((r) => r.name)),
    schema: ReviewOutputSchema, images: [store.files.abs(image.path), ...references.map((r) => r.path)],
    signal: ctx.signal, onProgress: (label) => ctx.progress(label),
  });
  const review: ReviewResult = { engine: engine.name, pass: out.pass, issues: out.issues, at: new Date().toISOString() };

  // One transaction re-checks the image still exists (it may have been deleted while the LLM was reviewing it) —
  // a deleted image rejects with NotFoundError instead of writing a review onto a row that is gone (m2-rulings
  // Task 19). Never emit the event unless the write actually happened.
  store.tx(() => {
    store.images.require(image.id);
    store.images.update(image.id, { review });
  });
  emitEntity(ctx.bus, 'image', image.id, 'updated', image.mangaId);
  return review;
}
