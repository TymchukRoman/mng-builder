import type { z } from 'zod';
import {
  computeRects, DEFAULT_FONT_SIZE, FONT_FOR_KIND, panelIds,
  type Box, type CreateFrameSchema, type FrameKind, type LayoutNode, type Page, type PageFormat, type TextFrame, type UpdateFrameSchema,
} from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { defined } from '../util/defined.js';

export type CreateFrameInput = z.infer<typeof CreateFrameSchema>;
export type UpdateFrameInput = z.infer<typeof UpdateFrameSchema>;

export const DEFAULT_FRAME_W = 0.3;
export const DEFAULT_FRAME_H = 0.12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 30%×12% of the page, centred in the anchor panel (or the page), kept inside the page. */
export function defaultFrameBox(layout: LayoutNode, format: PageFormat, panelId: string | null): Box {
  let cx = 0.5;
  let cy = 0.5;
  const rect = panelId === null ? undefined : computeRects(layout, format).find((r) => r.panelId === panelId)?.rect;
  if (rect) {
    cx = rect.x + rect.w / 2;
    cy = rect.y + rect.h / 2;
  }
  return {
    x: clamp(cx - DEFAULT_FRAME_W / 2, 0, 1 - DEFAULT_FRAME_W),
    y: clamp(cy - DEFAULT_FRAME_H / 2, 0, 1 - DEFAULT_FRAME_H),
    w: DEFAULT_FRAME_W,
    h: DEFAULT_FRAME_H,
  };
}

function checkAnchor(page: Page, panelId: string | null): void {
  if (panelId !== null && !panelIds(page.layout).includes(panelId)) throw new ValidationError(`panel ${panelId} is not on page ${page.id}`);
}

function checkSpeaker(store: Store, mangaId: string, speakerId: string | null): void {
  if (speakerId === null) return;
  if (store.characters.require(speakerId).mangaId !== mangaId) throw new ValidationError(`character ${speakerId} belongs to another manga`);
}

function checkKind(page: Page, kind: FrameKind): void {
  if (kind === 'title' && page.kind !== 'cover') throw new ValidationError('title frames are only allowed on cover pages');
}

export function createFrame(store: Store, pageId: string, input: CreateFrameInput): TextFrame {
  const page = store.pages.require(pageId);
  const manga = store.mangas.require(page.mangaId);
  checkKind(page, input.kind);
  checkAnchor(page, input.panelId);
  checkSpeaker(store, manga.id, input.speakerId);
  const order = store.frames.listByPage(pageId).reduce((max, f) => Math.max(max, f.order + 1), 0);
  return store.frames.create({
    pageId,
    panelId: input.panelId,
    kind: input.kind,
    text: input.text,
    speakerId: input.speakerId,
    box: input.box ?? defaultFrameBox(page.layout, manga.pageFormat, input.panelId),
    tail: input.tail ?? null,
    rotation: input.rotation,
    font: input.font ?? FONT_FOR_KIND[input.kind],
    fontSize: input.fontSize ?? DEFAULT_FONT_SIZE[input.kind],
    autoFit: input.autoFit,
    align: input.align,
    order,
  });
}

export function updateFrame(store: Store, frameId: string, patch: UpdateFrameInput): TextFrame {
  const frame = store.frames.require(frameId);
  const page = store.pages.require(frame.pageId);
  if (patch.kind !== undefined) checkKind(page, patch.kind);
  if (patch.panelId !== undefined) checkAnchor(page, patch.panelId);
  if (patch.speakerId !== undefined) checkSpeaker(store, page.mangaId, patch.speakerId);
  return store.frames.update(frameId, defined(patch));
}
