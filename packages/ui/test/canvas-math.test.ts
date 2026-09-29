import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT } from '@manga/shared';
import { dropIndex, isNoopMove, moveId } from '../src/editor/reorder';
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
  const rows = [{ top: 0, height: 100 }, { top: 108, height: 100 }, { top: 216, height: 100 }];
  it('drops before or after an item by its midpoint', () => {
    expect(dropIndex(rows, 10)).toBe(0);
    expect(dropIndex(rows, 60)).toBe(1);
    expect(dropIndex(rows, 150)).toBe(1);
    expect(dropIndex(rows, 170)).toBe(2);
  });
  it('a drop in the gap between items lands at the next index, and below the last one at the end', () => {
    expect(dropIndex(rows, 104)).toBe(1);
    expect(dropIndex(rows, 212)).toBe(2);
    expect(dropIndex(rows, 290)).toBe(3);
    expect(dropIndex(rows, 900)).toBe(3);
    expect(dropIndex([], 50)).toBe(0);
  });
  it('knows when a drop would not move the item (no drop indicator)', () => {
    expect(isNoopMove(ids, 'b', 1)).toBe(true);
    expect(isNoopMove(ids, 'b', 2)).toBe(true);
    expect(isNoopMove(ids, 'b', 0)).toBe(false);
    expect(isNoopMove(ids, 'b', 3)).toBe(false);
    expect(isNoopMove(ids, 'd', 4)).toBe(true);
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
