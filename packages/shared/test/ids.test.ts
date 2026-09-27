import { describe, expect, it } from 'vitest';
import { newId } from '@manga/shared';

describe('newId', () => {
  it('is the prefix, an underscore and 10 base32 characters', () => {
    for (const prefix of ['mg', 'cr', 'ch', 'pg', 'pn', 'tf', 'im', 'jb', 'er'] as const) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[a-z2-7]{10}$`));
    }
  });

  it('does not repeat across 10 000 draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newId('pn'));
    expect(seen.size).toBe(10_000);
  });
});
