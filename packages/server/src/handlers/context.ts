import {
  STYLE_PRESETS, effectiveImageModel, imageModelById, styleLorasFor,
  type CastCount, type Chapter, type Character, type LoraRef, type Manga, type Page, type Panel,
} from '@manga/shared';
import { RECIPES, type Recipe } from '../imaging/recipes/index.js';
import type { Store } from '../store/index.js';

/** M1 already owns entity events (controller ruling: never re-implement it here). */
export { emitEntity } from '../events/bus.js';

export const nonEmpty = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

export interface PanelContext {
  panel: Panel; page: Page; manga: Manga; characters: Character[]; refCharacters: Character[];
  /** The image model this panel renders with (its chapter's, else its manga's), or null for Settings' routing. */
  imageModel: string | null;
}

/** The chapter a page belongs to; null for the manga's own cover. */
export function chapterOfPage(store: Store, page: Pick<Page, 'chapterId'>): Chapter | null {
  return page.chapterId === null ? null : store.chapters.get(page.chapterId);
}

/** The image model a panel renders with: its chapter's, else its manga's, else null (Settings' routing). */
export function panelImageModel(store: Store, manga: Manga, panel: Pick<Panel, 'pageId'>): string | null {
  const page = store.pages.get(panel.pageId);
  return effectiveImageModel(page === null ? null : chapterOfPage(store, page), manga);
}

/**
 * The panel's characters as routing counts them (`charCount`): script characters, then ref toggles, deduplicated,
 * keeping only characters of this manga. panelContext (render path) and the M4 prompts step share it (I1).
 */
export function panelCharacters(store: Store, panel: Panel, mangaId: string): Character[] {
  const ids = [...new Set([...panel.script.characters.map((c) => c.characterId), ...panel.refCharacterIds])];
  return ids
    .map((id) => store.characters.get(id))
    .filter((c): c is Character => c !== null && c.mangaId === mangaId);
}

/** Characters that exist (script order, then ref toggles) and the toggled ones that have a usable reference image. */
export function panelContext(store: Store, panelId: string): PanelContext {
  const panel = store.panels.require(panelId);
  const page = store.pages.require(panel.pageId);
  const manga = store.mangas.require(page.mangaId);
  const characters = panelCharacters(store, panel, manga.id);
  const hasRef = (c: Character): boolean => refImages(store, c).length > 0;
  const refCharacters = panel.refCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => c !== undefined && hasRef(c));
  return { panel, page, manga, characters, refCharacters, imageModel: effectiveImageModel(chapterOfPage(store, page), manga) };
}

export interface PickedRef { imageId: string; character: Character }

/** A character's usable reference images, portrait first. */
export function refImages(store: Store, character: Character): string[] {
  return [character.refs.portrait, character.refs.fullbody].filter((id): id is string => id !== undefined && store.images.get(id) !== null);
}

/**
 * The reference order (the "picture N" numbering): one character → all of its images; several → the first image of
 * each. Capped at recipe.maxRefs. `imagesOf` lists a character's images, portrait first (the M4 prompts step passes
 * an assumed portrait for characters whose portraits are not rendered yet).
 */
export function orderRefs(recipe: Recipe, refCharacters: Character[], imagesOf: (character: Character) => string[]): PickedRef[] {
  if (recipe.maxRefs === 0) return [];
  const only = refCharacters.length === 1 ? refCharacters[0]! : null;
  const picked: PickedRef[] = only
    ? imagesOf(only).map((imageId) => ({ imageId, character: only }))
    : refCharacters.flatMap((character) => {
      const imageId = imagesOf(character)[0];
      return imageId ? [{ imageId, character }] : [];
    });
  return picked.slice(0, recipe.maxRefs);
}

/** One character → its portrait and full body; several → one image each (portrait first). Capped at recipe.maxRefs. */
export function pickRefs(store: Store, recipe: Recipe, refCharacters: Character[]): PickedRef[] {
  return orderRefs(recipe, refCharacters, (c) => refImages(store, c));
}

/**
 * Style LoRAs (the manga/anima book-level LoRA in `manga.styleGuide.loras`) only make sense for a recipe built on
 * the same model family as the style guide's own recipe — WAI's manga LoRA on Anima (or vice versa) would either
 * no-op or corrupt the image. Apply it only when the families match; otherwise the recipe generates without it.
 * With a male human in the subject or panel (`count.boy > 0`), a LoRA with a maleStrength runs at it (the Mnga
 * LoRA at 0.8 drew men as women): every portrait, sheet and panel generation gets its style LoRAs here.
 */
export function styleLoras(manga: Manga, recipeId: string, count: CastCount, imageModel: string | null = null): LoraRef[] {
  const family = RECIPES[recipeId]?.family;
  if (family === RECIPES[manga.styleGuide.recipe]?.family) return styleLorasFor(manga.styleGuide.loras, count.boy > 0);
  if (imageModelById(imageModel) === null) return [];
  // A chosen image model may draw on another family than the manga's style preset: it then takes the LoRAs of the built-in
  // preset of that family and colour mode (Anima's manga LoRA for a B&W book), so the model's pages keep the look of the book.
  const preset = Object.values(STYLE_PRESETS).find((p) => p.colorMode === manga.colorMode && RECIPES[p.styleGuide.recipe]?.family === family);
  return preset ? styleLorasFor(preset.styleGuide.loras, count.boy > 0) : [];
}
