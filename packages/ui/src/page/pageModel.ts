import type { ColorMode, Image, ImageTransform, PageDetail, PageFormat, Panel, TextFrame } from '@manga/shared';
import { dragBox, moveFrame, rotationFromPointer, type Handle } from '../editor/frameDrag';
import type { UpdateFrameBody } from '../types';
import { coverFit, printSizePx, pxPerMm, type Placement, type SizePx } from './geometry';

export type FrameGeom = Pick<TextFrame, 'box' | 'tail' | 'rotation'>;

export function framesInOrder(frames: readonly TextFrame[]): TextFrame[] {
  return [...frames].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function imageFor(detail: PageDetail, panel: Panel | undefined): Image | null {
  if (!panel?.activeImageId) return null;
  return detail.images[panel.activeImageId] ?? null;
}

/**
 * A black and white manga shows grey panel images even when a colour word in the prompt leaked spot colour
 * into the picture (P1 Task 11 ruling). Applied in every mode; frames and chrome are never filtered.
 */
export function panelImageFilter(colorMode: ColorMode): string | undefined {
  return colorMode === 'bw' ? 'grayscale(1)' : undefined;
}

/** Pixels per mm at full print DPI: the scale text is fitted at, so a pt is the same in every mode. */
export function printPpm(format: PageFormat): number {
  return pxPerMm(format, printSizePx(format).w);
}

/** The image's natural size, or null while it is not a positive finite size (`coverFit` and `panLimits` would return NaN). */
export function usableSize(image: Image | null): SizePx | null {
  if (!image) return null;
  const { width: w, height: h } = image;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** `coverFit` behind the size guard: null means the caller falls back to plain CSS cover. */
export function placeImage(panel: SizePx, image: Image | null, t: ImageTransform): Placement | null {
  const size = usableSize(image);
  return size ? coverFit(panel, size, t) : null;
}

export type FrameHandle = Handle | 'tail' | 'rotate';

type Norm = { x: number; y: number };

/** The undo label of a frame drag, by the handle that made it. */
export function dragLabel(handle: FrameHandle): string {
  switch (handle) {
    case 'move': return 'Move frame';
    case 'tail': return 'Move tail';
    case 'rotate': return 'Rotate frame';
    default: return 'Resize frame';
  }
}

/**
 * The frame geometry while a handle is dragged. `from` and `to` are page-normalized pointer positions (drag start and now).
 * A move keeps the box on the page and carries the tail along; corners use the clamped `dragBox`;
 * the tail follows the pointer (kept on the page); rotation is measured around the box centre in page pixels.
 */
export function dragFrameGeom(start: FrameGeom, handle: FrameHandle, from: Norm, to: Norm, size: SizePx): FrameGeom {
  switch (handle) {
    case 'tail': return { ...start, tail: { x: Math.min(1, Math.max(0, to.x)), y: Math.min(1, Math.max(0, to.y)) } };
    case 'rotate': {
      const c = { x: (start.box.x + start.box.w / 2) * size.w, y: (start.box.y + start.box.h / 2) * size.h };
      return { ...start, rotation: rotationFromPointer(c, { x: to.x * size.w, y: to.y * size.h }) };
    }
    case 'move': return { ...start, ...moveFrame(start, to.x - from.x, to.y - from.y) };
    default: return { ...start, box: dragBox(start.box, handle, to.x - from.x, to.y - from.y) };
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Before/after PATCH bodies containing only the geometry fields that changed. */
export function geomPatch(before: FrameGeom, after: FrameGeom): { before: UpdateFrameBody; after: UpdateFrameBody } {
  const b: UpdateFrameBody = {};
  const a: UpdateFrameBody = {};
  if (!same(before.box, after.box)) { b.box = before.box; a.box = after.box; }
  if (!same(before.tail, after.tail)) { b.tail = before.tail; a.tail = after.tail; }
  if (before.rotation !== after.rotation) { b.rotation = before.rotation; a.rotation = after.rotation; }
  return { before: b, after: a };
}

export function sameTransform(a: ImageTransform, b: ImageTransform): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale;
}

export function renderSize(format: PageFormat, scaleParam: string | null): SizePx {
  const n = scaleParam === null ? 1 : Number(scaleParam);
  const scale = Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(0.1, n)) : 1;
  return printSizePx(format, scale);
}
