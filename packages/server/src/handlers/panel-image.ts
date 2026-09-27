import { assemblePrompt, type ImageGeneratePayload, type ImageGenerateResult } from '@manga/shared';
import { generateImage, randomSeed, type GenerateRequest } from '../imaging/generate.js';
import { RECIPES } from '../imaging/recipes/index.js';
import { refineFor, routeRecipe } from '../imaging/route.js';
import { panelSize } from '../imaging/size.js';
import { PermanentError, type JobContext } from '../jobs/index.js';
import { emitEntity, nonEmpty, panelContext, pickRefs, styleLoras } from './context.js';
import type { HandlerServices } from './types.js';

/** Spec §6.1: "WAI img2img, denoise ≈0.3 + manga LoRA". */
export const REFINE_DENOISE = 0.3;

export async function generatePanelImage(
  ctx: JobContext, services: HandlerServices, p: Extract<ImageGeneratePayload, { target: 'panel' }>,
): Promise<ImageGenerateResult> {
  const { store, bus } = ctx;
  const { panel, page, manga, characters, refCharacters } = panelContext(store, p.panelId);
  const settings = store.settings.get();
  const route = routeRecipe({ settings, manga, panel, refCount: refCharacters.length, charCount: characters.length });
  const recipeId = p.recipe ?? route.recipe;
  const recipe = RECIPES[recipeId];
  if (!recipe) throw new PermanentError(`Unknown recipe "${recipeId}"`);
  // routeRecipe already validated route.refineWith; only the payload-recipe path (which bypasses it) needs a check here.
  const refineWith = p.recipe ? refineFor(settings, manga, recipeId) : route.refineWith;
  if (refineWith !== null && !RECIPES[refineWith]) throw new PermanentError(`Unknown refine recipe "${refineWith}" (settings.routing.bwRefine)`);

  const scene = [panel.prompt.scene, p.sceneSuffix].filter(nonEmpty).join(', ');
  const extraNegative = [panel.prompt.negative, p.negativeExtra].filter(nonEmpty).join(', ');
  const characterTags = characters.map((c) => c.appearanceTags).filter(nonEmpty);
  const { prompt, negative } = assemblePrompt({
    styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags, scene,
    ...(extraNegative ? { extraNegative } : {}),
  });
  const seed = p.seed ?? (panel.seedLock ? panel.seed : randomSeed());
  const [width, height] = panelSize(page, manga.pageFormat, panel.id, recipe);
  const deps = { store, comfy: services.requireComfy(), gpu: ctx.gpu };
  const io = { signal: ctx.signal, progress: ctx.progress };
  const base: Omit<GenerateRequest, 'recipe' | 'width' | 'height' | 'refImageIds' | 'initImageId' | 'denoise' | 'loras' | 'prompt' | 'negative'> = {
    mangaId: manga.id, owner: { type: 'panel', id: panel.id }, role: null, seed, control: null, upscale: null,
  };

  const first = await generateImage(deps, {
    ...base, recipe: recipeId, prompt, negative, width, height, loras: styleLoras(manga, recipeId),
    refImageIds: pickRefs(store, recipe, refCharacters).map((r) => r.imageId), initImageId: null, denoise: null,
  }, io);
  emitEntity(bus, 'image', first.id, 'created', manga.id);

  let active = first;
  if (refineWith) {
    ctx.progress('Refining ink and screentone');
    // F7: the refine pass reuses the style + B&W tokens + appearance tags, not the qwen/klein natural-language scene.
    const refine = assemblePrompt({ styleGuide: manga.styleGuide, colorMode: manga.colorMode, characterTags, scene: '' });
    active = await generateImage(deps, {
      ...base, recipe: refineWith, prompt: refine.prompt, negative: refine.negative, width: first.width, height: first.height,
      loras: styleLoras(manga, refineWith), refImageIds: [], initImageId: first.id, denoise: REFINE_DENOISE,
    }, io);
    emitEntity(bus, 'image', active.id, 'created', manga.id);
  }

  // One transaction re-checks the panel still exists (it may have been deleted during the long generation) before
  // writing the seed and active image back (M1 owner-recheck pattern, G1).
  store.tx(() => {
    store.panels.require(panel.id);
    store.panels.update(panel.id, { activeImageId: active.id, seed });
  });
  emitEntity(bus, 'panel', panel.id, 'updated', manga.id);
  return { imageId: active.id };
}
