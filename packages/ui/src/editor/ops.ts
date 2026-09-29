import { resizeSplit, type ImageTransform, type LayoutNode, type PageDetail, type PageFormat, type Panel, type SplitDir, type SplitPath, type TextFrame } from '@manga/shared';
import { type ApiClient, seg } from '../api';
import type { CreateFrameBody, UpdateFrameBody, UpdatePanelBody } from '../types';
import type { EditorCommand, FrameCreateCommand } from './commands';
import type { IdMap } from './history';
import { applyMoves, movePatch, reanchorFrames, rectMap, restoreMoves, type FrameMove } from './reanchor';

export type OpsApi = Pick<ApiClient, 'get' | 'post' | 'patch' | 'delete'>;

export interface OpsCache {
  /** Stops in-flight refetches of the page, so they cannot overwrite an optimistic value or be undone by a stale rollback. */
  cancel(pageId: string): Promise<void>;
  getPage(pageId: string): PageDetail | undefined;
  setPage(detail: PageDetail): void;
  setFrame(frame: TextFrame): void;
  removeFrame(pageId: string, frameId: string): void;
  setPanel(panel: Panel): void;
}

/**
 * `format` is read at every use: the manga's page format decides the panel rects that frames are re-anchored between.
 * `onFrameError` receives a failure to save the frames that followed a layout change (resize, split). The layout is already
 * saved by then, so the command still succeeds and stays undoable; the host shows the error.
 */
export interface OpsDeps { api: OpsApi; ids: IdMap; cache: OpsCache; format: () => PageFormat; onFrameError: (err: unknown) => void }

/** The result of a barrier layout change: the layout is done, and re-anchoring the frames may still have failed (`framesError`). */
export interface LayoutChange { detail: PageDetail; framesError: unknown }

/** The body that re-creates `f` (POST /api/pages/:id/frames): every field the server stores, minus id, order and timestamps. */
function frameBody(f: TextFrame, ids: IdMap): CreateFrameBody {
  return {
    kind: f.kind, text: f.text, panelId: f.panelId === null ? null : ids.resolve(f.panelId), speakerId: f.speakerId,
    box: f.box, tail: f.tail, rotation: f.rotation, font: f.font, fontSize: f.fontSize, autoFit: f.autoFit, align: f.align,
  };
}

/**
 * The panel a split of `panelId` created: the server puts the old panel in `a` and the new one in `b` of
 * the split that replaces the leaf (`splitPanel` in @manga/shared). Read from the response, never diffed against the cache.
 */
function splitChildOf(layout: LayoutNode, panelId: string): string | null {
  if (layout.type === 'panel') return null;
  if (layout.a.type === 'panel' && layout.a.id === panelId && layout.b.type === 'panel') return layout.b.id;
  return splitChildOf(layout.a, panelId) ?? splitChildOf(layout.b, panelId);
}

export function createOps({ api, ids, cache, format, onFrameError }: OpsDeps) {
  const loadPage = async (pageId: string): Promise<PageDetail> => cache.getPage(pageId) ?? api.get<PageDetail>(`/api/pages/${seg(pageId)}`);

  /**
   * Resizes the split. `frameMoves` says where the frames go with it; they are written (optimistically too) in the same cache
   * write as the layout, so neither a gutter drag nor an undo shows the frames over the wrong panel. Rolls both back on failure.
   */
  const resizeTo = async (
    pageId: string, path: SplitPath, ratio: number,
    frameMoves: (prev: PageDetail, layout: LayoutNode) => FrameMove[],
  ): Promise<{ prev: PageDetail; detail: PageDetail; moves: FrameMove[] }> => {
    await cache.cancel(pageId);
    const prev = await loadPage(pageId);
    const layout = resizeSplit(prev.page.layout, [...path], ratio);
    const moves = frameMoves(prev, layout);
    cache.setPage({ ...prev, page: { ...prev.page, layout }, frames: applyMoves(prev.frames, moves) });
    try {
      const detail = await api.post<PageDetail>(`/api/pages/${seg(pageId)}/layout/resize`, { path, ratio });
      cache.setPage({ ...detail, frames: applyMoves(detail.frames, moves) });
      return { prev, detail, moves };
    } catch (err) {
      cache.setPage(prev);
      throw err;
    }
  };

  /**
   * PATCHes moved frames in parallel (the caller has already shown them moved) and confirms each in the cache. A frame whose
   * PATCH fails goes back to its `before` state in the cache, and the first failure is thrown. The layout change that caused
   * the moves stays: it is already saved. Move ids are resolved through the IdMap (a frame may have been re-created since).
   */
  const saveMoves = async (pageId: string, moves: readonly FrameMove[], before: readonly TextFrame[]): Promise<void> => {
    const byId = new Map(before.map((f) => [f.id, f]));
    const results = await Promise.allSettled(moves.map(async (move) => {
      const id = ids.resolve(move.id);
      const from = byId.get(id);
      if (!from) return;
      const patch = movePatch(from, move);
      if (Object.keys(patch).length === 0) return;
      const body: UpdateFrameBody = typeof patch.panelId === 'string' ? { ...patch, panelId: ids.resolve(patch.panelId) } : patch;
      try {
        cache.setFrame(await api.patch<TextFrame>(`/api/frames/${seg(id)}`, body));
      } catch (err) {
        cache.setFrame(from);
        throw err;
      }
    }));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  };

  /** After a layout change the server made (split, preset): re-anchors the frames of the response and saves the moves. */
  const followLayout = async (
    pageId: string, detail: PageDetail, oldLayout: LayoutNode, opts?: { splitFrom: { panelId: string; newPanelId: string } },
  ): Promise<void> => {
    const moves = reanchorFrames(detail.frames, rectMap(oldLayout, format()), rectMap(detail.page.layout, format()), opts);
    await cache.cancel(pageId);
    cache.setPage({ ...detail, frames: applyMoves(detail.frames, moves) });
    await saveMoves(pageId, moves, detail.frames);
  };

  // A stored anchor may name a panel that a redo re-created under a new id.
  const resolveAnchor = (patch: UpdateFrameBody): UpdateFrameBody =>
    typeof patch.panelId === 'string' ? { ...patch, panelId: ids.resolve(patch.panelId) } : patch;

  /**
   * `rollback` is the command's other side. A failed PATCH restores the cached frame with it laid over, because the cache
   * may already show `patch`: a nudge burst writes the moved frame ahead of its command (M3), and rolling back to that
   * cached value would keep the unsaved position on screen.
   */
  const patchFrame = async (pageId: string, frameId: string, patch: UpdateFrameBody, rollback: UpdateFrameBody): Promise<void> => {
    const id = ids.resolve(frameId);
    const body = resolveAnchor(patch);
    await cache.cancel(pageId);
    const cached = cache.getPage(pageId)?.frames.find((f) => f.id === id);
    const prev = cached ? ({ ...cached, ...resolveAnchor(rollback) } as TextFrame) : undefined;
    if (cached) cache.setFrame({ ...cached, ...body } as TextFrame);
    try {
      cache.setFrame(await api.patch<TextFrame>(`/api/frames/${seg(id)}`, body));
    } catch (err) {
      if (prev) cache.setFrame(prev);
      throw err;
    }
  };

  const patchPanel = async (pageId: string, panelId: string, patch: UpdatePanelBody): Promise<void> => {
    const id = ids.resolve(panelId);
    await cache.cancel(pageId);
    const prev = cache.getPage(pageId)?.panels.find((p) => p.id === id);
    if (prev) cache.setPanel({ ...prev, ...patch } as Panel);
    try {
      cache.setPanel(await api.patch<Panel>(`/api/panels/${seg(id)}`, patch));
    } catch (err) {
      if (prev) cache.setPanel(prev);
      throw err;
    }
  };

  return {
    /**
     * Frames anchored to a panel move with it (proportionally, see `reanchorFrames`). Reverting resizes back and PATCHes the
     * moved frames to the exact boxes and tails they had before, never re-mapped, so undo is exact (and idempotent: a frame
     * already at its snapshot is not PATCHed). A frame that failed to save does not fail the command: the layout is saved,
     * so the command must stay undoable; the error goes to `onFrameError`.
     */
    resize(pageId: string, path: SplitPath, from: number, to: number): EditorCommand {
      let restore: TextFrame[] = [];
      return {
        label: 'Resize panels',
        pageId,
        async apply() {
          const { prev, detail, moves } = await resizeTo(pageId, path, to, (p, layout) =>
            reanchorFrames(p.frames, rectMap(p.page.layout, format()), rectMap(layout, format())));
          restore = prev.frames.filter((f) => moves.some((m) => m.id === f.id));
          try { await saveMoves(pageId, moves, detail.frames); } catch (err) { onFrameError(err); }
        },
        async revert() {
          // Ids at revert time: a frame deleted and restored in between has a new one.
          const back = () => restoreMoves(restore).map((m) => ({ ...m, id: ids.resolve(m.id) }));
          const { detail, moves } = await resizeTo(pageId, path, from, back);
          try { await saveMoves(pageId, moves, detail.frames); } catch (err) { onFrameError(err); }
        },
      };
    },

    /**
     * The server adds the new panel as the `b` half. Reverting merges it back into `panelId` (merge keeps A's
     * id and content), which restores the exact tree. A redo creates a new panel id, so the old one is remapped.
     *
     * Limit: merge moves the new panel's images to A and deletes it. So a later redo of a `transform` or
     * `activeImage` command aimed at the re-created panel cannot be restored (the server refuses an image
     * that is not that panel's variant); the redo reports the error and History drops the rest of the redo stack.
     */
    split(pageId: string, panelId: string, dir: SplitDir): EditorCommand {
      let created: string | null = null;
      return {
        label: dir === 'h' ? 'Split top and bottom' : 'Split left and right',
        pageId,
        async apply() {
          const target = ids.resolve(panelId);
          const before = cache.getPage(pageId)?.page.layout;
          const detail = await api.post<PageDetail>(`/api/pages/${seg(pageId)}/layout/split`, { panelId: target, dir });
          const id = splitChildOf(detail.page.layout, target);
          if (id === null) throw new Error('The split did not create a panel');
          if (created !== null) ids.set(created, id);
          created = id;
          // Frames centred over the new half follow it (their boxes stay put). A failing PATCH is reported, not thrown: the split is saved and must stay undoable.
          try {
            await followLayout(pageId, detail, before ?? detail.page.layout, { splitFrom: { panelId: target, newPanelId: id } });
          } catch (err) { onFrameError(err); }
        },
        async revert() {
          if (created === null) return;
          cache.setPage(await api.post<PageDetail>(`/api/pages/${seg(pageId)}/layout/merge`, { panelIdA: ids.resolve(panelId), panelIdB: ids.resolve(created) }));
        },
      };
    },

    addFrame(pageId: string, input: CreateFrameBody): FrameCreateCommand {
      let first: TextFrame | null = null;
      let current: string | null = null;
      return {
        label: `Add ${input.kind}`,
        pageId,
        get createdId() { return current; },
        async apply() {
          // The first apply sends the caller's input (the server fills the defaults); a redo re-posts the stored result.
          const body: CreateFrameBody = first
            ? frameBody(first, ids)
            : { ...input, ...(typeof input.panelId === 'string' ? { panelId: ids.resolve(input.panelId) } : {}) };
          const frame = await api.post<TextFrame>(`/api/pages/${seg(pageId)}/frames`, body);
          if (current !== null) ids.set(current, frame.id);
          current = frame.id;
          first ??= frame;
          cache.setFrame(frame);
        },
        async revert() {
          if (current === null) return;
          const id = ids.resolve(current);
          await api.delete(`/api/frames/${seg(id)}`);
          cache.removeFrame(pageId, id);
        },
      };
    },

    updateFrame(pageId: string, frameId: string, before: UpdateFrameBody, after: UpdateFrameBody, label = 'Edit frame'): EditorCommand {
      return { label, pageId, apply: () => patchFrame(pageId, frameId, after, before), revert: () => patchFrame(pageId, frameId, before, after) };
    },

    /** Deleting a frame cascades to nothing on the server; reverting re-creates it (new id, remapped) and restores its order. */
    deleteFrame(frame: TextFrame): EditorCommand {
      let current = frame.id;
      return {
        label: 'Delete frame',
        pageId: frame.pageId,
        async apply() {
          const id = ids.resolve(current);
          await api.delete(`/api/frames/${seg(id)}`);
          cache.removeFrame(frame.pageId, id);
        },
        async revert() {
          const restored = await api.post<TextFrame>(`/api/pages/${seg(frame.pageId)}/frames`, frameBody(frame, ids));
          // The frame exists now: record its new id and cache it before the order fix, so a failing PATCH leaves both correct.
          ids.set(ids.resolve(current), restored.id);
          current = restored.id;
          cache.setFrame(restored);
          if (restored.order !== frame.order) cache.setFrame(await api.patch<TextFrame>(`/api/frames/${seg(restored.id)}`, { order: frame.order }));
        },
      };
    },

    transform(pageId: string, panelId: string, before: ImageTransform, after: ImageTransform): EditorCommand {
      return {
        label: 'Move image',
        pageId,
        apply: () => patchPanel(pageId, panelId, { imageTransform: after }),
        revert: () => patchPanel(pageId, panelId, { imageTransform: before }),
      };
    },

    /**
     * An autosave of panel fields the spec keeps out of the history (script, prompt, recipe, seed, refs): the same
     * optimistic write as the undoable panel commands, with the rollback on failure, but no command to undo.
     */
    savePanel(pageId: string, panelId: string, patch: UpdatePanelBody): Promise<void> {
      return patchPanel(pageId, panelId, patch);
    },

    activeImage(pageId: string, panelId: string, before: string | null, after: string | null): EditorCommand {
      const set = async (imageId: string | null): Promise<void> => {
        await api.patch<Panel>(`/api/panels/${seg(ids.resolve(panelId))}`, { activeImageId: imageId });
        // detail.images only carries active images, so reload to get the new one's size.
        cache.setPage(await api.get<PageDetail>(`/api/pages/${seg(pageId)}`));
      };
      return { label: 'Switch image', pageId, apply: () => set(after), revert: () => set(before) };
    },

    /**
     * Barrier helper (not undoable): run through history.barrier(). The layout call throws as it is (needs_confirm must reach
     * the caller). Frames follow their panels once it succeeded; a failure there is returned, not thrown, so the barrier still
     * clears the history of a page whose layout really changed.
     */
    async applyPreset(pageId: string, preset: string, confirm: boolean): Promise<LayoutChange> {
      const prev = await loadPage(pageId);
      const detail = await api.post<PageDetail>(`/api/pages/${seg(pageId)}/layout/preset`, { preset, confirm });
      try {
        await followLayout(pageId, detail, prev.page.layout);
        return { detail, framesError: null };
      } catch (framesError) {
        return { detail, framesError };
      }
    },

    /**
     * Barrier helper (not undoable): run through history.barrier(). The server re-anchors the removed panel's frames to the kept
     * one and no box changes: the merged panel covers both old areas, so every frame is still over its panel (mapping the kept
     * panel's frames from its old rect to the union would displace them).
     */
    async merge(pageId: string, a: string, b: string): Promise<PageDetail> {
      await cache.cancel(pageId);
      const detail = await api.post<PageDetail>(`/api/pages/${seg(pageId)}/layout/merge`, { panelIdA: ids.resolve(a), panelIdB: ids.resolve(b) });
      cache.setPage(detail);
      return detail;
    },
  };
}

export type Ops = ReturnType<typeof createOps>;
