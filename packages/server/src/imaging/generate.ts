import { newId, type GenParams, type Image, type LoraRef, type RefSlot } from '@manga/shared';
import { removeFiles } from '../domain/delete.js';
import { PermanentError, type GpuArbiter, type JobContext } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import type { ComfyClient } from './comfy.js';
import type { ComfyGraph } from './comfy-graph.js';
import { createImageWithId } from './image-row.js';
import { pngSize } from './png-size.js';
import { RECIPES, type Recipe, type RecipeParams } from './recipes/index.js';

/** M1's seed helper (never re-defined here — see M2 Task 15 controller ruling F17/G3). */
export { randomSeed } from '../domain/seed.js';

/** IP-Adapter weight for anime-ref. Decided from the P1 bake-off: at 0.7 the IP-Adapter copies the reference's
 *  pose; 0.4 keeps identity and follows the requested scene (best B&W identity combined with the style LoRA). */
export const DEFAULT_REF_WEIGHT = 0.4;

export interface GenerateRequest {
  mangaId: string;
  owner: { type: 'character' | 'panel'; id: string };
  role: RefSlot | null;
  recipe: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  loras: LoraRef[];
  refImageIds: string[];
  control: GenParams['control'];
  initImageId: string | null;
  denoise: number | null;
  upscale: 2 | 4 | null;
  /** Overrides DEFAULT_REF_WEIGHT for recipes with an IP-Adapter. */
  refWeight?: number;
}

export interface GenerateDeps { store: Store; comfy: ComfyClient; gpu: GpuArbiter }
export interface GenerateContext { signal: AbortSignal; progress: JobContext['progress'] }

function check(recipe: Recipe, req: GenerateRequest): void {
  if (req.refImageIds.length > recipe.maxRefs) {
    throw new PermanentError(`${recipe.label} takes at most ${recipe.maxRefs} reference image(s); got ${req.refImageIds.length}`);
  }
  if (recipe.requiresRefs && req.refImageIds.length === 0) throw new PermanentError(`${recipe.label} needs at least one reference image`);
  if (req.control?.kind === 'pose' && !recipe.supportsPose) throw new PermanentError(`${recipe.label} does not take a pose image`);
  if (req.control?.kind === 'lineart' && !recipe.supportsLineart) throw new PermanentError(`${recipe.label} does not take a lineart image`);
  if (req.initImageId !== null && !recipe.supportsInit) throw new PermanentError(`${recipe.label} does not take an input image`);
}

/** The owner may be deleted while a long generation is in flight (M1 `saveUploadedImage` pattern, G1). */
function requireOwner(store: Store, owner: GenerateRequest['owner']): void {
  if (owner.type === 'panel') store.panels.require(owner.id);
  else store.characters.require(owner.id);
}

/** The one entry point for creating Image rows from ComfyUI output (Contract C.7). */
export async function generateImage(deps: GenerateDeps, req: GenerateRequest, ctx: GenerateContext): Promise<Image> {
  const recipe = RECIPES[req.recipe];
  if (!recipe) throw new PermanentError(`Unknown recipe "${req.recipe}"`);
  check(recipe, req);
  const { store, comfy, gpu } = deps;
  const loras = recipe.supportsLoras ? req.loras : [];

  await comfy.ensureServer((label) => ctx.progress(label));
  await gpu.acquire('comfy');
  await comfy.prepareFor(recipe.family);

  const upload = (imageId: string): Promise<string> => comfy.uploadImage(store.files.abs(store.images.require(imageId).path));
  if (req.refImageIds.length > 0 || req.control !== null || req.initImageId !== null) ctx.progress('Uploading images');
  const refs: string[] = [];
  for (const id of req.refImageIds) refs.push(await upload(id));
  const control = req.control ? { kind: req.control.kind, image: await upload(req.control.imageId), strength: req.control.strength } : null;
  const init = req.initImageId ? { image: await upload(req.initImageId), denoise: req.denoise ?? 1 } : null;
  const refWeight = req.refWeight ?? DEFAULT_REF_WEIGHT;

  const params: RecipeParams = {
    prompt: req.prompt, negative: req.negative, width: req.width, height: req.height, seed: req.seed,
    steps: recipe.defaults.steps, cfg: recipe.defaults.cfg, loras, refs, refWeight,
    control, init, upscale: req.upscale, filenamePrefix: `manga-builder/${req.mangaId}/${req.owner.id}`,
  };
  let graph: ComfyGraph;
  try {
    graph = recipe.build(params);
  } catch (err) {
    throw new PermanentError(`${recipe.id}: ${(err as Error).message}`);
  }

  const result = await comfy.run(graph, { signal: ctx.signal, onProgress: ctx.progress });
  const bytes = result.images[0];
  if (!bytes) throw new PermanentError('ComfyUI returned no image');
  const size = pngSize(bytes);
  const id = newId('im');
  const path = store.files.writeImage(req.mangaId, id, bytes);
  const gen: GenParams = {
    recipe: recipe.id, prompt: req.prompt, negative: req.negative, seed: req.seed, steps: params.steps, cfg: params.cfg,
    width: req.width, height: req.height, loras, refs: [...req.refImageIds], control: req.control, initImageId: req.initImageId,
    denoise: init && recipe.family !== 'upscale' ? init.denoise : null, comfyPromptId: result.promptId, durationMs: result.durationMs,
  };

  // One transaction re-checks the owner still exists (it may have been deleted during the long generation), then
  // inserts the row. On any failure the file just written is removed and the error rethrown (M1 uploads pattern).
  try {
    return store.tx(() => {
      requireOwner(store, req.owner);
      return createImageWithId(store, id, {
        mangaId: req.mangaId, ownerType: req.owner.type, ownerId: req.owner.id, role: req.role, path, width: size.width, height: size.height,
        source: req.upscale ? 'upscaled' : 'generated', parentImageId: req.upscale ? req.initImageId : null, gen, review: null,
      });
    });
  } catch (err) {
    removeFiles(store, [path]);
    throw err;
  }
}
