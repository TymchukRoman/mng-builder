import type { QueryClient } from '@tanstack/react-query';
import type { PageDetail, TextFrame } from '@manga/shared';
import { qk } from '../queryKeys';
import type { OpsCache } from './ops';

/** The server lists frames by `order` (ties by creation), so a frame that appears is slotted in the same way. */
function withFrame(frames: TextFrame[], frame: TextFrame): TextFrame[] {
  if (frames.some((f) => f.id === frame.id)) return frames.map((f) => (f.id === frame.id ? frame : f));
  return [...frames, frame].sort((a, b) => a.order - b.order);
}

/** Editor ops read and write page details through the TanStack Query cache. */
export function queryCache(qc: QueryClient): OpsCache {
  const update = (pageId: string, fn: (d: PageDetail) => PageDetail): void => {
    qc.setQueryData<PageDetail>(qk.page(pageId), (d) => (d ? fn(d) : d));
  };
  return {
    getPage: (pageId) => qc.getQueryData<PageDetail>(qk.page(pageId)),
    setPage: (detail) => { qc.setQueryData(qk.page(detail.page.id), detail); },
    setFrame: (frame) => update(frame.pageId, (d) => ({ ...d, frames: withFrame(d.frames, frame) })),
    removeFrame: (pageId, frameId) => update(pageId, (d) => ({ ...d, frames: d.frames.filter((f) => f.id !== frameId) })),
    setPanel: (panel) => update(panel.pageId, (d) => ({ ...d, panels: d.panels.map((p) => (p.id === panel.id ? panel : p)) })),
  };
}
