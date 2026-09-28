import type { Box, FrameKind } from '@manga/shared';
import type { SizePx } from '../page/geometry';

export type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
export const MIN_FRAME = 0.02;

/** dx, dy are page-normalized pointer deltas since the drag started. A corner moves only its own edges. */
export function dragBox(start: Box, handle: Handle, dx: number, dy: number, min = MIN_FRAME): Box {
  if (handle === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  let { x, y, w, h } = start;
  if (handle === 'nw' || handle === 'sw') {
    const nx = Math.min(x + dx, x + w - min);
    w = x + w - nx;
    x = nx;
  } else {
    w = Math.max(min, w + dx);
  }
  if (handle === 'nw' || handle === 'ne') {
    const ny = Math.min(y + dy, y + h - min);
    h = y + h - ny;
    y = ny;
  } else {
    h = Math.max(min, h + dy);
  }
  return { x, y, w, h };
}

export function nudgeBox(b: Box, dxPx: number, dyPx: number, size: SizePx): Box {
  return { ...b, x: b.x + dxPx / size.w, y: b.y + dyPx / size.h };
}

/** Degrees, clockwise, 0 = pointer straight above the centre. Rounded to whole degrees. */
export function rotationFromPointer(center: { x: number; y: number }, p: { x: number; y: number }): number {
  return Math.round((Math.atan2(p.x - center.x, -(p.y - center.y)) * 180) / Math.PI);
}

/** Where a tail starts when a frame first gets one (also the ghost-tail position in FrameHandles). */
export function defaultTail(box: Box): { x: number; y: number } {
  return { x: box.x + box.w * 0.3, y: box.y + box.h + 0.04 };
}

export function hasTail(kind: FrameKind): boolean {
  return kind === 'speech' || kind === 'thought' || kind === 'shout';
}

export function canRotate(kind: FrameKind): boolean {
  return kind === 'sfx' || kind === 'title';
}
