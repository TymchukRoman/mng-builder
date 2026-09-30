// packages/server/src/domain/lettering.ts
import { autoLetter, computeRects, CreateFrameSchema, type Rect, type TextFrame } from '@manga/shared';
import type { Store } from '../store/index.js';
import { createFrame } from './frames.js';
import { pageDetail } from './pages.js';

/**
 * Auto-letters a page (spec §9.3) in one transaction: adds frames for lines with no frame of the same text
 * (exact match, per panel), plus a title frame on a cover page that has none. So an edited bubble's text is lettered
 * again, and a deleted cover title comes back (F34). Returns only the frames it created; emits nothing (callers emit).
 */
export function letterPage(store: Store, pageId: string): TextFrame[] {
  const detail = pageDetail(store, pageId);
  const manga = store.mangas.require(detail.page.mangaId);
  const rects = new Map(computeRects(detail.page.layout, manga.pageFormat).map((r) => [r.panelId, r.rect]));
  const drafts = autoLetter({
    layout: detail.page.layout, format: manga.pageFormat, direction: manga.readingDirection,
    panels: detail.panels.flatMap((p) => {
      const rect = rects.get(p.id);
      return rect ? [{ id: p.id, rect, script: p.script }] : [];
    }),
    existingFrames: detail.frames.map((f) => ({ panelId: f.panelId, text: f.text, box: f.box, order: f.order })),
  });
  return store.tx(() => {
    const created = drafts.map((d) => createFrame(store, pageId, CreateFrameSchema.parse({
      kind: d.kind, text: d.text, panelId: d.panelId, speakerId: d.speakerId, box: d.box, tail: d.tail,
      rotation: d.rotation, font: d.font, fontSize: d.fontSize, autoFit: true, align: d.align,
    })));
    if (detail.page.kind === 'cover' && !detail.frames.some((f) => f.kind === 'title')) {
      const title = detail.page.chapterId !== null ? store.chapters.require(detail.page.chapterId).title : manga.title;
      const first = detail.panels[0];
      const r: Rect = (first ? rects.get(first.id) : undefined) ?? { x: 0, y: 0, w: 1, h: 1 };
      created.push(createFrame(store, pageId, CreateFrameSchema.parse({
        kind: 'title', text: title, panelId: first?.id ?? null, tail: null, align: 'center', autoFit: true,
        box: { x: r.x + r.w * 0.08, y: r.y + r.h * 0.05, w: r.w * 0.84, h: r.h * 0.12 },
      })));
    }
    return created;
  });
}
