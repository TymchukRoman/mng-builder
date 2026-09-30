// packages/server/src/domain/lettering.ts
import { autoLetter, computeRects, CreateFrameSchema, type Box, type Rect, type TextFrame } from '@manga/shared';
import type { Store } from '../store/index.js';
import { createFrame } from './frames.js';
import { pageDetail } from './pages.js';

/** The cover title box as fractions of the cover panel: across the top, 8 % in from the sides. */
export const TITLE_BOX = { x: 0.08, y: 0.05, w: 0.84, h: 0.12 } as const;
/** Stands in for the title in `autoLetter`'s existing frames: text no real line can equal, so it only acts as an obstacle. */
const TITLE_OBSTACLE_TEXT = '\u0000title';

function titleBoxIn(r: Rect): Box {
  return { x: r.x + r.w * TITLE_BOX.x, y: r.y + r.h * TITLE_BOX.y, w: r.w * TITLE_BOX.w, h: r.h * TITLE_BOX.h };
}

/**
 * Auto-letters a page (spec §9.3) in one transaction: adds frames for lines with no frame of the same text
 * (exact match, per panel), plus a title frame on a cover page that has none. So an edited bubble's text is lettered
 * again, and a deleted cover title comes back (F34). Returns only the frames it created; emits nothing (callers emit).
 */
export function letterPage(store: Store, pageId: string): TextFrame[] {
  const detail = pageDetail(store, pageId);
  const manga = store.mangas.require(detail.page.mangaId);
  const rects = new Map(computeRects(detail.page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
  const first = detail.panels[0];
  const panelRect: Rect = (first ? rects.get(first.id) : undefined) ?? { x: 0, y: 0, w: 1, h: 1 };
  const needsTitle = detail.page.kind === 'cover' && !detail.frames.some((f) => f.kind === 'title');
  const titleBox = titleBoxIn(panelRect);
  const existingFrames = detail.frames.map((f) => ({ panelId: f.panelId, text: f.text, box: f.box, order: f.order }));
  // The title is placed first, so cover dialogue is lettered around it.
  if (needsTitle) existingFrames.push({ panelId: first?.id ?? null, text: TITLE_OBSTACLE_TEXT, box: titleBox, order: -1 });
  const drafts = autoLetter({
    layout: detail.page.layout, format: manga.pageFormat, direction: manga.readingDirection,
    panels: detail.panels.flatMap((p) => {
      const rect = rects.get(p.id);
      return rect ? [{ id: p.id, rect, script: p.script }] : [];
    }),
    existingFrames,
  });
  return store.tx(() => {
    const created = drafts.map((d) => createFrame(store, pageId, CreateFrameSchema.parse({
      kind: d.kind, text: d.text, panelId: d.panelId, speakerId: d.speakerId, box: d.box, tail: d.tail,
      rotation: d.rotation, font: d.font, fontSize: d.fontSize, align: d.align,
    })));
    if (needsTitle) {
      const title = detail.page.chapterId !== null ? store.chapters.require(detail.page.chapterId).title : manga.title;
      created.push(createFrame(store, pageId, CreateFrameSchema.parse({
        kind: 'title', text: title, panelId: first?.id ?? null, tail: null, align: 'center', box: titleBox,
      })));
    }
    return created;
  });
}
