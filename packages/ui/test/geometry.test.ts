import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_FORMAT, DEFAULT_TRANSFORM } from '@manga/shared';
import { clampTransform, coverFit, pageSizePx, panBy, panLimits, printSizePx, ptToPx, pxPerMm, rectPx, zoomBy } from '../src/page/geometry';

describe('page size', () => {
  it('matches the spec print size for B5 at 300 dpi', () => {
    expect(printSizePx(DEFAULT_PAGE_FORMAT)).toEqual({ w: 2150, h: 3035 });
    expect(pageSizePx(DEFAULT_PAGE_FORMAT, 2150)).toEqual({ w: 2150, h: 3035 });
  });
  it('scales the height for screen widths', () => {
    expect(pageSizePx(DEFAULT_PAGE_FORMAT, 400)).toEqual({ w: 400, h: 565 });
    expect(printSizePx(DEFAULT_PAGE_FORMAT, 0.5)).toEqual({ w: 1075, h: 1518 });
  });
  it('converts points to pixels', () => {
    expect(pxPerMm(DEFAULT_PAGE_FORMAT, 364)).toBe(2);
    expect(ptToPx(72, 1)).toBeCloseTo(25.4, 6);
    expect(ptToPx(9, 300 / 25.4)).toBeCloseTo(37.5, 6);
  });
  it('maps normalized rects to pixels', () => {
    expect(rectPx({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, { w: 200, h: 400 })).toEqual({ left: 20, top: 80, width: 100, height: 100 });
  });
});

describe('cover-fit', () => {
  const panel = { w: 100, h: 200 };
  const square = { w: 100, h: 100 };
  it('covers the panel at scale 1, centred', () => {
    expect(coverFit(panel, square, DEFAULT_TRANSFORM)).toEqual({ width: 200, height: 200, left: -50, top: 0 });
  });
  it('applies offset and zoom', () => {
    expect(coverFit(panel, square, { x: 0.25, y: 0, scale: 1 }).left).toBe(-25);
    expect(coverFit(panel, square, { x: 0, y: 0, scale: 2 })).toEqual({ width: 400, height: 400, left: -150, top: -100 });
  });
  it('computes pan limits in panel units', () => {
    expect(panLimits(0.5, 1, 1)).toEqual({ x: 0.5, y: 0 });
    expect(panLimits(1, 1, 2)).toEqual({ x: 0.5, y: 0.5 });
  });
  it('clamps scale to 1..8 and offsets to the limits', () => {
    expect(clampTransform({ x: 5, y: -5, scale: 20 }, 0.5, 1)).toEqual({ x: 5, y: -3.5, scale: 8 });
    expect(clampTransform({ x: 1, y: 1, scale: 0.2 }, 1, 1)).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it('clamps pan so the panel stays covered', () => {
    const tall = { w: 100, h: 300 };
    const pano = { w: 1536, h: 640 };
    let t = DEFAULT_TRANSFORM;
    const moves: Array<[number, number, number]> = [[1000, 50, 1], [-5000, -80, 1.7], [30, 900, 0.4], [-12, -12, 3], [4000, 4000, 0.1]];
    for (const [dx, dy, zoom] of moves) {
      t = zoomBy(panBy(t, dx, dy, tall, pano), zoom, tall, pano);
      const p = coverFit(tall, pano, t);
      expect(p.left).toBeLessThanOrEqual(1e-9);
      expect(p.top).toBeLessThanOrEqual(1e-9);
      expect(p.left + p.width).toBeGreaterThanOrEqual(tall.w - 1e-9);
      expect(p.top + p.height).toBeGreaterThanOrEqual(tall.h - 1e-9);
      expect(t.scale).toBeGreaterThanOrEqual(1);
      expect(t.scale).toBeLessThanOrEqual(8);
    }
  });
});
