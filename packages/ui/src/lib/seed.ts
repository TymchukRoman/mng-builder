/** A generation seed in [0, 2^31): valid for every sampler and safe as a JS integer. */
export function randomSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * 2 ** 31);
}
