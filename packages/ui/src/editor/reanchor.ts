import { computeRects, type Box, type LayoutNode, type PageFormat, type Rect, type TextFrame } from '@manga/shared';
import type { UpdateFrameBody } from '../types';
import { clampBox } from './frameDrag';

type Point = { x: number; y: number };

/** A frame's new geometry after a layout change. `panelId` is present only when the frame changes panel. */
export interface FrameMove { id: string; box: Box; tail: Point | null; panelId?: string | null }

/** Rects closer than this are the same rect (they come from the same arithmetic, so real changes are far larger). */
const EPS = 1e-9;

const sameRect = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;

const samePoint = (a: Point | null, b: Point | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

const sameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Page-normalised rects by panel id. */
export function rectMap(layout: LayoutNode, format: PageFormat): Map<string, Rect> {
  return new Map(computeRects(layout, format).map((r) => [r.panelId, r.rect]));
}

/** Maps a point from one rect to another, keeping its relative position. */
function mapPoint(p: Point, from: Rect, to: Rect): Point {
  return { x: to.x + ((p.x - from.x) * to.w) / from.w, y: to.y + ((p.y - from.y) * to.h) / from.h };
}

function inside(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Where the frames anchored to a panel go when the panels' rects change (spec §9: a bubble stays where it is
 * relative to its panel). Only frames that change are returned.
 *
 * - No anchor (`panelId === null`), or an anchor missing from either map (a panel a preset removed): never moves.
 * - Otherwise the box and the tail are mapped proportionally from the panel's old rect to its new one, the box is
 *   clamped to the page, and the tail is translated by the same clamp correction (so it keeps its offset from the box).
 * - `opts.splitFrom` names a split: the panel keeps its place but its area is shared with `newPanelId`. Its frames
 *   don't move; the ones centred over the new panel are re-anchored to it.
 */
export function reanchorFrames(
  frames: readonly TextFrame[],
  oldRects: ReadonlyMap<string, Rect>,
  newRects: ReadonlyMap<string, Rect>,
  opts: { splitFrom?: { panelId: string; newPanelId: string } } = {},
): FrameMove[] {
  const out: FrameMove[] = [];
  const split = opts.splitFrom;
  for (const f of frames) {
    if (f.panelId === null) continue;
    if (split && f.panelId === split.panelId) {
      const fresh = newRects.get(split.newPanelId);
      if (fresh && inside(fresh, { x: f.box.x + f.box.w / 2, y: f.box.y + f.box.h / 2 })) {
        out.push({ id: f.id, box: f.box, tail: f.tail, panelId: split.newPanelId });
      }
      continue;
    }
    const from = oldRects.get(f.panelId);
    const to = newRects.get(f.panelId);
    if (!from || !to || sameRect(from, to)) continue;
    if (from.w <= 0 || from.h <= 0 || to.w <= 0 || to.h <= 0) continue;
    const corner = mapPoint(f.box, from, to);
    const mapped: Box = { x: corner.x, y: corner.y, w: (f.box.w * to.w) / from.w, h: (f.box.h * to.h) / from.h };
    const box = clampBox(mapped);
    const tail = f.tail === null ? null : mapPoint(f.tail, from, to);
    const moved = tail === null ? null : { x: clamp01(tail.x + (box.x - mapped.x)), y: clamp01(tail.y + (box.y - mapped.y)) };
    if (sameBox(box, f.box) && samePoint(moved, f.tail)) continue;
    out.push({ id: f.id, box, tail: moved });
  }
  return out;
}

/** The frames with the moves applied (same order, untouched frames are the same objects). */
export function applyMoves(frames: readonly TextFrame[], moves: readonly FrameMove[]): TextFrame[] {
  if (moves.length === 0) return [...frames];
  const byId = new Map(moves.map((m) => [m.id, m]));
  return frames.map((f) => {
    const m = byId.get(f.id);
    if (!m) return f;
    return { ...f, box: m.box, tail: m.tail, ...(m.panelId === undefined ? {} : { panelId: m.panelId }) };
  });
}

/** The PATCH body of a move: only what differs from the frame. */
export function movePatch(frame: TextFrame, move: FrameMove): UpdateFrameBody {
  const patch: UpdateFrameBody = {};
  // Exact comparison (not EPS): a restore must put back the stored values, however small the difference.
  const { box: a, tail: t } = frame;
  if (a.x !== move.box.x || a.y !== move.box.y || a.w !== move.box.w || a.h !== move.box.h) patch.box = move.box;
  if (t === null || move.tail === null ? t !== move.tail : t.x !== move.tail.x || t.y !== move.tail.y) patch.tail = move.tail;
  if (move.panelId !== undefined && move.panelId !== frame.panelId) patch.panelId = move.panelId;
  return patch;
}

/** The moves that put frames back exactly as they were: their stored box and tail, never re-mapped. */
export function restoreMoves(frames: readonly TextFrame[]): FrameMove[] {
  return frames.map((f) => ({ id: f.id, box: f.box, tail: f.tail }));
}
