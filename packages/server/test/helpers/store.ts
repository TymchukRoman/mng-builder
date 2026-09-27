import { DEFAULT_PAGE_FORMAT, newId, STYLE_PRESETS, type Chapter, type Image, type Manga } from '@manga/shared';
import { openStore, type NewManga, type Store } from '../../src/store/index.js';
import { makePng } from './png.js';
import { tempDir } from './tmp.js';

export interface TestStore { store: Store; path: string; close(): void }

export function makeStore(): TestStore {
  const dir = tempDir('manga-store-');
  const store = openStore(dir.path);
  return {
    store,
    path: dir.path,
    close: () => {
      store.close();
      dir.cleanup();
    },
  };
}

export function seedManga(store: Store, over: Partial<NewManga> = {}): Manga {
  return store.mangas.create({
    title: 'Oni', synopsis: '', language: 'en', colorMode: 'bw', readingDirection: 'ltr',
    pageFormat: structuredClone(DEFAULT_PAGE_FORMAT), styleGuide: structuredClone(STYLE_PRESETS['manga-bw']!.styleGuide),
    coverPageId: null, ...over,
  });
}

export function seedChapter(store: Store, mangaId: string, number = 1): Chapter {
  return store.chapters.create({ mangaId, number, title: `Chapter ${number}`, synopsis: '', coverPageId: null, status: 'draft', order: number - 1 });
}

/** A real 4×4 PNG written to the library and registered as a variant of the panel. */
export function addPanelImage(store: Store, mangaId: string, panelId: string): Image {
  const id = newId('im');
  const path = store.files.writeImage(mangaId, id, makePng(4, 4));
  return store.images.create({
    id, mangaId, ownerType: 'panel', ownerId: panelId, role: null, path, width: 4, height: 4,
    source: 'uploaded', parentImageId: null, gen: null, review: null,
  });
}
