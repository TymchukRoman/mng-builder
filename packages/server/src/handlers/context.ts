import type { Character, LoraRef, Manga, Page, Panel } from '@manga/shared';
import { RECIPES, type Recipe } from '../imaging/recipes/index.js';
import type { Store } from '../store/index.js';

/** M1 already owns entity events (controller ruling: never re-implement it here). */
export { emitEntity } from '../events/bus.js';

export const nonEmpty = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

export interface PanelContext { panel: Panel; page: Page; manga: Manga; characters: Character[]; refCharacters: Character[] }

/** Characters that exist (script order, then ref toggles) and the toggled ones that have a usable reference image. */
export function panelContext(store: Store, panelId: string): PanelContext {
  const panel = store.panels.require(panelId);
  const page = store.pages.require(panel.pageId);
  const manga = store.mangas.require(page.mangaId);
  const ids = [...new Set([...panel.script.characters.map((c) => c.characterId), ...panel.refCharacterIds])];
  const characters = ids
    .map((id) => store.characters.get(id))
    .filter((c): c is Character => c !== null && c.mangaId === manga.id);
  const hasRef = (c: Character): boolean => [c.refs.portrait, c.refs.fullbody].some((id) => id !== undefined && store.images.get(id) !== null);
  const refCharacters = panel.refCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => c !== undefined && hasRef(c));
  return { panel, page, manga, characters, refCharacters };
}

export interface PickedRef { imageId: string; character: Character }

/** One character → its portrait and full body; several → one image each (portrait first). Capped at recipe.maxRefs. */
export function pickRefs(store: Store, recipe: Recipe, refCharacters: Character[]): PickedRef[] {
  if (recipe.maxRefs === 0) return [];
  const usable = (id: string | undefined): id is string => id !== undefined && store.images.get(id) !== null;
  const only = refCharacters.length === 1 ? refCharacters[0]! : null;
  const picked: PickedRef[] = only
    ? [only.refs.portrait, only.refs.fullbody].filter(usable).map((imageId) => ({ imageId, character: only }))
    : refCharacters.flatMap((character) => {
      const imageId = [character.refs.portrait, character.refs.fullbody].find(usable);
      return imageId ? [{ imageId, character }] : [];
    });
  return picked.slice(0, recipe.maxRefs);
}

/**
 * Style LoRAs (the manga/anima book-level LoRA in `manga.styleGuide.loras`) only make sense for a recipe built on
 * the same model family as the style guide's own recipe — WAI's manga LoRA on Anima (or vice versa) would either
 * no-op or corrupt the image. Apply it only when the families match; otherwise the recipe generates without it.
 */
export function styleLoras(manga: Manga, recipeId: string): LoraRef[] {
  return RECIPES[recipeId]?.family === RECIPES[manga.styleGuide.recipe]?.family ? manga.styleGuide.loras : [];
}
