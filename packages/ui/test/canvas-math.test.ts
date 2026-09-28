import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT } from '@manga/shared';
import { dropIndex, moveId } from '../src/editor/reorder';
import { fitWidth, stepZoom, zoomFactor, zoomLabel } from '../src/editor/zoom';

describe('reorder', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('moves an id to an insertion index of the original list', () => {
    expect(moveId(ids, 'a', 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveId(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveId(ids, 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveId(ids, 'b', 1)).toEqual(ids);
    expect(moveId(ids, 'b', 2)).toEqual(ids);
    expect(moveId(ids, 'zz', 0)).toEqual(ids);
  });
  it('clamps out-of-range insertion indices', () => {
    expect(moveId(ids, 'c', -1)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveId(ids, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveId(ids, 'd', 99)).toEqual(ids);
  });
  it('drops before or after an item by its midpoint', () => {
    expect(dropIndex(100, 40, 110, 3)).toBe(3);
    expect(dropIndex(100, 40, 130, 3)).toBe(4);
  });
});

describe('zoom', () => {
  it('fits the page inside the container', () => {
    expect(fitWidth({ w: 848, h: 1000 }, DEFAULT_PAGE_FORMAT)).toBe(674);
    expect(fitWidth({ w: 300, h: 3000 }, DEFAULT_PAGE_FORMAT)).toBe(252);
    expect(fitWidth({ w: 0, h: 0 }, DEFAULT_PAGE_FORMAT)).toBe(56);
  });
  it('steps through the zoom levels and stops at the ends', () => {
    expect(stepZoom({ mode: 'fit' }, 1)).toEqual({ mode: 'fixed', factor: 1.25 });
    expect(stepZoom({ mode: 'fit' }, -1)).toEqual({ mode: 'fixed', factor: 0.75 });
    expect(stepZoom({ mode: 'fixed', factor: 4 }, 1)).toEqual({ mode: 'fixed', factor: 4 });
    expect(stepZoom({ mode: 'fixed', factor: 0.5 }, -1)).toEqual({ mode: 'fixed', factor: 0.5 });
    expect(zoomFactor({ mode: 'fit' })).toBe(1);
    expect(zoomLabel({ mode: 'fit' })).toBe('Fit');
    expect(zoomLabel({ mode: 'fixed', factor: 1.5 })).toBe('150%');
  });
});
