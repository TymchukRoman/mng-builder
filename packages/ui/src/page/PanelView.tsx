import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_TRANSFORM, type Image, type ImageTransform, type Panel } from '@manga/shared';
import { imageUrl } from '../api';
import { cx } from '../lib/cx';
import { IconButton } from '../ui/IconButton';
import { Check, RotateCcw, TriangleAlert } from '../ui/icons';
import { startDrag } from './drag';
import { panBy, type Placement } from './geometry';
import { panelImageView, placeImage, sameTransform, usableSize, wheelZoom } from './pageModel';
import { useLiveOverride } from './useLiveOverride';

export interface PanelViewProps {
  panelId: string;
  panel: Panel | undefined;
  image: Image | null;
  rect: Placement;
  borderPx: number;
  mode: 'edit' | 'thumb' | 'print';
  /** CSS filter for the panel image (`panelImageFilter`); the border and chrome are never filtered. */
  imageFilter: string | undefined;
  selected: boolean;
  mergeCandidate: boolean;
  adjusting: boolean;
  onPointerDown?(e: ReactPointerEvent, panelId: string): void;
  onDoubleClick?(panelId: string): void;
  onExitAdjust?(panelId: string): void;
  /** Returns false when nothing will be committed (so the live value is dropped instead of kept on screen). */
  onTransform?(panelId: string, before: ImageTransform, after: ImageTransform): boolean;
}

/** Plain CSS cover: what an image shows until its natural size is known (identical to the default transform). */
const CSS_COVER: CSSProperties = { left: 0, top: 0, width: '100%', height: '100%', objectFit: 'cover' };

export function PanelView(p: PanelViewProps): JSX.Element {
  const { panelId, panel, image, rect, borderPx, mode, imageFilter, selected, mergeCandidate, adjusting } = p;
  const committed = panel?.imageTransform ?? DEFAULT_TRANSFORM;
  const live = useLiveOverride(committed);
  const t = live.value;
  const box = { w: rect.width, h: rect.height };
  const natural = usableSize(image);
  const placed = placeImage(box, image, t);
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ t, natural, box, props: p });
  useLayoutEffect(() => { latest.current = { t, natural, box, props: p }; });

  // Wheel zoom in adjust mode: a native, non-passive listener so preventDefault stops page scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el || !adjusting) return;
    let start: ImageTransform | null = null;
    // The latest computed transform. Set synchronously in the handler, so two wheel events between renders both count.
    let current: ImageTransform | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      clearTimeout(timer);
      const s = start;
      start = null;
      current = null;
      const end = live.end();
      if (!(s && end && !sameTransform(s, end) && latest.current.props.onTransform?.(panelId, s, end))) live.cancel();
    };
    const onWheel = (e: WheelEvent): void => {
      const { t: rendered, natural: size, box: b } = latest.current;
      if (!size) return;
      e.preventDefault();
      if (!start) { start = rendered; live.begin(); }
      current = wheelZoom(current ?? rendered, e.deltaY, b, size);
      live.update(current);
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (start) flush();
    };
    // `live` methods only touch refs and a stable setter, so the first render's closure stays valid.
  }, [adjusting, panelId]);

  const onDown = (e: ReactPointerEvent): void => {
    if (adjusting && natural) {
      if (e.button !== 0) return;
      const start = t;
      const sx = e.clientX;
      const sy = e.clientY;
      live.begin();
      startDrag(e, {
        move: (ev) => live.update(panBy(start, ev.clientX - sx, ev.clientY - sy, box, natural)),
        end: (ok) => {
          const end = live.end();
          if (!ok || !end || sameTransform(end, start) || !p.onTransform?.(panelId, start, end)) live.cancel();
        },
      });
      return;
    }
    p.onPointerDown?.(e, panelId);
  };

  const edit = mode === 'edit';
  // Keyed by URL, so a new active image gets its own chance to load.
  const src = image ? imageUrl(image.id) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const view = panelImageView(src !== null, src !== null && failedSrc === src, mode);
  const imgStyle: CSSProperties = {
    ...(placed ? { left: placed.left, top: placed.top, width: placed.width, height: placed.height } : CSS_COVER),
    ...(imageFilter ? { filter: imageFilter } : {}),
  };
  return (
    <div
      ref={ref}
      className={cx('panel', view.empty && 'panel--empty', adjusting && 'is-adjusting')}
      data-panel-id={panelId}
      data-selected={selected || undefined}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerDown={edit ? onDown : undefined}
      onDoubleClick={edit && image ? () => p.onDoubleClick?.(panelId) : undefined}
    >
      {view.showImage && src && (
        <img className="panel__img" src={src} alt="" draggable={false} style={imgStyle} onError={mode === 'print' ? undefined : () => setFailedSrc(src)} />
      )}
      {view.badge && <span className="panel__broken" role="img" aria-label="Image failed to load" data-tip="Image failed to load"><TriangleAlert size={14} aria-hidden /></span>}
      <div className="panel__border" style={{ borderWidth: borderPx }} />
      {edit && (selected || mergeCandidate) && <div className={cx('panel__sel', mergeCandidate && 'panel__sel--merge')} />}
      {edit && adjusting && (
        <div className="panel__tools" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton icon={RotateCcw} size="sm" label="Reset image position" disabled={sameTransform(t, DEFAULT_TRANSFORM)}
            onClick={() => p.onTransform?.(panelId, t, DEFAULT_TRANSFORM)} />
          <IconButton icon={Check} size="sm" label="Done adjusting (Esc)" onClick={() => p.onExitAdjust?.(panelId)} />
        </div>
      )}
    </div>
  );
}
