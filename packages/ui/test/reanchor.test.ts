import { describe, expect, it } from 'vitest';
import type { Rect } from '@manga/shared';
import { applyMoves, movePatch, reanchorFrames, restoreMoves } from '../src/editor/reanchor';
import { makeFrame } from './fixtures';

const rects = (entries: Record<string, Rect>): Map<string, Rect> => new Map(Object.entries(entries));

describe('reanchorFrames', () => {
  const oldRects = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 }, pn_b: { x: 0.55, y: 0.1, w: 0.35, h: 0.8 } });
  const newRects = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.2, h: 0.8 }, pn_b: { x: 0.35, y: 0.1, w: 0.55, h: 0.8 } });

  it('maps an anchored frame proportionally: box and tail', () => {
    const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, tail: { x: 0.25, y: 0.5 } });
    const [m] = reanchorFrames([f], oldRects, newRects);
    // x: 0.1 + (0.2 - 0.1) * 0.2 / 0.4 = 0.15, w: 0.2 * 0.5 = 0.1, y and h keep their size (same height).
    expect(m?.id).toBe('tf_1');
    expect(m?.box.x).toBeCloseTo(0.15, 12);
    expect(m?.box.y).toBeCloseTo(0.3, 12);
    expect(m?.box.w).toBeCloseTo(0.1, 12);
    expect(m?.box.h).toBeCloseTo(0.1, 12);
    expect(m?.tail?.x).toBeCloseTo(0.175, 12);
    expect(m?.tail?.y).toBeCloseTo(0.5, 12);
    expect(m?.panelId).toBeUndefined();
  });

  it('maps a frame of the growing panel too, each by its own panel', () => {
    const f = makeFrame('tf_2', 'pg_1', { panelId: 'pn_b', box: { x: 0.6, y: 0.2, w: 0.1, h: 0.1 }, tail: null });
    const [m] = reanchorFrames([f], oldRects, newRects);
    // x: 0.35 + (0.6 - 0.55) * 0.55 / 0.35, w: 0.1 * 0.55 / 0.35
    expect(m?.box.x).toBeCloseTo(0.35 + (0.05 * 0.55) / 0.35, 12);
    expect(m?.box.w).toBeCloseTo((0.1 * 0.55) / 0.35, 12);
    expect(m?.tail).toBeNull();
  });

  it('never moves an unanchored frame', () => {
    expect(reanchorFrames([makeFrame('tf_1', 'pg_1', { panelId: null })], oldRects, newRects)).toEqual([]);
  });

  it('does not move a frame whose panel is missing from either map', () => {
    const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_gone' });
    expect(reanchorFrames([f], oldRects, newRects)).toEqual([]);
    expect(reanchorFrames([makeFrame('tf_2', 'pg_1', { panelId: 'pn_a' })], oldRects, rects({ pn_b: newRects.get('pn_b') as Rect }))).toEqual([]);
  });

  it('does not return frames whose panel rect did not change', () => {
    const same = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 } });
    expect(reanchorFrames([makeFrame('tf_1', 'pg_1', { panelId: 'pn_a' })], oldRects, same)).toEqual([]);
  });

  it('clamps the box at the page edge and moves the tail by the same correction', () => {
    const wide = rects({ pn_a: { x: 0.5, y: 0.1, w: 0.4, h: 0.8 } });
    const grown = rects({ pn_a: { x: 0.5, y: 0.1, w: 0.8, h: 0.8 } });
    // The panel doubles in width beyond the page: the box (x 0.8 -> 1.1, w 0.2 -> 0.4) is pulled back to x = 0.6.
    const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.8, y: 0.2, w: 0.2, h: 0.1 }, tail: { x: 0.85, y: 0.35 } });
    const [m] = reanchorFrames([f], wide, grown);
    expect(m?.box.x).toBeCloseTo(0.6, 12);
    expect(m?.box.w).toBeCloseTo(0.4, 12);
    // The tail maps to x = 0.5 + 0.35 * 2 = 1.2 and the box's clamp moved it by -0.5 (1.1 -> 0.6), so it keeps the offset (0.1) the mapping gave it.
    expect(m?.tail?.x).toBeCloseTo(0.7, 12);
    expect((m?.tail?.x ?? 0) - (m?.box.x ?? 0)).toBeCloseTo(0.1, 12);
    expect(m?.tail?.y).toBeCloseTo(0.35, 12);
  });

  it('never shrinks a box below MIN_FRAME, and keeps a box that was already smaller', () => {
    const big = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
    const tiny = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.04, h: 0.04 } });
    const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, tail: { x: 0.35, y: 0.55 } });
    const [m] = reanchorFrames([f], big, tiny);
    // Proportional size would be 0.01; the floor is MIN_FRAME (0.02). The position and the tail still map proportionally.
    expect(m?.box.w).toBe(0.02);
    expect(m?.box.h).toBe(0.02);
    expect(m?.box.x).toBeCloseTo(0.1 + (0.2 * 0.04) / 0.8, 12);
    expect(m?.tail?.x).toBeCloseTo(0.1 + (0.25 * 0.04) / 0.8, 12);
    const small = makeFrame('tf_2', 'pg_1', { panelId: 'pn_a', box: { x: 0.3, y: 0.3, w: 0.01, h: 0.01 } });
    expect(reanchorFrames([small], big, tiny)[0]?.box).toMatchObject({ w: 0.01, h: 0.01 });
  });

  describe('a split', () => {
    const before = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
    const after = rects({ pn_a: { x: 0.1, y: 0.1, w: 0.8, h: 0.39 }, pn_n: { x: 0.1, y: 0.51, w: 0.8, h: 0.39 } });
    const opts = { splitFrom: { panelId: 'pn_a', newPanelId: 'pn_n' } };

    it('re-anchors a frame centred over the new half and leaves its box alone', () => {
      const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.2, y: 0.6, w: 0.3, h: 0.1 }, tail: { x: 0.25, y: 0.75 } });
      expect(reanchorFrames([f], before, after, opts)).toEqual([{ id: 'tf_1', box: f.box, tail: f.tail, panelId: 'pn_n' }]);
    });

    it('keeps a frame centred over the kept half on its panel', () => {
      const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.2, y: 0.2, w: 0.3, h: 0.1 } });
      expect(reanchorFrames([f], before, after, opts)).toEqual([]);
    });

    it('ignores the frames of other panels and unanchored ones', () => {
      const frames = [
        makeFrame('tf_1', 'pg_1', { panelId: null, box: { x: 0.2, y: 0.6, w: 0.3, h: 0.1 } }),
        makeFrame('tf_2', 'pg_1', { panelId: 'pn_other', box: { x: 0.2, y: 0.6, w: 0.3, h: 0.1 } }),
      ];
      expect(reanchorFrames(frames, before, after, opts)).toEqual([]);
    });
  });
});

describe('applyMoves, movePatch and restoreMoves', () => {
  const f = makeFrame('tf_1', 'pg_1', { panelId: 'pn_a', box: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, tail: { x: 0.25, y: 0.5 } });
  const g = makeFrame('tf_2', 'pg_1');

  it('applies moves by id and keeps untouched frames as they are', () => {
    const out = applyMoves([f, g], [{ id: 'tf_1', box: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, tail: null, panelId: 'pn_n' }]);
    expect(out[0]).toMatchObject({ box: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, tail: null, panelId: 'pn_n' });
    expect(out[1]).toBe(g);
  });

  it('a move without panelId keeps the anchor', () => {
    expect(applyMoves([f], [{ id: 'tf_1', box: f.box, tail: null }])[0]?.panelId).toBe('pn_a');
  });

  it('patches only what differs, exactly', () => {
    expect(movePatch(f, { id: 'tf_1', box: f.box, tail: f.tail })).toEqual({});
    expect(movePatch(f, { id: 'tf_1', box: { ...f.box, x: 0.2 + 1e-12 }, tail: f.tail })).toEqual({ box: { ...f.box, x: 0.2 + 1e-12 } });
    expect(movePatch(f, { id: 'tf_1', box: f.box, tail: null, panelId: 'pn_n' })).toEqual({ tail: null, panelId: 'pn_n' });
  });

  it('restoreMoves carries the stored box and tail', () => {
    expect(restoreMoves([f])).toEqual([{ id: 'tf_1', box: f.box, tail: f.tail }]);
  });
});
