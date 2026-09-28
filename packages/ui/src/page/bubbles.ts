import type { FrameKind } from '@manga/shared';

/** Box in page pixels. BoxSchema guarantees w, h > 0. */
export interface BoxPx { x: number; y: number; w: number; h: number }
export interface PointPx { x: number; y: number }
export interface Circle { cx: number; cy: number; r: number }

const f = (n: number): string => String(Math.round(n * 100) / 100);

export function ellipseOf(b: BoxPx): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 };
}

export function insideEllipse(b: BoxPx, p: PointPx): boolean {
  const { cx, cy, rx, ry } = ellipseOf(b);
  return ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1;
}

export function ellipsePath(b: BoxPx): string {
  const { cx, cy, rx, ry } = ellipseOf(b);
  return `M ${f(cx - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;
}

function angleTo(b: BoxPx, p: PointPx): number {
  const { cx, cy, rx, ry } = ellipseOf(b);
  return Math.atan2((p.y - cy) / ry, (p.x - cx) / rx);
}

export function tailPath(b: BoxPx, tip: PointPx, halfAngle = 0.22, inset = 0.85): string {
  if (insideEllipse(b, tip)) return '';
  const { cx, cy, rx, ry } = ellipseOf(b);
  const theta = angleTo(b, tip);
  const at = (a: number): PointPx => ({ x: cx + rx * inset * Math.cos(a), y: cy + ry * inset * Math.sin(a) });
  const p1 = at(theta - halfAngle);
  const p2 = at(theta + halfAngle);
  return `M ${f(p1.x)} ${f(p1.y)} L ${f(tip.x)} ${f(tip.y)} L ${f(p2.x)} ${f(p2.y)} Z`;
}

export function cloudBumps(b: BoxPx): number {
  const aspect = Math.max(b.w, b.h) / Math.min(b.w, b.h);
  return Math.min(16, 9 + Math.round((aspect - 1) * 3));
}

export function cloudPath(b: BoxPx, bumps = cloudBumps(b)): string {
  const { cx, cy, rx, ry } = ellipseOf(b);
  const pts: PointPx[] = Array.from({ length: bumps }, (_, i) => {
    const a = (2 * Math.PI * i) / bumps;
    return { x: cx + rx * 0.82 * Math.cos(a), y: cy + ry * 0.82 * Math.sin(a) };
  });
  const first = pts[0] ?? { x: cx, y: cy };
  let d = `M ${f(first.x)} ${f(first.y)}`;
  // Sagitta-based radius: r = (c²/4 + s²) / (2s) where c = chord, s = bulge.
  // This ensures r ≥ c/2 so SVG never rescales the arc.
  // Let s = min(0.35 * chord, 0.08 * min(w, h)): round bumps on normal, flat on thin boxes.
  const minSide = Math.min(b.w, b.h);
  for (let i = 0; i < bumps; i++) {
    const a = pts[i] ?? first;
    const c = pts[(i + 1) % bumps] ?? first;
    const chord = Math.hypot(c.x - a.x, c.y - a.y);
    const sagitta = Math.min(0.35 * chord, 0.08 * minSide);
    const r = (chord * chord / 4 + sagitta * sagitta) / (2 * sagitta);
    d += ` A ${f(r)} ${f(r)} 0 0 1 ${f(c.x)} ${f(c.y)}`;
  }
  return `${d} Z`;
}

export function thoughtTrail(b: BoxPx, tip: PointPx | null): Circle[] {
  if (!tip || insideEllipse(b, tip)) return [];
  const { cx, cy, rx, ry } = ellipseOf(b);
  const theta = angleTo(b, tip);
  const edge = { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) };
  const base = Math.min(rx, ry);
  return ([[0.3, 0.16], [0.62, 0.11], [0.9, 0.07]] as const).map(([t, k]) => ({
    cx: edge.x + (tip.x - edge.x) * t,
    cy: edge.y + (tip.y - edge.y) * t,
    r: base * k,
  }));
}

export function burstPath(b: BoxPx, spikes = 14): string {
  const { cx, cy, rx, ry } = ellipseOf(b);
  const outer = [1, 0.9, 0.96];
  const pts: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    const k = i % 2 === 0 ? (outer[(i / 2) % outer.length] ?? 1) : 0.74;
    pts.push(`${f(cx + rx * k * Math.cos(a))} ${f(cy + ry * k * Math.sin(a))}`);
  }
  return `M ${pts.join(' L ')} Z`;
}

export function rectPath(b: BoxPx): string {
  return `M ${f(b.x)} ${f(b.y)} H ${f(b.x + b.w)} V ${f(b.y + b.h)} H ${f(b.x)} Z`;
}

function scaled(b: BoxPx, k: number): BoxPx {
  const w = b.w * k;
  const h = b.h * k;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

export function textBox(kind: FrameKind, b: BoxPx): BoxPx {
  switch (kind) {
    case 'speech': return scaled(b, 0.7);
    case 'thought': {
      // Cloud's minimum normalized radius is ~0.77 (valley between bumps).
      // k ≤ 0.77/√2 ≈ 0.545 keeps corners inside cloud.
      return scaled(b, 0.54);
    }
    case 'shout': {
      // Burst's inner ring at 0.74.
      // k ≤ 0.74/√2 ≈ 0.523 keeps corners inside burst.
      return scaled(b, 0.52);
    }
    case 'narration': {
      const pad = 0.08 * Math.min(b.w, b.h);
      return { x: b.x + pad, y: b.y + pad, w: b.w - 2 * pad, h: b.h - 2 * pad };
    }
    case 'sfx':
    case 'title':
      return b;
  }
}

export function shapeFor(kind: FrameKind, b: BoxPx, tip: PointPx | null): { paths: string[]; circles: Circle[] } {
  switch (kind) {
    case 'speech': {
      const withTail = (body: string): string[] => [body, ...(tip ? [tailPath(b, tip, 0.22, 0.85)] : [])].filter((d) => d !== '');
      return { paths: withTail(ellipsePath(b)), circles: [] };
    }
    case 'thought': return { paths: [cloudPath(b)], circles: thoughtTrail(b, tip) };
    case 'shout': {
      // Burst's inner ring is at 0.74; use 0.6 to keep tail base safely inside.
      const withTail = (body: string): string[] => [body, ...(tip ? [tailPath(b, tip, 0.22, 0.6)] : [])].filter((d) => d !== '');
      return { paths: withTail(burstPath(b)), circles: [] };
    }
    case 'narration': return { paths: [rectPath(b)], circles: [] };
    case 'sfx':
    case 'title':
      return { paths: [], circles: [] };
  }
}
