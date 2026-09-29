import { describe, expect, it } from 'vitest';
import { newId } from '@manga/shared';
import { isId } from '../src/lib/ids';

describe('isId (I1: route params are validated before any request)', () => {
  it('accepts ids that newId makes, for the matching prefix only', () => {
    const mg = newId('mg');
    expect(isId(mg, 'mg')).toBe(true);
    expect(isId(newId('ch'), 'ch')).toBe(true);
    expect(isId(newId('pg'), 'pg')).toBe(true);
    expect(isId(mg, 'ch')).toBe(false);
  });
  it('rejects crafted values', () => {
    for (const bad of [
      'x/../../shutdown?', 'mg_abc/../../shutdown?', 'mg_abc?x', 'mg_abc%2F', 'mg_..', '..', '.', '', 'mg_', 'MG_abc', 'mg_ABC',
      'mg_abc#x', 'mg_abc def', ' mg_abc', 'mg_abc\n', undefined,
    ]) expect(isId(bad, 'mg'), JSON.stringify(bad)).toBe(false);
  });
});
