import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, DEFAULT_TRANSFORM } from '@manga/shared';
import { printSizePx } from '../src/page/geometry';
import {
  dragFrameGeom, dragLabel, framesInOrder, geomPatch, ghostTailAt, rotateHandleAt, wheelZoom, imageFor, panelImageFilter, placeImage, printPpm, renderSize, sameTransform, usableSize,
} from '../src/page/pageModel';
import { makeDetail, makeFrame, makeImage, makePanel } from './fixtures';

describe('page model helpers', () => {
  it('orders frames by order, then id', () => {
    const frames = [makeFrame('tf_b', 'pg_1', { order: 1 }), makeFrame('tf_c', 'pg_1', { order: 0 }), makeFrame('tf_a', 'pg_1', { order: 1 })];
    expect(framesInOrder(frames).map((f) => f.id)).toEqual(['tf_c', 'tf_a', 'tf_b']);
  });

  it('finds the active image of a panel', () => {
    const detail = { ...makeDetail(), images: { im_1: makeImage('im_1') } };
    expect(imageFor(detail, makePanel('pn_a', 'pg_1', { activeImageId: 'im_1' }))?.id).toBe('im_1');
    expect(imageFor(detail, makePanel('pn_a', 'pg_1', { activeImageId: 'im_missing' }))).toBeNull();
    expect(imageFor(detail, makePanel('pn_a'))).toBeNull();
    expect(imageFor(detail, undefined)).toBeNull();
  });

  it('patches only the geometry that changed', () => {
    const before = { box: { x: 0, y: 0, w: 0.2, h: 0.1 }, tail: null, rotation: 0 };
    const moved = { ...before, box: { x: 0.1, y: 0, w: 0.2, h: 0.1 } };
    expect(geomPatch(before, moved)).toEqual({ before: { box: before.box }, after: { box: moved.box } });
    const tailed = { ...before, tail: { x: 0.5, y: 0.5 }, rotation: -10 };
    expect(geomPatch(before, tailed)).toEqual({ before: { tail: null, rotation: 0 }, after: { tail: { x: 0.5, y: 0.5 }, rotation: -10 } });
  });

  it('compares transforms', () => {
    expect(sameTransform(DEFAULT_TRANSFORM, { x: 0, y: 0, scale: 1 })).toBe(true);
    expect(sameTransform(DEFAULT_TRANSFORM, { x: 0.001, y: 0, scale: 1 })).toBe(false);
  });

  it('sizes the print route from the scale parameter', () => {
    expect(renderSize(DEFAULT_PAGE_FORMAT, null)).toEqual({ w: 2150, h: 3035 });
    expect(renderSize(DEFAULT_PAGE_FORMAT, '0.5')).toEqual({ w: 1075, h: 1518 });
    expect(renderSize(DEFAULT_PAGE_FORMAT, 'abc')).toEqual({ w: 2150, h: 3035 });
    expect(renderSize(DEFAULT_PAGE_FORMAT, '100')).toEqual(printSizePx(DEFAULT_PAGE_FORMAT, 4));
  });

  it('greys panel images of a black and white manga only', () => {
    expect(panelImageFilter('bw')).toBe('grayscale(1)');
    expect(panelImageFilter('color')).toBeUndefined();
  });

  it('measures px per mm at the full print resolution', () => {
    expect(printPpm(DEFAULT_PAGE_FORMAT)).toBeCloseTo(300 / 25.4, 2);
  });

  it('does not place an image whose natural size is not positive', () => {
    const box = { w: 400, h: 300 };
    expect(usableSize(makeImage('im_0', { width: 0, height: 0 }))).toBeNull();
    expect(usableSize(makeImage('im_1', { width: 100, height: 0 }))).toBeNull();
    expect(usableSize(makeImage('im_2', { width: Number.NaN, height: 10 }))).toBeNull();
    expect(usableSize(null)).toBeNull();
    expect(usableSize(makeImage('im_3', { width: 832, height: 1216 }))).toEqual({ w: 832, h: 1216 });
    expect(placeImage(box, makeImage('im_0', { width: 0, height: 0 }), DEFAULT_TRANSFORM)).toBeNull();
    expect(placeImage(box, null, DEFAULT_TRANSFORM)).toBeNull();
    const placed = placeImage(box, makeImage('im_3', { width: 832, height: 1216 }), DEFAULT_TRANSFORM);
    expect(placed).not.toBeNull();
    expect(Object.values(placed ?? {}).every(Number.isFinite)).toBe(true);
    expect(placed?.width).toBeCloseTo(400);
  });

  describe('frame drags', () => {
    const size = { w: 1000, h: 1000 };
    const start = { box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, tail: { x: 0.45, y: 0.6 }, rotation: 0 };
    const at = (x: number, y: number) => ({ x, y });

    it('moves the box and its tail by the same clamped delta', () => {
      const g = dragFrameGeom(start, 'move', at(0.5, 0.5), at(0.6, 0.55), size);
      expect(g.box.x).toBeCloseTo(0.5, 9);
      expect(g.box.y).toBeCloseTo(0.45, 9);
      expect(g.tail?.x).toBeCloseTo(0.55, 9);
      expect(g.tail?.y).toBeCloseTo(0.65, 9);
      const edge = dragFrameGeom(start, 'move', at(0.5, 0.5), at(2, 0.5), size);
      expect(edge.box.x).toBeCloseTo(0.8, 9);
      expect(edge.tail?.x).toBeCloseTo(0.85, 9);
      expect(dragFrameGeom({ ...start, tail: null }, 'move', at(0, 0), at(0.1, 0), size).tail).toBeNull();
    });

    it('resizes a corner inside the page and leaves the tail alone', () => {
      const g = dragFrameGeom(start, 'se', at(0.6, 0.5), at(5, 5), size);
      expect(g.box).toEqual({ x: 0.4, y: 0.4, w: 0.6, h: 0.6 });
      expect(g.tail).toEqual(start.tail);
    });

    it('places the tail at the pointer, on the page, and rotates around the box centre', () => {
      expect(dragFrameGeom(start, 'tail', at(0, 0), at(0.7, 1.4), size).tail).toEqual({ x: 0.7, y: 1 });
      expect(dragFrameGeom(start, 'rotate', at(0, 0), at(0.5, 0.2), size).rotation).toBe(0);
      expect(dragFrameGeom(start, 'rotate', at(0, 0), at(0.9, 0.45), size).rotation).toBe(90);
    });

    it('labels each drag for the undo history', () => {
      expect(['move', 'nw', 'se', 'tail', 'rotate'].map((h) => dragLabel(h as never))).toEqual(
        ['Move frame', 'Resize frame', 'Resize frame', 'Move tail', 'Rotate frame']);
    });
  });

  describe('handles at the page edge', () => {
    const size = { w: 1000, h: 1000 };
    it('puts the rotate handle above the box, or below it on the top edge', () => {
      expect(rotateHandleAt({ x: 400, y: 300, w: 200, h: 100 }, size)).toEqual({ x: 500, y: 282 });
      expect(rotateHandleAt({ x: 400, y: 10, w: 200, h: 100 }, size)).toEqual({ x: 500, y: 128 });
      expect(rotateHandleAt({ x: 0, y: 0, w: 1000, h: 1000 }, size)).toEqual({ x: 500, y: 1000 });
    });
    it('starts the ghost tail below the box, or above it on the bottom edge', () => {
      const mid = ghostTailAt({ x: 0.4, y: 0.3, w: 0.2, h: 0.1 }, size);
      expect(mid.x).toBeCloseTo(460, 6);
      expect(mid.y).toBeCloseTo(440, 6);
      const bottom = ghostTailAt({ x: 0.4, y: 0.9, w: 0.2, h: 0.1 }, size);
      expect(bottom.x).toBeCloseTo(460, 6);
      expect(bottom.y).toBeCloseTo(860, 6);
      expect(ghostTailAt({ x: 0, y: 0, w: 1, h: 1 }, size).y).toBe(0);
    });
  });

  describe('wheel zoom', () => {
    const panel = { w: 400, h: 300 };
    const image = { w: 800, h: 600 };
    it('zooms in on a negative delta and out on a positive one', () => {
      expect(wheelZoom(DEFAULT_TRANSFORM, -100, panel, image).scale).toBeCloseTo(Math.exp(0.15), 9);
      expect(wheelZoom({ x: 0, y: 0, scale: 2 }, 100, panel, image).scale).toBeCloseTo(2 * Math.exp(-0.15), 9);
    });
    it('accumulates when fed its own result, and stays within the scale limits', () => {
      const once = wheelZoom(DEFAULT_TRANSFORM, -100, panel, image);
      const twice = wheelZoom(once, -100, panel, image);
      expect(twice.scale).toBeCloseTo(Math.exp(0.3), 9);
      expect(wheelZoom(DEFAULT_TRANSFORM, 10000, panel, image).scale).toBe(1);
      expect(wheelZoom({ x: 0, y: 0, scale: 8 }, -10000, panel, image).scale).toBe(8);
    });
  });
});
