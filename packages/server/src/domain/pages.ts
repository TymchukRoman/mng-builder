import {
  buildPreset, mergePanels, newId, panelIds, readingOrder, resizeSplit, splitPanel,
  type Image, type LayoutNode, type Page, type PageDetail, type Panel, type SplitDir,
} from '@manga/shared';
import { HttpError, ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { deletePanelRows, removeFiles } from './delete.js';
import { chapterPages, renumberPages } from './order.js';
import { newPanelInput } from './panels.js';

export class NeedsConfirmError extends HttpError {
  /** `message` defaults to the layout-preset wording; the episode rerun passes its own (F24). */
  constructor(public removedPanelIds: string[], message?: string) {
    super(409, 'needs_confirm', message ?? `this layout has fewer panels and would remove ${removedPanelIds.join(', ')}; resend with confirm=true`, { removedPanelIds });
    this.name = 'NeedsConfirmError';
  }
}

export function pageDetail(store: Store, pageId: string): PageDetail {
  const page = store.pages.require(pageId);
  const byId = new Map(store.panels.listByPage(pageId).map((panel) => [panel.id, panel]));
  const panels = panelIds(page.layout).map((id) => byId.get(id)).filter((p): p is Panel => p !== undefined);
  const images: Record<string, Image> = {};
  for (const panel of panels) {
    if (panel.activeImageId === null) continue;
    const image = store.images.get(panel.activeImageId);
    if (image) images[image.id] = image;
  }
  return { page, panels, frames: store.frames.listByPage(pageId), images };
}

/** Covers are single-panel pages: layout operations that would add panels are refused. */
function requireStoryPage(page: Page): void {
  if (page.kind === 'cover') throw new ValidationError('a cover page has exactly one panel');
}

function addPanels(store: Store, pageId: string, ids: readonly string[]): void {
  for (const id of ids) store.panels.create(newPanelInput(pageId, id));
}

export function createPage(store: Store, chapterId: string, preset: string, index?: number): PageDetail {
  const chapter = store.chapters.require(chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const layout = buildPreset(preset, manga.readingDirection, () => newId('pn'));
  const pageId = store.tx(() => {
    const siblings = chapterPages(store, chapterId);
    const at = index === undefined ? siblings.length : Math.min(Math.max(0, index), siblings.length);
    const page = store.pages.create({ mangaId: manga.id, chapterId, kind: 'page', order: at, layout });
    addPanels(store, page.id, panelIds(layout));
    const ordered = [...siblings];
    ordered.splice(at, 0, page);
    renumberPages(store, ordered);
    return page.id;
  });
  return pageDetail(store, pageId);
}

/** The manga cover (chapterId null) or a chapter cover: a single-panel page. Returns the existing one if present. */
export function createCoverPage(store: Store, mangaId: string, chapterId: string | null): PageDetail {
  const manga = store.mangas.require(mangaId);
  const chapter = chapterId === null ? null : store.chapters.require(chapterId);
  if (chapter !== null && chapter.mangaId !== mangaId) throw new ValidationError(`chapter ${chapter.id} does not belong to manga ${mangaId}`);
  const existing = chapter === null ? manga.coverPageId : chapter.coverPageId;
  if (existing !== null && store.pages.get(existing) !== null) return pageDetail(store, existing);
  const layout = buildPreset('splash', manga.readingDirection, () => newId('pn'));
  const pageId = store.tx(() => {
    const page = store.pages.create({ mangaId, chapterId, kind: 'cover', order: 0, layout });
    addPanels(store, page.id, panelIds(layout));
    if (chapter === null) store.mangas.update(mangaId, { coverPageId: page.id });
    else store.chapters.update(chapter.id, { coverPageId: page.id });
    return page.id;
  });
  return pageDetail(store, pageId);
}

function renameLeaves(tree: LayoutNode, names: ReadonlyMap<string, string>): LayoutNode {
  if (tree.type === 'panel') return { type: 'panel', id: names.get(tree.id) ?? tree.id };
  return { ...tree, a: renameLeaves(tree.a, names), b: renameLeaves(tree.b, names) };
}

/** Replaces the layout with a preset, mapping existing panels onto the new slots in reading order. */
export function applyPreset(store: Store, pageId: string, preset: string, confirm: boolean): PageDetail {
  const page = store.pages.require(pageId);
  requireStoryPage(page);
  const manga = store.mangas.require(page.mangaId);
  const dir = manga.readingDirection;
  const fresh = buildPreset(preset, dir, () => newId('pn'));
  const current = readingOrder(page.layout, dir);
  const slots = readingOrder(fresh, dir);
  const removed = current.slice(slots.length);
  if (removed.length > 0 && !confirm) throw new NeedsConfirmError(removed);

  const names = new Map<string, string>();
  slots.forEach((slot, i) => {
    const existing = current[i];
    if (existing !== undefined) names.set(slot, existing);
  });
  const layout = renameLeaves(fresh, names);
  const files: string[] = [];
  store.tx(() => {
    for (const id of removed) files.push(...deletePanelRows(store, id));
    addPanels(store, pageId, slots.slice(current.length));
    store.pages.update(pageId, { layout });
  });
  removeFiles(store, files);
  return pageDetail(store, pageId);
}

/** New Panel row: EMPTY_SCRIPT, random seed. */
export function splitPagePanel(store: Store, pageId: string, panelId: string, dir: SplitDir): PageDetail {
  const page = store.pages.require(pageId);
  requireStoryPage(page);
  const added = newId('pn');
  const layout = splitPanel(page.layout, panelId, dir, added);
  store.tx(() => {
    store.panels.create(newPanelInput(pageId, added));
    store.pages.update(pageId, { layout });
  });
  return pageDetail(store, pageId);
}

/** Deletes the removed panel; its images and frames are re-anchored to the kept panel. */
export function mergePagePanels(store: Store, pageId: string, a: string, b: string): PageDetail {
  const page = store.pages.require(pageId);
  const { tree, keptId, removedId } = mergePanels(page.layout, a, b);
  store.tx(() => {
    for (const image of store.images.listByOwner('panel', removedId)) store.images.update(image.id, { ownerId: keptId });
    for (const frame of store.frames.listByPage(pageId)) {
      if (frame.panelId === removedId) store.frames.update(frame.id, { panelId: keptId });
    }
    store.panels.delete(removedId);
    store.pages.update(pageId, { layout: tree });
  });
  return pageDetail(store, pageId);
}

export function resizePageSplit(store: Store, pageId: string, path: Array<'a' | 'b'>, ratio: number): PageDetail {
  const page = store.pages.require(pageId);
  store.pages.update(pageId, { layout: resizeSplit(page.layout, path, ratio) });
  return pageDetail(store, pageId);
}
