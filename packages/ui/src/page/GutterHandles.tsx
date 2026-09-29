import { useMemo, type JSX } from 'react';
import { splitHandles, type LayoutNode, type PageFormat } from '@manga/shared';
import { pathKey, ratioFromPointer } from '../editor/layoutTree';
import { startDrag } from './drag';
import { rectPx, type SizePx } from './geometry';

type SplitPath = Array<'a' | 'b'>;
const HIT_PX = 10;

export function GutterHandles({ layout, format, size, toNorm, onStart, onDrag, onEnd }: {
  layout: LayoutNode; format: PageFormat; size: SizePx;
  toNorm(e: { clientX: number; clientY: number }): { x: number; y: number };
  onStart(): void;
  onDrag(path: SplitPath, ratio: number): void;
  /** `to` is null when the drag was cancelled or did not move. */
  onEnd(path: SplitPath, from: number, to: number | null): void;
}): JSX.Element {
  const handles = useMemo(() => splitHandles(layout, format), [layout, format]);
  return (
    <>
      {handles.map((h) => {
        const g = rectPx(h.gutter, size);
        const style = h.dir === 'v'
          ? { left: g.left + g.width / 2 - HIT_PX / 2, top: g.top, width: HIT_PX, height: g.height }
          : { left: g.left, top: g.top + g.height / 2 - HIT_PX / 2, width: g.width, height: HIT_PX };
        return (
          <div
            key={pathKey(h.path)}
            className={`gutter gutter--${h.dir}`}
            data-gutter={pathKey(h.path)}
            data-tip="Drag to resize"
            style={style}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const from = h.ratio;
              let last = from;
              onStart();
              startDrag(e, {
                move: (ev) => { last = ratioFromPointer(h, toNorm(ev)); onDrag(h.path, last); },
                end: (ok) => onEnd(h.path, from, ok && Math.abs(last - from) > 1e-4 ? last : null),
              });
            }}
          />
        );
      })}
    </>
  );
}
