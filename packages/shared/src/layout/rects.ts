import type { LayoutNode, PageFormat, SplitDir } from '../schemas.js';
import type { SplitPath } from './tree.js';

/** Page-normalized: 0..1 of the page width (x, w) and height (y, h). */
export interface Rect { x: number; y: number; w: number; h: number }

/** The same shape in millimetres, used while walking the tree. */
type MmRect = Rect;

function contentArea(f: PageFormat): MmRect {
  return {
    x: f.marginsMm.inner,
    y: f.marginsMm.top,
    w: f.widthMm - f.marginsMm.inner - f.marginsMm.outer,
    h: f.heightMm - f.marginsMm.top - f.marginsMm.bottom,
  };
}

/** Cuts `r` at `ratio`, with the gutter centred on the cut line. */
function cut(r: MmRect, dir: SplitDir, ratio: number, f: PageFormat): { a: MmRect; b: MmRect; gutter: MmRect } {
  if (dir === 'h') {
    const g = f.gutterRowMm;
    const at = r.y + r.h * ratio;
    return {
      a: { x: r.x, y: r.y, w: r.w, h: Math.max(0, r.h * ratio - g / 2) },
      b: { x: r.x, y: at + g / 2, w: r.w, h: Math.max(0, r.h * (1 - ratio) - g / 2) },
      gutter: { x: r.x, y: at - g / 2, w: r.w, h: g },
    };
  }
  const g = f.gutterColMm;
  const at = r.x + r.w * ratio;
  return {
    a: { x: r.x, y: r.y, w: Math.max(0, r.w * ratio - g / 2), h: r.h },
    b: { x: at + g / 2, y: r.y, w: Math.max(0, r.w * (1 - ratio) - g / 2), h: r.h },
    gutter: { x: at - g / 2, y: r.y, w: g, h: r.h },
  };
}

function normalize(r: MmRect, f: PageFormat): Rect {
  return { x: r.x / f.widthMm, y: r.y / f.heightMm, w: r.w / f.widthMm, h: r.h / f.heightMm };
}

/** One rect per panel, in panelIds order, after margins, gutters and ratios. */
export function computeRects(tree: LayoutNode, format: PageFormat): Array<{ panelId: string; rect: Rect }> {
  const out: Array<{ panelId: string; rect: Rect }> = [];
  const walk = (node: LayoutNode, area: MmRect): void => {
    if (node.type === 'panel') {
      out.push({ panelId: node.id, rect: normalize(area, format) });
      return;
    }
    const parts = cut(area, node.dir, node.ratio, format);
    walk(node.a, parts.a);
    walk(node.b, parts.b);
  };
  walk(tree, contentArea(format));
  return out;
}

/** One entry per split (pre-order): where it is, its parent area and its gutter, for drag handles. */
export function splitHandles(
  tree: LayoutNode,
  format: PageFormat,
): Array<{ path: SplitPath; dir: SplitDir; ratio: number; parent: Rect; gutter: Rect }> {
  const out: Array<{ path: SplitPath; dir: SplitDir; ratio: number; parent: Rect; gutter: Rect }> = [];
  const walk = (node: LayoutNode, area: MmRect, path: SplitPath): void => {
    if (node.type === 'panel') return;
    const parts = cut(area, node.dir, node.ratio, format);
    out.push({ path, dir: node.dir, ratio: node.ratio, parent: normalize(area, format), gutter: normalize(parts.gutter, format) });
    walk(node.a, parts.a, [...path, 'a']);
    walk(node.b, parts.b, [...path, 'b']);
  };
  walk(tree, contentArea(format), []);
  return out;
}
