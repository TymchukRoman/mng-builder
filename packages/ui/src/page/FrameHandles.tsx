import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import type { FrameKind } from '@manga/shared';
import { canRotate, hasTail, type Handle } from '../editor/frameDrag';
import { cx } from '../lib/cx';
import type { BoxPx, PointPx } from './bubbles';
import type { FrameHandle } from './pageModel';

const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];

export function FrameHandles({ box, tip, ghostTip, rotateAt, kind, rotation, onHandle }: {
  box: BoxPx;
  /** The tail tip in page pixels, or null when the frame has no tail. */
  tip: PointPx | null;
  /** Where a first tail would start (`ghostTailAt`, in page pixels): shown as a ghost handle. */
  ghostTip: PointPx;
  /** Where the rotate handle sits (`rotateHandleAt`: above the box, or below it on the page's top edge). */
  rotateAt: PointPx;
  kind: FrameKind;
  rotation: number;
  onHandle(e: ReactPointerEvent, h: FrameHandle): void;
}): JSX.Element {
  const at = (h: Handle): PointPx => ({ x: h === 'nw' || h === 'sw' ? box.x : box.x + box.w, y: h === 'nw' || h === 'ne' ? box.y : box.y + box.h });
  const tailAt = hasTail(kind) ? (tip ?? ghostTip) : null;
  // Sfx and title frames rotate, so their handles rotate with the box around its centre.
  const turn = canRotate(kind) && rotation !== 0
    ? { transform: `rotate(${rotation}deg)`, transformOrigin: `${box.x + box.w / 2}px ${box.y + box.h / 2}px` }
    : undefined;
  return (
    <div className="frame__handles" style={turn}>
      <div className="frame__outline" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      {CORNERS.map((h) => (
        <div key={h} className={`handle handle--${h}`} data-handle={h} style={{ left: at(h).x, top: at(h).y }} onPointerDown={(e) => onHandle(e, h)} />
      ))}
      {tailAt && (
        <div className={cx('handle handle--tail', !tip && 'is-ghost')} data-handle="tail" data-tip={tip ? 'Drag the tail' : 'Drag to add a tail'}
          style={{ left: tailAt.x, top: tailAt.y }} onPointerDown={(e) => onHandle(e, 'tail')} />
      )}
      {canRotate(kind) && (
        <div className="handle handle--rotate" data-handle="rotate" data-tip={`Rotate (${rotation}°)`}
          style={{ left: rotateAt.x, top: rotateAt.y }} onPointerDown={(e) => onHandle(e, 'rotate')} />
      )}
    </div>
  );
}
