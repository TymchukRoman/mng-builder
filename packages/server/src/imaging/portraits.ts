import type { Character, ImageGeneratePayload, Job } from '@manga/shared';
import { SEED_MODULUS } from '../domain/seed.js';
import type { JobQueue } from '../jobs/index.js';

/**
 * Queues `n` portrait variants of a character (spec §6.4) with consecutive seeds from the character's own. Shared by
 * the portraits route and the episode (F28); `episodeRunId` tags the jobs of an episode run.
 */
export function enqueuePortraits(
  queue: Pick<JobQueue, 'enqueue'>, character: Pick<Character, 'id' | 'seed'>, n: number, episodeRunId: string | null = null,
): Job[] {
  return Array.from({ length: n }, (_, i) => {
    const payload: ImageGeneratePayload = { target: 'character-portrait', characterId: character.id, seed: (character.seed + i) % SEED_MODULUS };
    return queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId });
  });
}
