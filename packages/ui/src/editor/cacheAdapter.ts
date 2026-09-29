import type { QueryClient } from '@tanstack/react-query';
import type { PageDetail, TextFrame } from '@manga/shared';
import { qk } from '../queryKeys';
import type { OpsCache } from './ops';

/** The server lists frames by `order` (ties by creation); every write keeps the cache in that order (the sort is stable). */
function withFrame(frames: TextFrame[], frame: TextFrame): TextFrame[] {
  const next = frames.some((f) => f.id === frame.id) ? frames.map((f) => (f.id === frame.id ? frame : f)) : [...frames, frame];
  return next.sort((a, b) => a.order - b.order);
}

/** Editor ops read and write page details through the TanStack Query cache. */
export function queryCache(qc: QueryClient): OpsCache {
  const update = (pageId: string, fn: (d: PageDetail) => PageDetail): void => {
    qc.setQueryData<PageDetail>(qk.page(pageId), (d) => (d ? fn(d) : d));
  };
  return {
    cancel: (pageId) => qc.cancelQueries({ queryKey: qk.page(pageId), exact: true }),
    getPage: (pageId) => qc.getQueryData<PageDetail>(qk.page(pageId)),
    setPage: (detail) => { qc.setQueryData(qk.page(detail.page.id), detail); },
    setFrame: (frame) => update(frame.pageId, (d) => ({ ...d, frames: withFrame(d.frames, frame) })),
    removeFrame: (pageId, frameId) => update(pageId, (d) => ({ ...d, frames: d.frames.filter((f) => f.id !== frameId) })),
    setPanel: (panel) => update(panel.pageId, (d) => ({ ...d, panels: d.panels.map((p) => (p.id === panel.id ? panel : p)) })),
  };
}
