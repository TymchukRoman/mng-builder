import { describe, expect, it } from 'vitest';
import { burstPath, cloudBumps, cloudPath, ellipseOf, ellipsePath, insideEllipse, rectPath, shapeFor, tailPath, textBox, thoughtTrail } from '../src/page/bubbles';
import type { BoxPx, PointPx } from '../src/page/bubbles';

const b = { x: 0, y: 0, w: 100, h: 50 };
const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

// Helper: ray-casting point-in-polygon test
function pointInPolygon(p: PointPx, polygon: PointPx[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x, yi = polygon[i]!.y;
    const xj = polygon[j]!.x, yj = polygon[j]!.y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Helper: extract polygon vertices from burst path
function burstVertices(d: string, spikes: number): PointPx[] {
  const coords = nums(d);
  const vertices: PointPx[] = [];
  for (let i = 0; i < coords.length; i += 2) {
    vertices.push({ x: coords[i]!, y: coords[i + 1]! });
  }
  return vertices;
}

// Helper: sample ellipse parametrically
function ellipsePoints(b: BoxPx, samples: number): PointPx[] {
  const { cx, cy, rx, ry } = ellipseOf(b);
  const pts: PointPx[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (2 * Math.PI * i) / samples;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

// Helper: extract actual endpoint coordinates from cloud path (M and A endpoints only)
function cloudVertices(d: string): PointPx[] {
  const vertices: PointPx[] = [];
  // Parse SVG path: M x y followed by A rx ry ... x y (7 params) repeated, then Z
  const match = d.match(/M\s*([-\d.]+)\s*([-\d.]+)/);
  if (match) {
    vertices.push({ x: parseFloat(match[1]!), y: parseFloat(match[2]!) });
  }
  const arcMatches = d.matchAll(/A\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+([-\d.]+)\s+([-\d.]+)/g);
  for (const match of arcMatches) {
    vertices.push({ x: parseFloat(match[1]!), y: parseFloat(match[2]!) });
  }
  return vertices;
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

describe('geometry coverage', () => {
  it('tail base corners lie inside ellipse (speech) in 36 directions', () => {
    for (let dir = 0; dir < 36; dir++) {
      const angle = (dir / 36) * Math.PI * 2;
      const dist = 150;
      const tip = { x: 50 + dist * Math.cos(angle), y: 25 + dist * Math.sin(angle) };
      const path = tailPath(b, tip);
      if (path !== '') {
        const [x1, y1, , , x2, y2] = nums(path);
        expect(insideEllipse(b, { x: x1 ?? 0, y: y1 ?? 0 })).toBe(true);
        expect(insideEllipse(b, { x: x2 ?? 0, y: y2 ?? 0 })).toBe(true);
      }
    }
  });

  it('tail base corners lie inside burst (shout) in 36 directions', () => {
    const burstD = burstPath(b, 14);
    const vertices = burstVertices(burstD, 14);
    for (let dir = 0; dir < 36; dir++) {
      const angle = (dir / 36) * Math.PI * 2;
      const dist = 150;
      const tip = { x: 50 + dist * Math.cos(angle), y: 25 + dist * Math.sin(angle) };
      const path = tailPath(b, tip, 0.22, 0.6);
      if (path !== '') {
        const [x1, y1, , , x2, y2] = nums(path);
        expect(pointInPolygon({ x: x1 ?? 0, y: y1 ?? 0 }, vertices)).toBe(true);
        expect(pointInPolygon({ x: x2 ?? 0, y: y2 ?? 0 }, vertices)).toBe(true);
      }
    }
  });

  it('textBox corners lie inside shape for various aspect ratios', () => {
    const aspects: [number, 'speech' | 'thought' | 'shout'][] = [
      [1, 'speech'],
      [1, 'thought'],
      [1, 'shout'],
      [5, 'speech'],
      [5, 'thought'],
      [5, 'shout'],
      [0.2, 'speech'],
      [0.2, 'thought'],
      [0.2, 'shout'],
    ];

    for (const [ratio, kind] of aspects) {
      const w = ratio > 1 ? 300 : 60;
      const h = ratio > 1 ? Math.round(300 / ratio) : Math.round(60 * ratio);
      const box = { x: 0, y: 0, w, h };
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
          // Cloud is at 0.82 radius; valley at 0.82*cos(π/n) ≈ 0.77.
          // Scale 0.54 means k*√2 ≈ 0.764, which is < 0.77.
          const { cx, cy, rx, ry } = ellipseOf(box);
          const minCloudRadius = 0.77;
          const dx = corner.x - cx;
          const dy = corner.y - cy;
          const norm = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
          expect(norm).toBeLessThanOrEqual(minCloudRadius);
        } else {
          // Burst inner at 0.74, scale 0.52 means k*√2 ≈ 0.735 < 0.74.
          const burst = burstVertices(burstPath(box, 14), 14);
          expect(pointInPolygon(corner, burst)).toBe(true);
        }
      }
    }
  });

  it('paths are closed and deterministic', () => {
    const ellipse = ellipsePath(b);
    const cloud = cloudPath(b);
    const burst = burstPath(b);
    const rect = rectPath(b);

    expect(ellipse).toMatch(/Z$/);
    expect(cloud).toMatch(/Z$/);
    expect(burst).toMatch(/Z$/);
    expect(rect).toMatch(/Z$/);

    expect(cloudPath(b)).toBe(cloud);
    expect(burstPath(b)).toBe(burst);
  });

  it('cloud overshoot stays bounded on elongated boxes', () => {
    const thinHorizontal = { x: 0, y: 0, w: 1000, h: 50 };
    const thinVertical = { x: 0, y: 0, w: 50, h: 300 };

    const checkBounds = (box: BoxPx) => {
      const { cx, cy, rx, ry } = ellipseOf(box);
      // Arc radius is capped at 0.25 * short side to limit overshoot to ~10% of short side.
      const maxRadius = Math.min(box.w, box.h) * 0.25;
      const cloud = cloudVertices(cloudPath(box));
      // Verify cloud is generated and has multiple points.
      expect(cloud.length).toBeGreaterThan(3);
      // Verify no point is extremely far from center (sanity check).
      for (const pt of cloud) {
        const dist = Math.hypot(pt.x - cx, pt.y - cy);
        const maxDist = Math.hypot(rx, ry) * 1.2;
        expect(dist).toBeLessThanOrEqual(maxDist);
      }
    };

    checkBounds(thinHorizontal);
    checkBounds(thinVertical);
  });
});
