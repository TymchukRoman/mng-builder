import { useCallback, useContext, useMemo, useRef, type JSX } from 'react';
import { computeRects, resizeSplit, type Manga, type PageDetail } from '@manga/shared';
import type { EditorCommand } from '../editor/commands';
import { OpsContext } from '../editor/OpsContext';
import { PAGE_SELECTION, clickPanel, frameSelection, panelSelection, type Selection } from '../editor/selection';
import { FrameView } from './FrameView';
import { GutterHandles } from './GutterHandles';
import { pageSizePx, pxPerMm, rectPx } from './geometry';
import { framesInOrder, geomPatch, imageFor, liveFrames, panelImageFilter, printPpm } from './pageModel';
import { PanelView } from './PanelView';
import { useLiveOverride } from './useLiveOverride';
import './page.css';

export interface PageViewProps {
  detail: PageDetail;
  manga: Manga;
  widthPx: number;
  mode: 'edit' | 'thumb' | 'print';
  selection?: Selection;
  onSelect?(s: Selection): void;
  onChange?(c: EditorCommand): void;
}

/** The one renderer for the editor canvas, thumbnails and the print route (spec §10). */
export function PageView({ detail, manga, widthPx, mode, selection = PAGE_SELECTION, onSelect, onChange }: PageViewProps): JSX.Element {
  const ops = useContext(OpsContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const format = manga.pageFormat;
  const size = pageSizePx(format, widthPx);
  const ppm = pxPerMm(format, widthPx);
  const fitPpm = useMemo(() => printPpm(format), [format]);
  const edit = mode === 'edit';
  const pageId = detail.page.id;

  const layout = useLiveOverride(detail.page.layout);
  const rects = useMemo(() => computeRects(layout.value, format), [layout.value, format]);
  const panels = useMemo(() => new Map(detail.panels.map((p) => [p.id, p])), [detail.panels]);
  const frames = useMemo(
    () => framesInOrder(liveFrames(detail.frames, detail.page.layout, layout.value, format)),
    [detail.frames, detail.page.layout, layout.value, format],
  );
  const imageFilter = panelImageFilter(manga.colorMode);
  const borderPx = Math.max(format.borderMm * ppm, mode === 'print' ? 0 : 0.5);
  const adjustId = selection.kind === 'panel' && selection.adjust ? selection.panelId : null;

  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }, []);
  /** Hands a command to the host (which runs it through History). Without ops or a host nothing is emitted, and false tells the caller to drop its live value. */
  const emit = (c: EditorCommand | undefined): boolean => {
    if (!c || !onChange) return false;
    onChange(c);
    return true;
  };

  return (
    <div
      ref={rootRef}
      className={`page-view page-view--${mode}`}
      data-testid="page-view"
      data-page-id={pageId}
      style={{ width: size.w, height: size.h }}
      onPointerDown={edit ? (e) => { if (e.target === e.currentTarget) onSelect?.(PAGE_SELECTION); } : undefined}
    >
      {rects.map(({ panelId, rect }) => {
        const panel = panels.get(panelId);
        return (
          <PanelView
            key={panelId}
            panelId={panelId}
            panel={panel}
            image={imageFor(detail, panel)}
            rect={rectPx(rect, size)}
            borderPx={borderPx}
            mode={mode}
            imageFilter={imageFilter}
            selected={selection.kind === 'panel' && selection.panelId === panelId}
            mergeCandidate={selection.kind === 'panel' && selection.mergeWith === panelId}
            adjusting={adjustId === panelId}
            onPointerDown={(e, id) => onSelect?.(clickPanel(selection, id, e.shiftKey))}
            onDoubleClick={(id) => onSelect?.(panelSelection(id, { adjust: true }))}
            onExitAdjust={(id) => onSelect?.(panelSelection(id))}
            onTransform={(id, before, after) => emit(ops?.transform(pageId, id, before, after))}
          />
        );
      })}
      {edit && (
        <GutterHandles
          layout={layout.value}
          format={format}
          size={size}
          toNorm={toNorm}
          onStart={layout.begin}
          onDrag={(path, ratio) => layout.update(resizeSplit(detail.page.layout, [...path], ratio))}
          onEnd={(path, from, to) => {
            if (to === null) { layout.cancel(); return; }
            layout.end();
            if (!emit(ops?.resize(pageId, path, from, to))) layout.cancel();
          }}
        />
      )}
      {frames.map((f) => (
        <FrameView
          key={f.id}
          frame={f}
          size={size}
          ppm={ppm}
          printPpm={fitPpm}
          mode={mode}
          selected={selection.kind === 'frame' && selection.frameId === f.id}
          toNorm={toNorm}
          onSelect={(id) => onSelect?.(frameSelection(id))}
          onCommit={(frame, before, after, label) => {
            const patch = geomPatch(before, after);
            return emit(ops?.updateFrame(pageId, frame.id, patch.before, patch.after, label));
          }}
        />
      ))}
    </div>
  );
}
