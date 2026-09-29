import type { JSX } from 'react';
import type { Circle } from './bubbles';
import type { SizePx } from './geometry';

/**
 * Two passes over the same shapes: a double-width stroke with a paper fill, then the fill alone.
 * The second pass covers the inner half of every stroke, so a tail and its bubble merge into one outline.
 * Paper and ink are the only literal colours allowed (print is never themed).
 */
export function FrameShape({ paths, circles, strokePx, size }: { paths: string[]; circles: Circle[]; strokePx: number; size: SizePx }): JSX.Element {
  const shapes = (
    <>
      {paths.map((d, i) => <path key={`p${i}`} d={d} />)}
      {circles.map((c, i) => <circle key={`c${i}`} cx={c.cx} cy={c.cy} r={c.r} />)}
    </>
  );
  return (
    <svg className="frame-shape" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden>
      <g fill="#fff" stroke="#111" strokeWidth={strokePx * 2} strokeLinejoin="round">{shapes}</g>
      <g fill="#fff" stroke="none">{shapes}</g>
    </svg>
  );
}
