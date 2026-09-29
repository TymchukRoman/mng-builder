import { resizeSplit, type ImageTransform, type LayoutNode, type PageDetail, type Panel, type SplitDir, type SplitPath, type TextFrame } from '@manga/shared';
import type { ApiClient } from '../api';
import type { CreateFrameBody, UpdateFrameBody, UpdatePanelBody } from '../types';
import type { EditorCommand, FrameCreateCommand } from './commands';
import type { IdMap } from './history';

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

export interface OpsDeps { api: OpsApi; ids: IdMap; cache: OpsCache }

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

export function createOps({ api, ids, cache }: OpsDeps) {
  const loadPage = async (pageId: string): Promise<PageDetail> => cache.getPage(pageId) ?? api.get<PageDetail>(`/api/pages/${pageId}`);

  const resizeTo = async (pageId: string, path: SplitPath, ratio: number): Promise<void> => {
    await cache.cancel(pageId);
    const prev = await loadPage(pageId);
    cache.setPage({ ...prev, page: { ...prev.page, layout: resizeSplit(prev.page.layout, [...path], ratio) } });
    try {
      cache.setPage(await api.post<PageDetail>(`/api/pages/${pageId}/layout/resize`, { path, ratio }));
    } catch (err) {
      cache.setPage(prev);
      throw err;
    }
  };

  const patchFrame = async (pageId: string, frameId: string, patch: UpdateFrameBody): Promise<void> => {
    const id = ids.resolve(frameId);
    // A stored anchor may name a panel that a redo re-created under a new id.
    const body: UpdateFrameBody = typeof patch.panelId === 'string' ? { ...patch, panelId: ids.resolve(patch.panelId) } : patch;
    await cache.cancel(pageId);
    const prev = cache.getPage(pageId)?.frames.find((f) => f.id === id);
    if (prev) cache.setFrame({ ...prev, ...body } as TextFrame);
    try {
      cache.setFrame(await api.patch<TextFrame>(`/api/frames/${id}`, body));
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
      cache.setPanel(await api.patch<Panel>(`/api/panels/${id}`, patch));
    } catch (err) {
      if (prev) cache.setPanel(prev);
      throw err;
    }
  };

  return {
    resize(pageId: string, path: SplitPath, from: number, to: number): EditorCommand {
      return { label: 'Resize panels', pageId, apply: () => resizeTo(pageId, path, to), revert: () => resizeTo(pageId, path, from) };
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
          const detail = await api.post<PageDetail>(`/api/pages/${pageId}/layout/split`, { panelId: target, dir });
          const id = splitChildOf(detail.page.layout, target);
          if (id === null) throw new Error('The split did not create a panel');
          if (created !== null) ids.set(created, id);
          created = id;
          cache.setPage(detail);
        },
        async revert() {
          if (created === null) return;
          cache.setPage(await api.post<PageDetail>(`/api/pages/${pageId}/layout/merge`, { panelIdA: ids.resolve(panelId), panelIdB: ids.resolve(created) }));
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
          const frame = await api.post<TextFrame>(`/api/pages/${pageId}/frames`, body);
          if (current !== null) ids.set(current, frame.id);
          current = frame.id;
          first ??= frame;
          cache.setFrame(frame);
        },
        async revert() {
          if (current === null) return;
          const id = ids.resolve(current);
          await api.delete(`/api/frames/${id}`);
          cache.removeFrame(pageId, id);
        },
      };
    },

    updateFrame(pageId: string, frameId: string, before: UpdateFrameBody, after: UpdateFrameBody, label = 'Edit frame'): EditorCommand {
      return { label, pageId, apply: () => patchFrame(pageId, frameId, after), revert: () => patchFrame(pageId, frameId, before) };
    },

    /** Deleting a frame cascades to nothing on the server; reverting re-creates it (new id, remapped) and restores its order. */
    deleteFrame(frame: TextFrame): EditorCommand {
      let current = frame.id;
      return {
        label: 'Delete frame',
        pageId: frame.pageId,
        async apply() {
          const id = ids.resolve(current);
          await api.delete(`/api/frames/${id}`);
          cache.removeFrame(frame.pageId, id);
        },
        async revert() {
          const restored = await api.post<TextFrame>(`/api/pages/${frame.pageId}/frames`, frameBody(frame, ids));
          // The frame exists now: record its new id and cache it before the order fix, so a failing PATCH leaves both correct.
          ids.set(ids.resolve(current), restored.id);
          current = restored.id;
          cache.setFrame(restored);
          if (restored.order !== frame.order) cache.setFrame(await api.patch<TextFrame>(`/api/frames/${restored.id}`, { order: frame.order }));
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
        await api.patch<Panel>(`/api/panels/${ids.resolve(panelId)}`, { activeImageId: imageId });
        // detail.images only carries active images, so reload to get the new one's size.
        cache.setPage(await api.get<PageDetail>(`/api/pages/${pageId}`));
      };
      return { label: 'Switch image', pageId, apply: () => set(after), revert: () => set(before) };
    },

    /** Barrier helper (not undoable): run through history.barrier(). */
    async applyPreset(pageId: string, preset: string, confirm: boolean): Promise<PageDetail> {
      const detail = await api.post<PageDetail>(`/api/pages/${pageId}/layout/preset`, { preset, confirm });
      cache.setPage(detail);
      return detail;
    },

    /** Barrier helper (not undoable): run through history.barrier(). */
    async merge(pageId: string, a: string, b: string): Promise<PageDetail> {
      const detail = await api.post<PageDetail>(`/api/pages/${pageId}/layout/merge`, { panelIdA: ids.resolve(a), panelIdB: ids.resolve(b) });
      cache.setPage(detail);
      return detail;
    },
  };
}

export type Ops = ReturnType<typeof createOps>;
