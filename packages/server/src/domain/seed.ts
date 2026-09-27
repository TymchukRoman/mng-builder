import { randomInt } from 'node:crypto';

/** Every ComfyUI sampler seed lives in [0, SEED_MODULUS). */
export const SEED_MODULUS = 2 ** 32;

/** A generation seed in [0, 2^32), valid for every ComfyUI sampler. */
export function randomSeed(): number {
  return randomInt(0, SEED_MODULUS);
}
