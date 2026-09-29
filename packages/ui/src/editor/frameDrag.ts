import type { Box, FrameKind } from '@manga/shared';

export type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
export const MIN_FRAME = 0.02;

type Point = { x: number; y: number };

/** Keeps a box on the page: `w` and `h` capped at 1, `x` in [0, 1-w], `y` in [0, 1-h]. */
export function clampBox(b: Box): Box {
  const w = Math.min(1, b.w);
  const h = Math.min(1, b.h);
  return { x: Math.min(1 - w, Math.max(0, b.x)), y: Math.min(1 - h, Math.max(0, b.y)), w, h };
}

/**
 * dx, dy are page-normalized pointer deltas since the drag started. A corner moves only its own edges,
 * and those edges stay on the page and at least `min` away from the opposite edge.
 */
export function dragBox(start: Box, handle: Handle, dx: number, dy: number, min = MIN_FRAME): Box {
  if (handle === 'move') return clampBox({ ...start, x: start.x + dx, y: start.y + dy });
  let { x, y, w, h } = start;
  if (handle === 'nw' || handle === 'sw') {
    const nx = Math.max(0, Math.min(x + dx, x + w - min));
    w = x + w - nx;
    x = nx;
  } else {
    w = Math.max(min, Math.min(w + dx, 1 - x));
  }
  if (handle === 'nw' || handle === 'ne') {
    const ny = Math.max(0, Math.min(y + dy, y + h - min));
    h = y + h - ny;
    y = ny;
  } else {
    h = Math.max(min, Math.min(h + dy, 1 - y));
  }
  return clampBox({ x, y, w, h });
}

/** Moves a frame on the page. The tail (if any) travels by the same effective delta, so it keeps its place relative to the box. */
export function moveFrame(start: { box: Box; tail: Point | null }, dxN: number, dyN: number): { box: Box; tail: Point | null } {
  const box = clampBox({ ...start.box, x: start.box.x + dxN, y: start.box.y + dyN });
  const tail = start.tail === null ? null : { x: start.tail.x + (box.x - start.box.x), y: start.tail.y + (box.y - start.box.y) };
  return { box, tail };
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
