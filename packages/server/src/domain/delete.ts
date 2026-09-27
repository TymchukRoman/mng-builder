import { RefSlotSchema, type Chapter, type Character, type Image, type Manga, type Page } from '@manga/shared';
import type { Store } from '../store/index.js';
import { chapterPages, renumberPages } from './order.js';

/**
 * What a cascade removed or changed besides its main entity, so the route can emit one entity event for each
 * (Contract B). Frames and images that go with their page, panel or character are covered by that owner's event.
 */
export interface DeletedPage { page: Page; panelIds: string[]; clearedCoverOf: { entity: 'manga' | 'chapter'; id: string } | null }
export interface DeletedChapter { chapter: Chapter; pageIds: string[]; panelIds: string[] }
/** `panelIds`: panels whose script or refCharacterIds lost the character; `frameIds`: frames whose speaker was cleared. */
export interface DeletedCharacter { character: Character; panelIds: string[]; frameIds: string[] }

/** Removes image files after the transaction that deleted their rows has committed. Missing files are ignored. */
export function removeFiles(store: Store, rels: readonly string[]): void {
  for (const rel of rels) store.files.remove(rel);
}

/** Deletes a panel and its image rows (frames anchored to it are un-anchored by the FK). Returns files to remove after commit. */
export function deletePanelRows(store: Store, panelId: string): string[] {
  const images = store.images.listByOwner('panel', panelId);
  for (const image of images) store.images.delete(image.id);
  store.panels.delete(panelId);
  return images.map((image) => image.path);
}

/** The manga or chapter whose coverPageId points at this page (the FK clears it when the page goes). */
function coverOwner(store: Store, page: Page): DeletedPage['clearedCoverOf'] {
  if (page.kind !== 'cover') return null;
  if (page.chapterId === null) return store.mangas.get(page.mangaId)?.coverPageId === page.id ? { entity: 'manga', id: page.mangaId } : null;
  return store.chapters.get(page.chapterId)?.coverPageId === page.id ? { entity: 'chapter', id: page.chapterId } : null;
}

export function deletePage(store: Store, pageId: string): DeletedPage {
  const page = store.pages.require(pageId);
  const clearedCoverOf = coverOwner(store, page);
  const panelIds: string[] = [];
  const files: string[] = [];
  store.tx(() => {
    for (const panel of store.panels.listByPage(pageId)) {
      panelIds.push(panel.id);
      files.push(...deletePanelRows(store, panel.id));
    }
    store.pages.delete(pageId);
    if (page.kind === 'page' && page.chapterId !== null) renumberPages(store, chapterPages(store, page.chapterId));
  });
  removeFiles(store, files);
  return { page, panelIds, clearedCoverOf };
}

/** Removes the chapter with all its pages (its cover included), their panels and image files. */
export function deleteChapter(store: Store, chapterId: string): DeletedChapter {
  const chapter = store.chapters.require(chapterId);
  const pageIds: string[] = [];
  const panelIds: string[] = [];
  const files: string[] = [];
  store.tx(() => {
    for (const page of store.pages.listByChapter(chapterId)) {
      pageIds.push(page.id);
      for (const panel of store.panels.listByPage(page.id)) {
        panelIds.push(panel.id);
        files.push(...deletePanelRows(store, panel.id));
      }
    }
    store.chapters.delete(chapterId); // cascades pages, frames and episode runs
  });
  removeFiles(store, files);
  return { chapter, pageIds, panelIds };
}

/** Everything under the manga goes by FK cascade; the image folder goes with it. */
export function deleteManga(store: Store, mangaId: string): Manga {
  const manga = store.mangas.require(mangaId);
  store.tx(() => store.mangas.delete(mangaId));
  store.files.removeMangaDir(mangaId);
  return manga;
}

/** Deletes the character's images and strips it from panel scripts and reference lists; frames lose their speaker by FK. */
export function deleteCharacter(store: Store, characterId: string): DeletedCharacter {
  const character = store.characters.require(characterId);
  const images = store.images.listByOwner('character', characterId);
  const panelIds: string[] = [];
  const frameIds: string[] = [];
  store.tx(() => {
    for (const page of store.pages.listByManga(character.mangaId)) {
      for (const frame of store.frames.listByPage(page.id)) {
        if (frame.speakerId === characterId) frameIds.push(frame.id);
      }
      for (const panel of store.panels.listByPage(page.id)) {
        const refCharacterIds = panel.refCharacterIds.filter((id) => id !== characterId);
        const characters = panel.script.characters.filter((c) => c.characterId !== characterId);
        const spoke = panel.script.dialogue.some((line) => line.speakerId === characterId);
        if (refCharacterIds.length === panel.refCharacterIds.length && characters.length === panel.script.characters.length && !spoke) continue;
        const dialogue = panel.script.dialogue.map((line) => (line.speakerId === characterId ? { ...line, speakerId: null } : line));
        store.panels.update(panel.id, { refCharacterIds, script: { ...panel.script, characters, dialogue } });
        panelIds.push(panel.id);
      }
    }
    for (const image of images) store.images.delete(image.id);
    store.characters.delete(characterId);
  });
  removeFiles(store, images.map((image) => image.path));
  return { character, panelIds, frameIds };
}

/** Deletes the image and images derived from it; clears character refs (panel active pointers clear by FK). */
export function deleteImage(store: Store, imageId: string): Image {
  const image = store.images.require(imageId);
  const doomed = [image, ...store.images.listByOwner(image.ownerType, image.ownerId).filter((i) => i.parentImageId === image.id)];
  const ids = new Set(doomed.map((i) => i.id));
  store.tx(() => {
    if (image.ownerType === 'character') {
      const character = store.characters.get(image.ownerId);
      if (character !== null) {
        const refs: Character['refs'] = {};
        for (const slot of RefSlotSchema.options) {
          const ref = character.refs[slot];
          if (ref !== undefined && !ids.has(ref)) refs[slot] = ref;
        }
        store.characters.update(character.id, { refs });
      }
    }
    for (const doomedImage of doomed) store.images.delete(doomedImage.id);
  });
  removeFiles(store, doomed.map((i) => i.path));
  return image;
}
