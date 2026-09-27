import type { z } from 'zod';
import {
  DEFAULT_PAGE_FORMAT, mirrorLayout, STYLE_PRESETS, type CreateMangaSchema, type Manga, type StylePreset, type UpdateMangaSchema,
} from '@manga/shared';
import { ValidationError } from '../errors.js';
import type { Store } from '../store/index.js';
import { defined } from '../util/defined.js';

export type CreateMangaInput = z.infer<typeof CreateMangaSchema>;
export type UpdateMangaInput = z.infer<typeof UpdateMangaSchema>;

export function stylePreset(id: string): StylePreset {
  const preset = Object.hasOwn(STYLE_PRESETS, id) ? STYLE_PRESETS[id] : undefined;
  if (preset === undefined) throw new ValidationError(`unknown style preset "${id}"`, { known: Object.keys(STYLE_PRESETS) });
  return preset;
}

export function createManga(store: Store, input: CreateMangaInput): Manga {
  const preset = stylePreset(input.stylePreset);
  return store.mangas.create({
    title: input.title,
    synopsis: input.synopsis,
    language: input.language,
    colorMode: input.colorMode,
    readingDirection: input.readingDirection,
    pageFormat: structuredClone(DEFAULT_PAGE_FORMAT),
    styleGuide: structuredClone(preset.styleGuide),
    coverPageId: null,
  });
}

/** Mirrors every layout and frame of the manga left↔right, so a direction change keeps the story order. */
function mirrorPages(store: Store, mangaId: string): void {
  for (const page of store.pages.listByManga(mangaId)) {
    store.pages.update(page.id, { layout: mirrorLayout(page.layout) });
    for (const frame of store.frames.listByPage(page.id)) {
      store.frames.update(frame.id, {
        box: { ...frame.box, x: 1 - frame.box.x - frame.box.w },
        tail: frame.tail === null ? null : { x: 1 - frame.tail.x, y: frame.tail.y },
        rotation: frame.rotation === 0 ? 0 : -frame.rotation,
      });
    }
  }
}

export function updateManga(store: Store, mangaId: string, patch: UpdateMangaInput): Manga {
  const before = store.mangas.require(mangaId);
  return store.tx(() => {
    const after = store.mangas.update(mangaId, defined(patch));
    if (after.readingDirection !== before.readingDirection) mirrorPages(store, mangaId);
    return after;
  });
}
