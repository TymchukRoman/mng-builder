import { z } from 'zod';
import { ENGLISH_SCENE_MESSAGE, isEnglishScene } from '@manga/shared';
import { InvalidOutputError } from '../engines/errors.js';
import { RECIPES } from '../imaging/recipes/index.js';
import { promptStyleFor, routeRecipe, type PromptStyle } from '../imaging/route.js';
import { PermanentError } from '../jobs/index.js';
import type { LlmStepHandler } from '../jobs/llm-step.js';
import { loadPrompt } from '../prompts/load.js';
import { finishScene, preferEnglish } from '../prompts/scene.js';
import { scriptBlock } from '../prompts/script-block.js';
import type { Store } from '../store/index.js';
import { emitEntity, panelContext, pickRefs, type PanelContext } from './context.js';
import type { HandlerServices } from './types.js';

export const PanelPromptOutputSchema = z.object({ scene: z.string().min(1) });

/**
 * The schema the LLM's answer must meet: a scene that mixes in Cyrillic keeps its English part, and one with no usable
 * English (a Ukrainian book's model following the Ukrainian script, Roman's Вельм run) goes back through the engine's
 * correction round. Its JSON Schema is PanelPromptOutputSchema's.
 */
export const PanelPromptAnswerSchema: z.ZodType<z.infer<typeof PanelPromptOutputSchema>> = z.preprocess(
  (v) => (typeof v === 'object' && v !== null && typeof (v as { scene?: unknown }).scene === 'string'
    ? { ...v, scene: preferEnglish((v as { scene: string }).scene) } : v),
  PanelPromptOutputSchema.superRefine((v, ctx) => {
    if (!isEnglishScene(v.scene)) ctx.addIssue({ code: 'custom', path: ['scene'], message: ENGLISH_SCENE_MESSAGE });
  }),
);

export function panelPromptRequest(store: Store, pc: PanelContext, recipeId: string, style: PromptStyle): string {
  const lines = [scriptBlock(pc.panel.script, pc.characters)];
  if (style === 'natural') {
    const recipe = RECIPES[recipeId];
    const picked = recipe ? pickRefs(store, recipe, pc.refCharacters) : [];
    lines.push('', 'Reference pictures:');
    if (picked.length === 0) lines.push('- none');
    picked.forEach((ref, i) => lines.push(`- picture ${i + 1} shows ${ref.character.name}`));
  }
  lines.push('', style === 'tags' ? 'Write the scene tags for this panel.' : 'Write the scene sentences for this panel.');
  return lines.join('\n');
}

/**
 * Spec §9.2 "AI write prompt": the scene style follows the recipe the panel will route to — Danbooru tags for
 * SDXL/Anima, plain sentences (with "picture N shows <name>") for Qwen/klein so the model can refer to reference
 * pictures without describing them. Whatever the model answers is sanitized again in code — forbidden words are
 * stripped regardless of what the system prompt asked for — before it ever reaches the image model.
 */
export function panelPromptStep(services: HandlerServices): LlmStepHandler {
  return async (ctx, payload) => {
    if (payload.type !== 'panel-prompt') throw new PermanentError(`panel-prompt step received a "${payload.type}" payload`);
    const pc = panelContext(ctx.store, payload.panelId);
    const settings = ctx.store.settings.get();
    const { recipe } = routeRecipe({
      settings, manga: pc.manga, panel: pc.panel, refCount: pc.refCharacters.length, charCount: pc.characters.length, imageModel: pc.imageModel,
    });
    const style = promptStyleFor(recipe);
    const engine = services.engines.forLane(ctx.job.lane); // I1: the job's lane decides the engine
    ctx.progress('Writing the image prompt');
    const out = await engine.completeJson({
      name: 'panel-prompt', task: 'prompts', system: loadPrompt(style === 'tags' ? 'panel-prompt-tags' : 'panel-prompt-natural'),
      prompt: panelPromptRequest(ctx.store, pc, recipe, style), schema: PanelPromptAnswerSchema,
      signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    // I2: the script decides shot and angle (finishScene drops the model's framing and puts the script's first).
    const scene = finishScene(style, pc.panel.script.shot, pc.panel.script.angle, out.scene);
    if (scene === null) throw new InvalidOutputError('panel-prompt: the AI wrote no usable scene', out.scene);

    // One transaction re-checks the panel still exists (it may have been deleted during the LLM call) before
    // writing the scene back. The negative is re-read fresh inside the transaction so a concurrent edit to it
    // during the (possibly long) LLM call is never clobbered (M1 owner-recheck pattern, G1; controller ruling,
    // Task 20 addition). A deleted panel rejects with NotFoundError instead of crashing.
    ctx.store.tx(() => {
      const current = ctx.store.panels.require(pc.panel.id);
      ctx.store.panels.update(current.id, { prompt: { scene, negative: current.prompt.negative } });
    });
    emitEntity(ctx.bus, 'panel', pc.panel.id, 'updated', pc.manga.id);
    return { scene };
  };
}
