import { useMemo, type JSX } from 'react';
import type { PageFormat, ReadingDirection } from '@manga/shared';
import { presetRects } from './presets';

const W = 44;

export function PresetPreview({ name, dir, format }: { name: string; dir: ReadingDirection; format: PageFormat }): JSX.Element {
  const rects = useMemo(() => presetRects(name, dir, format), [name, dir, format]);
  const h = Math.round((W * format.heightMm) / format.widthMm);
  return (
    <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} className="preset__svg" aria-hidden>
      <rect x="0.5" y="0.5" width={W - 1} height={h - 1} className="preset__page" />
      {rects.map((r, i) => <rect key={i} x={r.x * W} y={r.y * h} width={r.w * W} height={r.h * h} className="preset__panel" />)}
    </svg>
  );
}
