import {
  DEFAULT_PAGE_FORMAT, STYLE_PRESETS, newId,
  type Chapter, type Character, type ColorMode, type Image, type Manga, type Page, type Panel, type PanelScript, type RefSlot,
} from '@manga/shared';
import { createPage } from '../../src/domain/pages.js';
import { encodeSolidPng } from '../../src/dev/png.js';
import { createImageWithId } from '../../src/imaging/image-row.js';
import type { Store } from '../../src/store/index.js';

export interface SeededManga { manga: Manga; chapter: Chapter; page: Page; panels: Panel[] }

export function seedManga(store: Store, opts: { preset?: string; colorMode?: ColorMode; layout?: string } = {}): SeededManga {
  const preset = STYLE_PRESETS[opts.preset ?? 'manga-bw']!;
  const manga = store.mangas.create({
    title: `Test ${newId('mg')}`, synopsis: '', language: 'en', colorMode: opts.colorMode ?? preset.colorMode, readingDirection: 'rtl',
    pageFormat: DEFAULT_PAGE_FORMAT, styleGuide: preset.styleGuide, coverPageId: null,
  });
  const chapter = store.chapters.create({ mangaId: manga.id, number: 1, title: 'One', synopsis: '', coverPageId: null, status: 'draft', order: 0 });
  const detail = createPage(store, chapter.id, opts.layout ?? '2x2');
  return { manga, chapter, page: detail.page, panels: detail.panels };
}

export function seedCharacter(store: Store, mangaId: string, name: string, appearanceTags = ''): Character {
  return store.characters.create({ mangaId, name, role: 'main', personality: '', speechStyle: '', appearanceTags, seed: 1234, recipe: null, refs: {} });
}

export function seedImage(
  store: Store, mangaId: string, owner: { type: 'character' | 'panel'; id: string }, role: RefSlot | null, size: [number, number] = [832, 1216],
): Image {
  const id = newId('im');
  const path = store.files.writeImage(mangaId, id, encodeSolidPng(size[0], size[1], [90, 90, 90]));
  return createImageWithId(store, id, {
    mangaId, ownerType: owner.type, ownerId: owner.id, role, path, width: size[0], height: size[1],
    source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}

export function giveRefs(store: Store, character: Character, slots: RefSlot[]): Character {
  const refs = { ...character.refs };
  for (const slot of slots) refs[slot] = seedImage(store, character.mangaId, { type: 'character', id: character.id }, slot).id;
  return store.characters.update(character.id, { refs });
}

export function updatePanel(store: Store, panelId: string, script: Partial<PanelScript>, extra: Parameters<Store['panels']['update']>[1] = {}): Panel {
  const panel = store.panels.require(panelId);
  return store.panels.update(panelId, { script: { ...panel.script, ...script }, ...extra });
}
