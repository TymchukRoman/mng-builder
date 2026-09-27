export const SDXL_SIZES: Array<[number, number]> = [
  [1024, 1024], [896, 1152], [832, 1216], [768, 1344], [640, 1536], [1152, 896], [1216, 832], [1344, 768], [1536, 640],
];

/** Picks the size whose w/h is closest to `aspect` (compares log ratios). */
export function pickSize(aspect: number, sizes: Array<[number, number]>): [number, number] {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError(`aspect must be a positive number, got ${aspect}`);
  const [first, ...rest] = sizes;
  if (first === undefined) throw new RangeError('sizes must not be empty');
  const target = Math.log(aspect);
  let best = first;
  let bestDistance = Math.abs(Math.log(first[0] / first[1]) - target);
  for (const size of rest) {
    const distance = Math.abs(Math.log(size[0] / size[1]) - target);
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}
