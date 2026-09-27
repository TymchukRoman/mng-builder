import { describe, expect, it } from 'vitest';
import {
  LayoutError,
  mergePanels,
  mirrorLayout,
  panelIds,
  readingOrder,
  resizeSplit,
  splitPanel,
  type LayoutNode,
} from '@manga/shared';

const P = (id: string): LayoutNode => ({ type: 'panel', id });
const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'h', ratio, a, b });
const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: 'split', dir: 'v', ratio, a, b });

// 2x2: top row (p1 | p2), bottom row (p3 | p4)
const grid = H(0.5, V(0.5, P('p1'), P('p2')), V(0.5, P('p3'), P('p4')));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof LayoutError ? err.code : 'other';
  }
  return undefined;
}

describe('panelIds', () => {
  it('lists leaves depth-first, a before b', () => {
    expect(panelIds(grid)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(panelIds(P('solo'))).toEqual(['solo']);
  });
});

describe('splitPanel', () => {
  it('replaces the leaf with a 50/50 split whose b is the new panel', () => {
    expect(splitPanel(grid, 'p2', 'h', 'p5')).toEqual(
      H(0.5, V(0.5, P('p1'), H(0.5, P('p2'), P('p5'))), V(0.5, P('p3'), P('p4'))),
    );
  });

  it('does not mutate its input', () => {
    const before = structuredClone(grid);
    splitPanel(grid, 'p1', 'v', 'x');
    expect(grid).toEqual(before);
  });

  it('rejects an unknown panel', () => {
    expect(codeOf(() => splitPanel(grid, 'nope', 'h', 'x'))).toBe('not-found');
  });
});

describe('mergePanels', () => {
  it('merges the two leaves of one split, keeping A', () => {
    expect(mergePanels(grid, 'p4', 'p3')).toEqual({
      tree: H(0.5, V(0.5, P('p1'), P('p2')), P('p4')),
      keptId: 'p4',
      removedId: 'p3',
    });
  });

  it('refuses panels that are not siblings', () => {
    expect(codeOf(() => mergePanels(grid, 'p1', 'p3'))).toBe('not-siblings');
    expect(codeOf(() => mergePanels(grid, 'p1', 'p1'))).toBe('not-siblings');
  });

  it('refuses a leaf whose sibling is a subtree', () => {
    const t = H(0.5, P('top'), V(0.5, P('l'), P('r')));
    expect(codeOf(() => mergePanels(t, 'top', 'l'))).toBe('not-siblings');
  });

  it('refuses a panel that is not in the tree', () => {
    expect(codeOf(() => mergePanels(grid, 'p1', 'zz'))).toBe('not-found');
  });
});

describe('resizeSplit', () => {
  it('sets the ratio of the split at the path', () => {
    expect(resizeSplit(grid, ['b'], 0.3)).toEqual(H(0.5, V(0.5, P('p1'), P('p2')), V(0.3, P('p3'), P('p4'))));
    expect(resizeSplit(grid, [], 0.7)).toEqual({ ...grid, ratio: 0.7 });
  });

  it('clamps each side to at least 8% of the parent', () => {
    expect((resizeSplit(grid, [], 0.01) as { ratio: number }).ratio).toBe(0.08);
    expect((resizeSplit(grid, [], 0.999) as { ratio: number }).ratio).toBe(0.92);
  });

  it('rejects a path that does not end on a split', () => {
    expect(codeOf(() => resizeSplit(grid, ['a', 'a'], 0.5))).toBe('not-found');
    expect(codeOf(() => resizeSplit(P('solo'), [], 0.5))).toBe('not-found');
  });
});

describe('readingOrder', () => {
  it('reads top before bottom, left to right in LTR', () => {
    expect(readingOrder(grid, 'ltr')).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('reads top before bottom, right to left in RTL', () => {
    expect(readingOrder(grid, 'rtl')).toEqual(['p2', 'p1', 'p4', 'p3']);
  });

  it('finishes a column before moving across', () => {
    const t = V(0.5, H(0.5, P('l1'), P('l2')), P('right'));
    expect(readingOrder(t, 'rtl')).toEqual(['right', 'l1', 'l2']);
    expect(readingOrder(t, 'ltr')).toEqual(['l1', 'l2', 'right']);
  });
});

describe('mirrorLayout', () => {
  it('swaps the sides of vertical splits and flips their ratio', () => {
    const t = V(0.25, P('narrow'), H(0.5, P('a'), P('b')));
    expect(mirrorLayout(t)).toEqual(V(0.75, H(0.5, P('a'), P('b')), P('narrow')));
  });

  it('is its own inverse, and RTL-reading a mirrored tree equals LTR-reading the original', () => {
    expect(mirrorLayout(mirrorLayout(grid))).toEqual(grid);
    expect(readingOrder(mirrorLayout(grid), 'rtl')).toEqual(readingOrder(grid, 'ltr'));
  });
});
