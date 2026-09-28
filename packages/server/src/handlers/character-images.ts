import {
  BASE_NEGATIVE, assemblePrompt,
  type Character, type CharacterRefsPayload, type CharacterRefsResult, type ImageGenerateResult, type LoraRef, type Manga,
} from '@manga/shared';
import { generateImage } from '../imaging/generate.js';
import { PORTRAIT_SIZE } from '../imaging/size.js';
import { PermanentError, type JobContext } from '../jobs/index.js';
import { emitEntity, nonEmpty, styleLoras } from './context.js';
import type { HandlerServices } from './types.js';

/** Spec §6.4: bust, front view, plain background. */
export const PORTRAIT_SCENE = 'solo, upper body, portrait, looking at viewer, facing viewer, simple background, white background';
export const FULLBODY_SCENE = 'solo, full body, standing, front view, facing viewer, arms at sides, simple background, white background';
export const SHEET_NEGATIVE = 'multiple views, 2girls, 2boys, multiple persons, cropped head, out of frame';
export const VIEW_INSTRUCTION: Record<'side' | 'back', string> = {
  side: 'Show the same character as in picture 1 and picture 2: full body, standing, seen exactly from the side in right profile view, plain white background. Keep the face, hair, outfit and colours exactly as in the pictures.',
  back: 'Show the same character as in picture 1 and picture 2: full body, standing, seen from directly behind (back view, face not visible), plain white background. Keep the hair, outfit and colours exactly as in the pictures.',
};
/** Side/back views (qwen-edit-ref) already keep the look from the two reference pictures (VIEW_INSTRUCTION says
 *  so); appending the appearance tags as text made Qwen follow the tags over the pictures instead (live evidence:
 *  a B&W manga's navy-uniform tag turned the side/back views into flat colour anime instead of inked B&W). For a
 *  B&W manga only, this one style sentence steers the drawing style itself (which the pictures, being SDXL/anime
 *  renders, don't carry) without re-describing the character. */
export const BW_VIEW_STYLE = 'Draw it as a black-and-white manga illustration: black ink lineart with screentone shading on white, in the same drawing style as the pictures.';
export const SLOT_LABEL: Record<'fullbody' | 'side' | 'back', string> = { fullbody: 'Full body', side: 'Side view', back: 'Back view' };

/** Recipes that can draw a character from tags alone (no reference image required) — candidates for the portrait's default. */
const PORTRAIT_RECIPES = new Set(['anime', 'anima', 'anima-turbo', 'klein-ref']);

type Slot = 'fullbody' | 'side' | 'back';
interface SlotSpec { recipe: string; prompt: string; negative: string; refImageIds: string[]; loras: LoraRef[] }

function usableImage(ctx: JobContext, id: string | undefined): string | null {
  return id !== undefined && ctx.store.images.get(id) !== null ? id : null;
}

function slotSpec(ctx: JobContext, character: Character, manga: Manga, slot: Slot): SlotSpec {
  const portrait = usableImage(ctx, character.refs.portrait);
  if (!portrait) throw new PermanentError(`${character.name} has no portrait yet: generate portraits and pick one first`);
  if (slot === 'fullbody') {
    const { prompt, negative } = assemblePrompt({
      styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags: [character.appearanceTags].filter(nonEmpty),
      scene: FULLBODY_SCENE, extraNegative: SHEET_NEGATIVE,
    });
    return { recipe: 'anime-ref', prompt, negative, refImageIds: [portrait], loras: styleLoras(manga, 'anime-ref') };
  }
  const fullbody = usableImage(ctx, character.refs.fullbody);
  if (!fullbody) throw new PermanentError(`${character.name} has no full-body reference yet: generate the sheet's full-body view first`);
  const prompt = [VIEW_INSTRUCTION[slot], manga.colorMode === 'bw' ? BW_VIEW_STYLE : ''].filter(nonEmpty).join(' ');
  return { recipe: 'qwen-edit-ref', prompt, negative: BASE_NEGATIVE, refImageIds: [portrait, fullbody], loras: [] };
}

/**
 * Spec §6.4: bust, front view, plain background, from `appearanceTags` + `seed` — never auto-picked as a ref.
 * F6 (controller ruling, clarified 2026-09-28): "anime" unless the character has a prompt-only recipe set —
 * `character.recipe` wins when it is set and can draw from tags alone; otherwise fall back to the manga's own
 * style recipe when that can too, else 'anime'. Style LoRAs go through `styleLoras()` with the final recipe so
 * they never cross onto a mismatched family (e.g. an 'anima' portrait in an SDXL-styled manga gets no LoRA).
 */
export async function generatePortrait(
  ctx: JobContext, services: HandlerServices, p: { characterId: string; seed?: number | null },
): Promise<ImageGenerateResult> {
  const character = ctx.store.characters.require(p.characterId);
  const manga = ctx.store.mangas.require(character.mangaId);
  const recipe = character.recipe && PORTRAIT_RECIPES.has(character.recipe)
    ? character.recipe
    : PORTRAIT_RECIPES.has(manga.styleGuide.recipe) ? manga.styleGuide.recipe : 'anime';
  const { prompt, negative } = assemblePrompt({
    styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags: [character.appearanceTags].filter(nonEmpty),
    scene: PORTRAIT_SCENE, extraNegative: SHEET_NEGATIVE,
  });
  const [width, height] = PORTRAIT_SIZE;
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: manga.id, owner: { type: 'character', id: character.id }, role: 'portrait', recipe, prompt, negative, width, height,
    seed: p.seed ?? character.seed, loras: styleLoras(manga, recipe), refImageIds: [], control: null, initImageId: null, denoise: null, upscale: null,
  }, { signal: ctx.signal, progress: ctx.progress });
  emitEntity(ctx.bus, 'image', image.id, 'created', manga.id);
  return { imageId: image.id };
}

/**
 * Spec §6.4: fullbody via anime-ref from the portrait, then side/back via qwen-edit-ref from portrait + full
 * body — each becomes the character's ref straight away since the next view needs the previous one.
 */
export async function generateSlot(
  ctx: JobContext, services: HandlerServices, p: { characterId: string; slot: Slot },
): Promise<ImageGenerateResult> {
  const character = ctx.store.characters.require(p.characterId);
  const manga = ctx.store.mangas.require(character.mangaId);
  const spec = slotSpec(ctx, character, manga, p.slot);
  const [width, height] = PORTRAIT_SIZE;
  const image = await generateImage({ store: ctx.store, comfy: services.requireComfy(), gpu: ctx.gpu }, {
    mangaId: manga.id, owner: { type: 'character', id: character.id }, role: p.slot, recipe: spec.recipe, prompt: spec.prompt,
    negative: spec.negative, width, height, seed: character.seed, loras: spec.loras, refImageIds: spec.refImageIds,
    control: null, initImageId: null, denoise: null, upscale: null,
  }, { signal: ctx.signal, progress: ctx.progress });
  emitEntity(ctx.bus, 'image', image.id, 'created', manga.id);

  // One transaction re-checks the character still exists (it may have been deleted during the long generation)
  // before writing the ref back (M1 owner-recheck pattern, G1; controller ruling, Task 18).
  ctx.store.tx(() => {
    const latest = ctx.store.characters.require(character.id);
    ctx.store.characters.update(character.id, { refs: { ...latest.refs, [p.slot]: image.id } });
  });
  emitEntity(ctx.bus, 'character', character.id, 'updated', manga.id);
  return { imageId: image.id };
}

/**
 * The `character.refs` job: fullbody → side → back in one job. A retry (M6) keeps the views an earlier attempt of
 * this same job already made — a slot whose ref points at an image created since the job was queued — so it redoes
 * only the failed view and after, instead of regenerating the full body and leaving duplicate variants.
 */
export async function generateCharacterRefs(
  ctx: JobContext, services: HandlerServices, p: CharacterRefsPayload,
): Promise<CharacterRefsResult> {
  const slots = ['fullbody', 'side', 'back'] as const;
  const imageIds: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const refId = ctx.store.characters.require(p.characterId).refs[slot];
    const made = refId ? ctx.store.images.get(refId) : null;
    if (made && made.createdAt >= ctx.job.createdAt) {
      imageIds.push(made.id);
      continue;
    }
    const step: JobContext = {
      ...ctx,
      progress: (label, value, max) => ctx.progress(`${SLOT_LABEL[slot]} (${index + 1}/${slots.length}): ${label}`, value, max),
    };
    imageIds.push((await generateSlot(step, services, { characterId: p.characterId, slot })).imageId);
  }
  return { imageIds };
}
