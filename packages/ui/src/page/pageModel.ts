import type { ColorMode, Image, ImageTransform, LayoutNode, PageDetail, PageFormat, Panel, TextFrame } from '@manga/shared';
import { printSizePx, type Box } from '@manga/shared';
import { defaultTail, dragBox, moveFrame, rotationFromPointer, type Handle } from '../editor/frameDrag';
import { applyMoves, reanchorFrames, rectMap } from '../editor/reanchor';
import type { UpdateFrameBody } from '../types';
import type { BoxPx, PointPx } from './bubbles';
import { coverFit, pageSizePx, pxPerMm, zoomBy, type Placement, type SizePx } from './geometry';

export type FrameGeom = Pick<TextFrame, 'box' | 'tail' | 'rotation'>;

export function framesInOrder(frames: readonly TextFrame[]): TextFrame[] {
  return [...frames].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The frames as they look while a gutter is dragged: the live layout replaces the committed one, and anchored frames follow
 * their panel exactly as they will once the resize is saved (`reanchorFrames`). Nothing is saved from here.
 */
export function liveFrames(frames: readonly TextFrame[], committed: LayoutNode, live: LayoutNode, format: PageFormat): readonly TextFrame[] {
  if (live === committed) return frames;
  return applyMoves(frames, reanchorFrames(frames, rectMap(committed, format), rectMap(live, format)));
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

/**
 * How a panel shows its image (M7). An image that failed to load shows the empty screentone, and in edit mode a warning
 * badge, instead of plain paper. Print mode keeps the image: the print route fails fast on a decode error instead.
 */
export function panelImageView(hasImage: boolean, failed: boolean, mode: 'edit' | 'thumb' | 'print'): { showImage: boolean; empty: boolean; badge: boolean } {
  if (mode === 'print') return { showImage: hasImage, empty: false, badge: false };
  const broken = hasImage && failed;
  return { showImage: hasImage && !broken, empty: !hasImage || broken, badge: broken && mode === 'edit' };
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

/**
 * The size of the print route's root: the print width from `renderSize`, with the height PageView derives from that width.
 * `printSizePx` rounds the height on its own and can differ from it by a few pixels at scales other than 1.
 */
export function renderPageSize(format: PageFormat, scaleParam: string | null): SizePx {
  return pageSizePx(format, renderSize(format, scaleParam).w);
}

const ROTATE_GAP_PX = 18;

/** The rotate handle sits above the box; on the page's top edge it moves below the box so it stays on the page. */
export function rotateHandleAt(box: BoxPx, size: SizePx): PointPx {
  const x = box.x + box.w / 2;
  const above = box.y - ROTATE_GAP_PX;
  if (above >= 0) return { x, y: above };
  return { x, y: Math.min(size.h, box.y + box.h + ROTATE_GAP_PX) };
}

/** The ghost tail starts below the box (Task 10 `defaultTail`); on the page's bottom edge it starts above the box. */
export function ghostTailAt(box: Box, size: SizePx): PointPx {
  const below = defaultTail(box);
  if (below.y <= 1) return { x: below.x * size.w, y: below.y * size.h };
  return { x: below.x * size.w, y: Math.max(0, box.y + (box.y + box.h - below.y)) * size.h };
}

/** One wheel event of the image zoom. Feed it the previous result, not the rendered transform, so events between renders accumulate. */
export function wheelZoom(t: ImageTransform, deltaY: number, panel: SizePx, image: SizePx): ImageTransform {
  return zoomBy(t, Math.exp(-deltaY * 0.0015), panel, image);
}
