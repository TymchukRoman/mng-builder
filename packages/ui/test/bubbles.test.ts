import { describe, expect, it } from 'vitest';
import { burstPath, cloudBumps, cloudPath, ellipseOf, ellipsePath, insideEllipse, rectPath, shapeFor, tailPath, textBox, thoughtTrail } from '../src/page/bubbles';
import type { BoxPx, PointPx } from '../src/page/bubbles';

const b = { x: 0, y: 0, w: 100, h: 50 };
const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

// SVG arc endpoint->center parameterization, with radii auto-scaled per spec
function arcPts(x1: number, y1: number, rx: number, ry: number, large: number, sweep: number, x2: number, y2: number, n = 40): PointPx[] {
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = dx, y1p = dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1p / rx) ** 2 + (y1p / ry) ** 2;
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = -(co * ry * x1p) / rx;
  const cx = cxp + (x1 + x2) / 2, cy = cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const out: PointPx[] = [];
  for (let i = 0; i <= n; i++) {
    const t = th1 + (dth * i) / n;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}

// Parse cloud path to polygon (expands arcs using SVG spec)
function cloudPoly(d: string): PointPx[] {
  const m = d.match(/^M ([-\d.]+) ([-\d.]+)/);
  if (!m) return [];
  let cur = { x: parseFloat(m[1]!), y: parseFloat(m[2]!) };
  const poly = [cur];
  for (const a of d.matchAll(/A ([-\d.]+) ([-\d.]+) 0 (\d) (\d) ([-\d.]+) ([-\d.]+)/g)) {
    const seg = arcPts(cur.x, cur.y, +a[1]!, +a[2]!, +a[3]!, +a[4]!, +a[5]!, +a[6]!);
    poly.push(...seg.slice(1));
    cur = { x: +a[5]!, y: +a[6]! };
  }
  return poly;
}

// Parse burst path to polygon (simple line segments)
function burstPoly(d: string): PointPx[] {
  const coords = nums(d);
  const v: PointPx[] = [];
  for (let i = 0; i < coords.length; i += 2) {
    v.push({ x: coords[i]!, y: coords[i + 1]! });
  }
  return v;
}

// Ray-casting point-in-polygon test
function pointInPolygon(p: PointPx, poly: PointPx[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    const intersect = (a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

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
    const speechBox = textBox('speech', b);
    expect(speechBox).toEqual({ x: 15, y: 7.5, w: 70, h: 35 });
    const thoughtBox = textBox('thought', b);
    expect(thoughtBox).toEqual({ x: 23, y: 11.5, w: 54, h: 27 });
    const shoutBox = textBox('shout', b);
    expect(shoutBox).toEqual({ x: 24, y: 12, w: 52, h: 26 });
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

describe('strict geometry (through shapeFor)', () => {
  it('tail base corners inside speech ellipse in 36 directions across 3 aspect ratios', () => {
    const aspects: [number, number][] = [[100, 100], [300, 60], [60, 300]];
    for (const [w, h] of aspects) {
      const box = { x: 10, y: 20, w, h };
      const { cx, cy, rx, ry } = ellipseOf(box);
      let outside = 0;
      for (let k = 0; k < 360; k++) {
        const angle = (k * Math.PI) / 180;
        const tip = { x: cx + rx * 3 * Math.cos(angle), y: cy + ry * 3 * Math.sin(angle) };
        const shape = shapeFor('speech', box, tip);
        if (shape.paths.length > 1) {
          const tailD = shape.paths[1]!;
          const coords = nums(tailD);
          const pts = [{ x: coords[0]!, y: coords[1]! }, { x: coords[4]!, y: coords[5]! }];
          for (const pt of pts) {
            if (!insideEllipse(box, pt)) outside++;
          }
        }
      }
      expect(outside).toBe(0);
    }
  });

  it('tail base corners inside shout burst in 36 directions across 3 aspect ratios', () => {
    const aspects: [number, number][] = [[100, 100], [300, 60], [60, 300]];
    for (const [w, h] of aspects) {
      const box = { x: 10, y: 20, w, h };
      const { cx, cy, rx, ry } = ellipseOf(box);
      const burstD = burstPath(box);
      const burst = burstPoly(burstD);
      let outside = 0;
      for (let k = 0; k < 360; k++) {
        const angle = (k * Math.PI) / 180;
        const tip = { x: cx + rx * 3 * Math.cos(angle), y: cy + ry * 3 * Math.sin(angle) };
        const shape = shapeFor('shout', box, tip);
        if (shape.paths.length > 1) {
          const tailD = shape.paths[1]!;
          const coords = nums(tailD);
          const pts = [{ x: coords[0]!, y: coords[1]! }, { x: coords[4]!, y: coords[5]! }];
          for (const pt of pts) {
            if (!pointInPolygon(pt, burst)) outside++;
          }
        }
      }
      expect(outside).toBe(0);
    }
  });

  it('textBox corners inside expanded paths across 4 aspect ratios', () => {
    const aspects: [number, number][] = [[100, 100], [300, 60], [60, 300], [1000, 50]];
    for (const [w, h] of aspects) {
      const box = { x: 10, y: 20, w, h };
      for (const kind of ['speech', 'thought', 'shout'] as const) {
        const tb = textBox(kind, box);
        const corners = [
          { x: tb.x, y: tb.y },
          { x: tb.x + tb.w, y: tb.y },
          { x: tb.x, y: tb.y + tb.h },
          { x: tb.x + tb.w, y: tb.y + tb.h },
        ];

        for (const corner of corners) {
          if (kind === 'speech') {
            expect(insideEllipse(box, corner)).toBe(true);
          } else if (kind === 'thought') {
            const poly = cloudPoly(cloudPath(box));
            expect(pointInPolygon(corner, poly)).toBe(true);
          } else {
            const poly = burstPoly(burstPath(box));
            expect(pointInPolygon(corner, poly)).toBe(true);
          }
        }
      }
    }
  });

  it('cloud expanded bbox exceeds frame by at most 10% of short side', () => {
    const aspects: [number, number][] = [[100, 100], [300, 60], [60, 300], [1000, 50], [50, 300]];
    for (const [w, h] of aspects) {
      const box = { x: 0, y: 0, w, h };
      const poly = cloudPoly(cloudPath(box));
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      const overshootX = Math.max(-Math.min(...xs), Math.max(...xs) - w, 0);
      const overshootY = Math.max(-Math.min(...ys), Math.max(...ys) - h, 0);
      const maxOvershoot = Math.max(overshootX, overshootY);
      const allowedOvershoot = Math.min(w, h) * 0.1;
      expect(maxOvershoot).toBeLessThanOrEqual(allowedOvershoot);
    }
  });

  it('paths are closed and deterministic', () => {
    expect(ellipsePath(b)).toMatch(/Z$/);
    expect(cloudPath(b)).toMatch(/Z$/);
    expect(burstPath(b)).toMatch(/Z$/);
    expect(rectPath(b)).toMatch(/Z$/);
    expect(cloudPath(b)).toBe(cloudPath(b));
    expect(burstPath(b)).toBe(burstPath(b));
  });
});
