export type Side = 'top' | 'bottom' | 'left' | 'right';
export interface RectLike { left: number; top: number; width: number; height: number }
export interface SizeLike { width: number; height: number }

const GAP = 6;
const MARGIN = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function opposite(s: Side): Side {
  return s === 'top' ? 'bottom' : s === 'bottom' ? 'top' : s === 'left' ? 'right' : 'left';
}

/** Places a tooltip on the preferred side of its anchor, flipping when that side lacks room, then clamps to the viewport. */
export function placeTip(anchor: RectLike, tip: SizeLike, viewport: SizeLike, preferred: Side): { x: number; y: number; side: Side } {
  const at = (side: Side): { x: number; y: number } => {
    const cx = anchor.left + anchor.width / 2 - tip.width / 2;
    const cy = anchor.top + anchor.height / 2 - tip.height / 2;
    if (side === 'top') return { x: cx, y: anchor.top - GAP - tip.height };
    if (side === 'bottom') return { x: cx, y: anchor.top + anchor.height + GAP };
    if (side === 'left') return { x: anchor.left - GAP - tip.width, y: cy };
    return { x: anchor.left + anchor.width + GAP, y: cy };
  };
  const fits = (side: Side, p: { x: number; y: number }): boolean => {
    if (side === 'top') return p.y >= MARGIN;
    if (side === 'bottom') return p.y + tip.height <= viewport.height - MARGIN;
    if (side === 'left') return p.x >= MARGIN;
    return p.x + tip.width <= viewport.width - MARGIN;
  };
  const order: Side[] = [preferred, opposite(preferred), 'bottom', 'top'];
  let chosen: Side = preferred;
  let pos = at(preferred);
  for (const side of order) {
    const p = at(side);
    if (fits(side, p)) { chosen = side; pos = p; break; }
  }
  return {
    x: clamp(pos.x, MARGIN, viewport.width - tip.width - MARGIN),
    y: clamp(pos.y, MARGIN, viewport.height - tip.height - MARGIN),
    side: chosen,
  };
}

/** Places a popover below its anchor (above when there is no room), aligned to the anchor's start or end edge. */
export function placePopover(anchor: RectLike, pop: SizeLike, viewport: SizeLike, align: 'start' | 'end'): { x: number; y: number } {
  const below = anchor.top + anchor.height + MARGIN;
  const above = anchor.top - MARGIN - pop.height;
  const y = below + pop.height > viewport.height - MARGIN && above >= MARGIN ? above : below;
  const x = align === 'start' ? anchor.left : anchor.left + anchor.width - pop.width;
  return { x: clamp(x, MARGIN, viewport.width - pop.width - MARGIN), y: clamp(y, MARGIN, viewport.height - pop.height - MARGIN) };
}
