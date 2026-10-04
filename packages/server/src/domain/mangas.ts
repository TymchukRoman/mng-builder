import type { z } from 'zod';
import {
  DEFAULT_PAGE_FORMAT, mirrorLayout, STYLE_PRESETS, type ColorMode, type CreateMangaSchema, type Manga, type StylePreset, type UpdateMangaSchema,
} from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { defined } from '../util/defined.js';

/** `colorMode` omitted = the style preset's colour mode. */
export type CreateMangaInput = Omit<z.infer<typeof CreateMangaSchema>, 'colorMode' | 'imageModel'> & { colorMode?: ColorMode; imageModel?: string | null };
export type UpdateMangaInput = z.infer<typeof UpdateMangaSchema>;

export function stylePreset(id: string): StylePreset {
  const preset = Object.hasOwn(STYLE_PRESETS, id) ? STYLE_PRESETS[id] : undefined;
  if (preset === undefined) throw new ValidationError(`unknown style preset "${id}"`, { known: Object.keys(STYLE_PRESETS) });
  return preset;
}

/** An explicit colorMode wins over the preset's, even when they disagree (the CLI warns about that). */
export function createManga(store: Store, input: CreateMangaInput): Manga {
  const preset = stylePreset(input.stylePreset);
  return store.mangas.create({
    title: input.title,
    synopsis: input.synopsis,
    language: input.language,
    colorMode: input.colorMode ?? preset.colorMode,
    readingDirection: input.readingDirection,
    pageFormat: structuredClone(DEFAULT_PAGE_FORMAT),
    styleGuide: structuredClone(preset.styleGuide),
    imageModel: input.imageModel ?? null,
    coverPageId: null,
  });
}

/** `mirroredPageIds`: pages whose layout and frames were mirrored by a reading-direction change (frames are part of the page detail). */
export interface UpdatedManga { manga: Manga; mirroredPageIds: string[] }

/** Mirrors every layout and frame of the manga left↔right, so a direction change keeps the story order. Returns the page ids. */
function mirrorPages(store: Store, mangaId: string): string[] {
  const pages = store.pages.listByManga(mangaId);
  for (const page of pages) {
    store.pages.update(page.id, { layout: mirrorLayout(page.layout) });
    for (const frame of store.frames.listByPage(page.id)) {
      store.frames.update(frame.id, {
        box: { ...frame.box, x: 1 - frame.box.x - frame.box.w },
        tail: frame.tail === null ? null : { x: 1 - frame.tail.x, y: frame.tail.y },
        rotation: frame.rotation === 0 ? 0 : -frame.rotation,
      });
    }
  }
  return pages.map((page) => page.id);
}

export function updateManga(store: Store, mangaId: string, patch: UpdateMangaInput): UpdatedManga {
  const before = store.mangas.require(mangaId);
  return store.tx(() => {
    const manga = store.mangas.update(mangaId, defined(patch));
    const mirroredPageIds = manga.readingDirection !== before.readingDirection ? mirrorPages(store, mangaId) : [];
    return { manga, mirroredPageIds };
  });
}
