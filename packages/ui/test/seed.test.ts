import { describe, expect, it } from 'vitest';
import { randomSeed } from '../src/lib/seed';

describe('randomSeed', () => {
  it('makes non-negative integer seeds', () => {
    expect(randomSeed(() => 0)).toBe(0);
    expect(randomSeed(() => 0.5)).toBe(2 ** 30);
    expect(randomSeed(() => 0.999999999)).toBeLessThan(2 ** 31);
    expect(Number.isInteger(randomSeed())).toBe(true);
  });
});
