import type { Box, FrameKind, TextFrame } from '@manga/shared';
import type { SizePx } from '../page/geometry';
import type { CreateFrameBody, CreatePageBody, UpdateFrameBody } from '../types';
import { moveFrame } from './frameDrag';
import { PAGE_SELECTION, panelSelection, type Selection } from './selection';

export const CHAPTER_FRAME_KINDS: FrameKind[] = ['speech', 'thought', 'shout', 'narration', 'sfx'];
export const COVER_FRAME_KINDS: FrameKind[] = ['title'];

/** The number of panels a preset would remove, from the `needs_confirm` error details ({ removedPanelIds }). */
export function removedPanelCount(details: unknown): number {
  const ids = typeof details === 'object' && details !== null ? (details as { removedPanelIds?: unknown }).removedPanelIds : undefined;
  return Array.isArray(ids) ? ids.length : 0;
}

export function resolveCurrentPage(pageIds: readonly string[], requested: string | null): string | null {
  return requested !== null && pageIds.includes(requested) ? requested : (pageIds[0] ?? null);
}

export function neighbourAfterDelete(pageIds: readonly string[], deleted: string): string | null {
  const i = pageIds.indexOf(deleted);
  const rest = pageIds.filter((id) => id !== deleted);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null;
}

export function frameInsert(kind: FrameKind, selection: Selection): CreateFrameBody {
  return { kind, panelId: selection.kind === 'panel' ? selection.panelId : null };
}

export function insertBody(pageIds: readonly string[], currentId: string | null): CreatePageBody {
  const i = currentId === null ? -1 : pageIds.indexOf(currentId);
  return i < 0 ? {} : { index: i + 1 };
}

/** Esc leaves image-adjust mode first; otherwise it clears the selection. */
export function escapeSelection(s: Selection): Selection {
  return s.kind === 'panel' && s.adjust ? panelSelection(s.panelId) : PAGE_SELECTION;
}

/** The chapter editor exports the chapter; the cover editor exports its one page. */
export function exportTarget(chapterId: string | null, pageId: string | null): { type: 'page' | 'chapter'; id: string } | null {
  if (chapterId !== null) return { type: 'chapter', id: chapterId };
  return pageId !== null ? { type: 'page', id: pageId } : null;
}

type Point = { x: number; y: number };
export interface FrameGeom { box: Box; tail: Point | null }

/** An arrow-key burst on one frame: where it started and where it is now. */
export interface NudgeState { frameId: string; before: FrameGeom; after: FrameGeom }

/**
 * One arrow-key step of `dx`, `dy` screen pixels. A burst on the same frame keeps its starting position, so the
 * burst becomes one command. The move is `moveFrame`'s: the box stays on the page and an attached tail travels with it.
 */
export function nudgeStep(pending: NudgeState | null, frame: TextFrame, dx: number, dy: number, size: SizePx): NudgeState {
  const same = pending !== null && pending.frameId === frame.id;
  const before: FrameGeom = same ? pending.before : { box: frame.box, tail: frame.tail };
  const from = same ? pending.after : before;
  return { frameId: frame.id, before, after: moveFrame(from, dx / size.w, dy / size.h) };
}

/** The frame PATCHes for a finished burst; the tail is sent only when the frame has one. */
export function nudgePatch(s: NudgeState): { before: UpdateFrameBody; after: UpdateFrameBody } {
  const body = (g: FrameGeom): UpdateFrameBody => (s.before.tail === null ? { box: g.box } : { box: g.box, tail: g.tail });
  return { before: body(s.before), after: body(s.after) };
}
