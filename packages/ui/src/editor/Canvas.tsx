import { useLayoutEffect, useRef, type JSX } from 'react';
import type { Manga, PageDetail } from '@manga/shared';
import { PageView } from '../page/PageView';
import { StatusLoader } from '../ui/StatusLoader';
import type { EditorCommand } from './commands';
import { PAGE_SELECTION, type Selection } from './selection';

export function Canvas({ detail, manga, widthPx, selection, onSelect, onChange, onResize, loading }: {
  detail: PageDetail | null; manga: Manga; widthPx: number; selection: Selection;
  onSelect(s: Selection): void; onChange(c: EditorCommand): void; onResize(size: { w: number; h: number }): void; loading: boolean;
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
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains('canvas__inner')) onSelect(PAGE_SELECTION);
      }}
    >
      <div className="canvas__inner">
        {detail && <PageView detail={detail} manga={manga} widthPx={widthPx} mode="edit" selection={selection} onSelect={onSelect} onChange={onChange} />}
        {!detail && loading && <StatusLoader label="Loading page" />}
        {!detail && !loading && <p className="muted">No pages yet</p>}
      </div>
    </div>
  );
}
