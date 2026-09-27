import { randomInt } from 'node:crypto';

/** A generation seed in [0, 2^32), valid for every ComfyUI sampler. */
export function randomSeed(): number {
  return randomInt(0, 2 ** 32);
}
