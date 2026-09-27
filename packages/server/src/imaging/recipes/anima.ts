import { SDXL_SIZES } from '@manga/shared';
import type { ComfyGraph } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import type { Recipe, RecipeParams } from './types.js';

/** From ComfyUI's image_anima_base_v1 and image_anima_lllite_any_control_to_image templates. */
export const ANIMA = { sampler: 'euler', scheduler: 'simple', clipType: 'stable_diffusion' } as const;

/**
 * P1 alignment (claude-image-gen graph.py `_anima`, smoke-verified): the LLLite control patch is
 * applied to the base model first, before any LoRA, and the LoRA chain that follows is
 * model-only (LoraLoaderModelOnly) — the CLIP text encoders always read the raw CLIPLoader output.
 */
export function buildAnima(unetName: string, p: RecipeParams): ComfyGraph {
  const g = new GraphBuilder();
  const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' });
  const clipLoader = g.add('CLIPLoader', { clip_name: MODELS.animaEncoder, type: ANIMA.clipType, device: 'default' });
  const vae = g.add('VAELoader', { vae_name: MODELS.qwenImageVae });
  const clip = out(clipLoader);
  let model = out(unet);
  if (p.control) {
    const guide = g.add('LoadImage', { image: p.control.image });
    const patch = g.add('ModelPatchLoader', { name: p.control.kind === 'pose' ? MODELS.animaPose : MODELS.animaLineart });
    model = out(g.add('AnimaLLLiteApply', {
      model, model_patch: out(patch), image: out(guide), strength: p.control.strength, start_percent: 0, end_percent: 1,
    }));
  }
  for (const lora of p.loras) {
    model = out(g.add('LoraLoaderModelOnly', { model, lora_name: lora.name, strength_model: lora.strength }));
  }
  const positive = g.add('CLIPTextEncode', { text: p.prompt, clip });
  const negative = g.add('CLIPTextEncode', { text: p.negative, clip });
  const latent = g.add('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 });
  const sampled = g.add('KSampler', {
    model, seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: ANIMA.sampler, scheduler: ANIMA.scheduler,
    positive: out(positive), negative: out(negative), latent_image: out(latent), denoise: 1,
  });
  const decoded = g.add('VAEDecode', { samples: out(sampled), vae: out(vae) });
  g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
  return g.graph;
}

export const anima: Recipe = {
  id: 'anima', label: 'Anima (aesthetic v1.1)', family: 'anima',
  maxRefs: 0, requiresRefs: false, supportsPose: true, supportsLineart: true, supportsLoras: true, supportsInit: false,
  defaults: { steps: 30, cfg: 4 }, sizes: SDXL_SIZES,
  build: (p) => buildAnima(MODELS.animaAesthetic, p),
};
