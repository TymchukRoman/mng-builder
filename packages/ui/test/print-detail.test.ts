// packages/ui/test/print-detail.test.ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { printDetailKey, printDetailPath } from '../src/render/printDetail';

describe('print detail', () => {
  it('uses the print view only with ?hires=1', () => {
    expect(printDetailPath('pg_1', true)).toBe('/api/pages/pg_1/print');
    expect(printDetailPath('pg_1', false)).toBe('/api/pages/pg_1');
  });

  it('keeps the normal page key, and nests the hires key under it', () => {
    expect(printDetailKey('pg_1', false)).toEqual(['page', 'pg_1']);
    expect(printDetailKey('pg_1', true)).toEqual(['page', 'pg_1', 'print']);
  });

  it('puts the id through seg(): encoded, and dot or empty ids are refused (I1)', () => {
    expect(printDetailPath('a/b?c', true)).toBe('/api/pages/a%2Fb%3Fc/print');
    expect(() => printDetailPath('..', true)).toThrow(ApiError);
    expect(() => printDetailPath('', false)).toThrow(ApiError);
  });
});
