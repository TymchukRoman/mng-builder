import { useLayoutEffect, useRef, type JSX } from 'react';
import type { Manga, PageDetail } from '@manga/shared';
import { PageView } from '../page/PageView';
import { ErrorState } from '../ui/ErrorState';
import { StatusLoader } from '../ui/StatusLoader';
import type { EditorCommand } from './commands';
import { PAGE_SELECTION, type Selection } from './selection';

/** Without a page it says why: loading, a failed load (M1: `error`, with Retry) or an empty chapter. */
export function Canvas({ detail, manga, widthPx, selection, onSelect, onChange, onResize, loading, error, onRetry }: {
  detail: PageDetail | null; manga: Manga; widthPx: number; selection: Selection;
  onSelect(s: Selection): void; onChange(c: EditorCommand): void; onResize(size: { w: number; h: number }): void; loading: boolean;
  error: unknown; onRetry(): void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => onResize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);
  return (
    <div
      ref={ref}
      className="canvas"
      // Page gestures preventDefault their pointerdown, which also stops the browser moving focus. Blur the field that
      // still has it (say the inspector's text box), so the editor shortcuts (arrows, Del) reach the canvas selection.
      onPointerDownCapture={(e) => {
        const a = document.activeElement;
        if (a instanceof HTMLElement && a !== document.body && !e.currentTarget.contains(a)) a.blur();
      }}
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains('canvas__inner')) onSelect(PAGE_SELECTION);
      }}
    >
      <div className="canvas__inner">
        {detail && <PageView detail={detail} manga={manga} widthPx={widthPx} mode="edit" selection={selection} onSelect={onSelect} onChange={onChange} />}
        {!detail && error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {!detail && !error && loading && <StatusLoader label="Loading page" />}
        {!detail && !error && !loading && <p className="muted">No pages yet</p>}
      </div>
    </div>
  );
}
