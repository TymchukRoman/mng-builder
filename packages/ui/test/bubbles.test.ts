import { describe, expect, it } from 'vitest';
import { burstPath, cloudBumps, cloudPath, ellipseOf, ellipsePath, insideEllipse, rectPath, shapeFor, tailPath, textBox, thoughtTrail } from '../src/page/bubbles';

const b = { x: 0, y: 0, w: 100, h: 50 };
const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('ellipse', () => {
  it('is inscribed in the box', () => {
    expect(ellipseOf(b)).toEqual({ cx: 50, cy: 25, rx: 50, ry: 25 });
    expect(ellipsePath(b)).toBe('M 0 25 A 50 25 0 1 0 100 25 A 50 25 0 1 0 0 25 Z');
    expect(insideEllipse(b, { x: 50, y: 25 })).toBe(true);
    expect(insideEllipse(b, { x: 99, y: 49 })).toBe(false);
  });
});

describe('tail', () => {
  it('points at the tip from a base buried inside the ellipse', () => {
    const [x1, y1, tx, ty, x2, y2] = nums(tailPath(b, { x: 50, y: 100 }));
    expect([tx, ty]).toEqual([50, 100]);
    expect(x1).toBeCloseTo(59.27, 1);
    expect(y1).toBeCloseTo(45.74, 1);
    expect(x2).toBeCloseTo(40.73, 1);
    expect(y2).toBeCloseTo(45.74, 1);
    expect(insideEllipse(b, { x: x1 ?? 0, y: y1 ?? 0 })).toBe(true);
  });
  it('is empty when the tip is inside the bubble', () => {
    expect(tailPath(b, { x: 50, y: 30 })).toBe('');
  });
});

describe('cloud and trail', () => {
  it('picks more bumps for elongated boxes', () => {
    expect(cloudBumps({ x: 0, y: 0, w: 60, h: 60 })).toBe(9);
    expect(cloudBumps({ x: 0, y: 0, w: 150, h: 50 })).toBe(15);
    expect(cloudBumps({ x: 0, y: 0, w: 1000, h: 50 })).toBe(16);
  });
  it('draws one outward arc per bump and closes', () => {
    const d = cloudPath(b, 10);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(d.match(/ A /g)).toHaveLength(10);
    expect(d).toContain(' 0 0 1 ');
  });
  it('trails three shrinking circles towards the tip', () => {
    expect(thoughtTrail(b, null)).toEqual([]);
    expect(thoughtTrail(b, { x: 50, y: 30 })).toEqual([]);
    const trail = thoughtTrail(b, { x: 50, y: 100 });
    expect(trail).toHaveLength(3);
    expect(trail[0]!.r).toBeGreaterThan(trail[1]!.r);
    expect(trail[1]!.r).toBeGreaterThan(trail[2]!.r);
    expect(trail[2]!.cy).toBeGreaterThan(trail[0]!.cy);
    expect(trail[2]!.cy).toBeLessThan(100);
  });
});

describe('burst and rect', () => {
  it('alternates 2 × spikes points', () => {
    const d = burstPath(b, 14);
    expect(d.match(/ L /g)).toHaveLength(27);
    const [x0, y0] = nums(d);
    expect([x0, y0]).toEqual([50, 0]);
  });
  it('draws the narration box', () => {
    expect(rectPath({ x: 1, y: 2, w: 3, h: 4 })).toBe('M 1 2 H 4 V 6 H 1 Z');
  });
});

describe('per-kind helpers', () => {
  it('computes the text area per kind', () => {
    expect(textBox('speech', b)).toEqual({ x: 15, y: 7.5, w: 70, h: 35 });
    expect(textBox('narration', b)).toEqual({ x: 4, y: 4, w: 92, h: 42 });
    expect(textBox('sfx', b)).toEqual(b);
    expect(textBox('title', b)).toEqual(b);
  });
  it('lists the shapes to draw', () => {
    expect(shapeFor('speech', b, null).paths).toHaveLength(1);
    expect(shapeFor('speech', b, { x: 50, y: 100 }).paths).toHaveLength(2);
    expect(shapeFor('thought', b, { x: 50, y: 100 }).circles).toHaveLength(3);
    expect(shapeFor('shout', b, null).paths).toHaveLength(1);
    expect(shapeFor('narration', b, null).paths).toEqual(['M 0 0 H 100 V 50 H 0 Z']);
    expect(shapeFor('sfx', b, { x: 1, y: 1 })).toEqual({ paths: [], circles: [] });
  });
});
