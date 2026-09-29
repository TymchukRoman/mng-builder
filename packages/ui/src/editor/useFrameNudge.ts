import { useCallback, useEffect, useRef } from 'react';
import type { TextFrame } from '@manga/shared';
import type { SizePx } from '../page/geometry';
import type { EditorCommand } from './commands';
import { nudgePatch, nudgeStep, type NudgeState } from './editorModel';
import type { Ops, OpsCache } from './ops';

interface Pending { pageId: string; state: NudgeState; timer: ReturnType<typeof setTimeout> }

export interface FrameNudge {
  nudge(pageId: string, frame: TextFrame, dx: number, dy: number, size: SizePx): void;
  /** Commits a pending burst now (before an undo, a delete or a page switch), so the history stays in order. */
  flush(): void;
}

/** Arrow-key nudges move the frame at once and become one undoable "Nudge frame" command after 300 ms of quiet. */
export function useFrameNudge(ops: Ops, cache: OpsCache, run: (c: EditorCommand) => Promise<void>): FrameNudge {
  const pending = useRef<Pending | null>(null);
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    const patch = nudgePatch(p.state);
    void run(ops.updateFrame(p.pageId, p.state.frameId, patch.before, patch.after, 'Nudge frame'));
  }, [ops, run]);
  useEffect(() => () => flush(), [flush]);
  const nudge = useCallback((pageId: string, frame: TextFrame, dx: number, dy: number, size: SizePx) => {
    let p = pending.current;
    if (p && (p.state.frameId !== frame.id || p.pageId !== pageId)) { flush(); p = null; }
    const state = nudgeStep(p ? p.state : null, frame, dx, dy, size);
    cache.setFrame({ ...frame, box: state.after.box, tail: state.after.tail });
    if (p) clearTimeout(p.timer);
    pending.current = { pageId, state, timer: setTimeout(flush, 300) };
  }, [cache, flush]);
  return { nudge, flush };
}
