import { useMemo, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { TextFrame } from '@manga/shared';
import { canRotate, defaultTail, hasTail } from '../editor/frameDrag';
import { cx } from '../lib/cx';
import { shapeFor, textBox } from './bubbles';
import { startDrag } from './drag';
import { FrameHandles } from './FrameHandles';
import { FrameShape } from './FrameShape';
import { FrameText } from './FrameText';
import type { SizePx } from './geometry';
import { dragFrameGeom, dragLabel, geomPatch, type FrameGeom, type FrameHandle } from './pageModel';
import { useLiveOverride } from './useLiveOverride';

export interface FrameViewProps {
  frame: TextFrame;
  size: SizePx;
  ppm: number;
  /** Pixels per mm at full print DPI (FrameText fits the text at this scale). */
  printPpm: number;
  mode: 'edit' | 'thumb' | 'print';
  selected: boolean;
  toNorm(e: { clientX: number; clientY: number }): { x: number; y: number };
  onSelect?(frameId: string): void;
  /** Called once when a drag ends with a change; returns false when nothing will be committed (so the live value is dropped). */
  onCommit?(frame: TextFrame, before: FrameGeom, after: FrameGeom, label: string): boolean;
}

const STROKE_MM = 0.35;

export function FrameView({ frame, size, ppm, printPpm, mode, selected, toNorm, onSelect, onCommit }: FrameViewProps): JSX.Element {
  const committed = useMemo<FrameGeom>(() => ({ box: frame.box, tail: frame.tail, rotation: frame.rotation }), [frame.box, frame.tail, frame.rotation]);
  const live = useLiveOverride(committed);
  const g = live.value;
  const box = { x: g.box.x * size.w, y: g.box.y * size.h, w: g.box.w * size.w, h: g.box.h * size.h };
  const tip = hasTail(frame.kind) && g.tail ? { x: g.tail.x * size.w, y: g.tail.y * size.h } : null;
  const ghost = defaultTail(g.box);
  const shapes = shapeFor(frame.kind, box, tip);
  const rotate = canRotate(frame.kind) && g.rotation !== 0 ? `rotate(${g.rotation}deg)` : undefined;

  const drag = (e: ReactPointerEvent, handle: FrameHandle): void => {
    if (e.button !== 0) return;
    onSelect?.(frame.id);
    const start = g;
    const p0 = toNorm(e);
    live.begin();
    startDrag(e, {
      move: (ev) => live.update(dragFrameGeom(start, handle, p0, toNorm(ev), size)),
      end: (ok) => {
        const end = live.end();
        const changed = end !== null && Object.keys(geomPatch(start, end).after).length > 0;
        if (!ok || !end || !changed) { live.cancel(); return; }
        if (!onCommit?.(frame, start, end, dragLabel(handle))) live.cancel();
      },
    });
  };

  const edit = mode === 'edit';
  return (
    <div className={cx('frame', selected && 'is-selected')} data-frame-id={frame.id} data-kind={frame.kind}>
      {(shapes.paths.length > 0 || shapes.circles.length > 0) && (
        <FrameShape paths={shapes.paths} circles={shapes.circles} strokePx={Math.max(STROKE_MM * ppm, 0.6)} size={size} />
      )}
      <FrameText frame={{ ...frame, rotation: g.rotation }} box={textBox(frame.kind, box)} ppm={ppm} printPpm={printPpm} mode={mode} />
      {edit && (
        <div className="frame__hit" style={{ left: box.x, top: box.y, width: box.w, height: box.h, ...(rotate ? { transform: rotate } : {}) }}
          onPointerDown={(e) => drag(e, 'move')} />
      )}
      {edit && selected && (
        <FrameHandles box={box} tip={tip} ghostTip={{ x: ghost.x * size.w, y: ghost.y * size.h }} kind={frame.kind} rotation={g.rotation} onHandle={drag} />
      )}
    </div>
  );
}
