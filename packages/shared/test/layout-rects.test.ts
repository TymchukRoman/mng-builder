import { describe, expect, it } from 'vitest';
import { computeRects, DEFAULT_PAGE_FORMAT, splitHandles, type LayoutNode, type Rect } from '@manga/shared';

const F = DEFAULT_PAGE_FORMAT; // 182×257 mm; margins top/bottom 12, inner/outer 10; gutters col 3, row 6
const P = (id: string): LayoutNode => ({ type: 'panel', id });
const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'h', ratio, a, b });
const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'v', ratio, a, b });
const mm = (x: number, y: number, w: number, h: number): Rect => ({ x: x / 182, y: y / 257, w: w / 182, h: h / 257 });
const grid = H(0.5, V(0.5, P('tl'), P('tr')), V(0.5, P('bl'), P('br')));

function expectRect(actual: Rect | undefined, expected: Rect): void {
  expect(actual).toBeDefined();
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(actual?.[k]).toBeCloseTo(expected[k], 9);
}

describe('computeRects', () => {
  it('fills the area inside the margins with a single panel', () => {
    const rects = computeRects(P('solo'), F);
    expect(rects.map((r) => r.panelId)).toEqual(['solo']);
    expectRect(rects[0]?.rect, mm(10, 12, 162, 233));
  });

  it('centres a 6 mm row gutter and a 3 mm column gutter on each cut', () => {
    const rects = new Map(computeRects(grid, F).map((r) => [r.panelId, r.rect]));
    expectRect(rects.get('tl'), mm(10, 12, 79.5, 113.5));
    expectRect(rects.get('tr'), mm(92.5, 12, 79.5, 113.5));
    expectRect(rects.get('bl'), mm(10, 131.5, 79.5, 113.5));
    expectRect(rects.get('br'), mm(92.5, 131.5, 79.5, 113.5));
  });

  it('places the cut at the ratio of the parent', () => {
    // cut at 12 + 233 × 0.25 = 70.25 mm; gutter 67.25 … 73.25
    const rects = computeRects(H(0.25, P('top'), P('rest')), F);
    expectRect(rects[0]?.rect, mm(10, 12, 162, 55.25));
    expectRect(rects[1]?.rect, mm(10, 73.25, 162, 171.75));
  });

  it('uses marginsMm.inner on the left and marginsMm.outer on the right', () => {
    const f = { ...F, marginsMm: { top: 0, bottom: 0, inner: 20, outer: 5 } };
    expectRect(computeRects(P('x'), f)[0]?.rect, { x: 20 / 182, y: 0, w: 157 / 182, h: 1 });
  });
});

describe('splitHandles', () => {
  it('describes every split with its path, parent rect and gutter rect, root first', () => {
    const handles = splitHandles(grid, F);
    expect(handles.map((h) => [h.path.join(''), h.dir, h.ratio])).toEqual([['', 'h', 0.5], ['a', 'v', 0.5], ['b', 'v', 0.5]]);
    expectRect(handles[0]?.parent, mm(10, 12, 162, 233));
    expectRect(handles[0]?.gutter, mm(10, 125.5, 162, 6));
    expectRect(handles[1]?.parent, mm(10, 12, 162, 113.5));
    expectRect(handles[1]?.gutter, mm(89.5, 12, 3, 113.5));
    expectRect(handles[2]?.parent, mm(10, 131.5, 162, 113.5));
  });

  it('is empty for a single panel', () => {
    expect(splitHandles(P('solo'), F)).toEqual([]);
  });
});
