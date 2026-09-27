import { RefSlotSchema, type Chapter, type Character, type Image, type Manga, type Page } from '@manga/shared';
import type { Store } from '../store/index.js';
import { chapterPages, renumberPages } from './order.js';

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

export function deletePage(store: Store, pageId: string): Page {
  const page = store.pages.require(pageId);
  const files: string[] = [];
  store.tx(() => {
    for (const panel of store.panels.listByPage(pageId)) files.push(...deletePanelRows(store, panel.id));
    store.pages.delete(pageId);
    if (page.kind === 'page' && page.chapterId !== null) renumberPages(store, chapterPages(store, page.chapterId));
  });
  removeFiles(store, files);
  return page;
}

export function deleteChapter(store: Store, chapterId: string): Chapter {
  const chapter = store.chapters.require(chapterId);
  const files: string[] = [];
  store.tx(() => {
    for (const page of store.pages.listByChapter(chapterId)) {
      for (const panel of store.panels.listByPage(page.id)) files.push(...deletePanelRows(store, panel.id));
    }
    store.chapters.delete(chapterId); // cascades pages, frames and episode runs
  });
  removeFiles(store, files);
  return chapter;
}

/** Everything under the manga goes by FK cascade; the image folder goes with it. */
export function deleteManga(store: Store, mangaId: string): Manga {
  const manga = store.mangas.require(mangaId);
  store.tx(() => store.mangas.delete(mangaId));
  store.files.removeMangaDir(mangaId);
  return manga;
}

/** Deletes the character's images and strips it from panel scripts and reference lists; frames lose their speaker by FK. */
export function deleteCharacter(store: Store, characterId: string): Character {
  const character = store.characters.require(characterId);
  const images = store.images.listByOwner('character', characterId);
  store.tx(() => {
    for (const page of store.pages.listByManga(character.mangaId)) {
      for (const panel of store.panels.listByPage(page.id)) {
        const refCharacterIds = panel.refCharacterIds.filter((id) => id !== characterId);
        const characters = panel.script.characters.filter((c) => c.characterId !== characterId);
        const spoke = panel.script.dialogue.some((line) => line.speakerId === characterId);
        if (refCharacterIds.length === panel.refCharacterIds.length && characters.length === panel.script.characters.length && !spoke) continue;
        const dialogue = panel.script.dialogue.map((line) => (line.speakerId === characterId ? { ...line, speakerId: null } : line));
        store.panels.update(panel.id, { refCharacterIds, script: { ...panel.script, characters, dialogue } });
      }
    }
    for (const image of images) store.images.delete(image.id);
    store.characters.delete(characterId);
  });
  removeFiles(store, images.map((image) => image.path));
  return character;
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
