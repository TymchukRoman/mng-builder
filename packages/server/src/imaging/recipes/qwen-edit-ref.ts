import { SDXL_SIZES } from '@manga/shared';
import type { Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type Recipe } from './types.js';

/**
 * From ComfyUI's image_qwen_image_edit_2511 template, with the Q5 GGUF and the 8-step Lightning LoRA.
 *
 * P1 alignment (claude-image-gen graph.py `_qwen_edit`, smoke-verified): the first reference is
 * scaled with FluxKontextImageScale before either text encoder sees it, and the negative is its own
 * TextEncodeQwenImageEditPlus(p.negative, same images) run through the same reference-method node as
 * the positive — not a ConditioningZeroOut.
 */
export const QWEN_EDIT = { shift: 3.1, cfgNorm: 1, loraStrength: 1, sampler: 'euler', scheduler: 'simple', referenceMethod: 'index_timestep_zero' } as const;

export const qwenEditRef: Recipe = {
  id: 'qwen-edit-ref', label: 'Qwen Image Edit 2511 (1-3 references)', family: 'qwen',
  maxRefs: 3, requiresRefs: true, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
  defaults: { steps: 8, cfg: 1 }, sizes: SDXL_SIZES,
  build(p) {
    if (p.refs.length === 0) throw new RecipeInputError('qwen-edit-ref needs 1-3 reference images');
    const g = new GraphBuilder();
    const unet = g.add('UnetLoaderGGUF', { unet_name: MODELS.qwenEditGguf });
    const clip = g.add('CLIPLoader', { clip_name: MODELS.qwenVlEncoder, type: 'qwen_image', device: 'default' });
    const vae = g.add('VAELoader', { vae_name: MODELS.qwenImageVae });
    const shifted = g.add('ModelSamplingAuraFlow', { model: out(unet), shift: QWEN_EDIT.shift });
    const normed = g.add('CFGNorm', { model: out(shifted), strength: QWEN_EDIT.cfgNorm });
    const model = g.add('LoraLoaderModelOnly', { model: out(normed), lora_name: MODELS.qwenEditLightning, strength_model: QWEN_EDIT.loraStrength });

    const pictures: Record<string, Link> = {};
    p.refs.slice(0, 3).forEach((ref, i) => {
      pictures[`image${i + 1}`] = out(g.add('LoadImage', { image: ref }));
    });
    // P1: only the first reference feeds FluxKontextImageScale before reaching the encoders.
    const firstRef = pictures['image1'];
    if (firstRef) pictures['image1'] = out(g.add('FluxKontextImageScale', { image: firstRef }));

    const positiveEncoded = g.add('TextEncodeQwenImageEditPlus', { clip: out(clip), prompt: p.prompt, vae: out(vae), ...pictures });
    const negativeEncoded = g.add('TextEncodeQwenImageEditPlus', { clip: out(clip), prompt: p.negative, vae: out(vae), ...pictures });
    const positive = g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: out(positiveEncoded), reference_latents_method: QWEN_EDIT.referenceMethod });
    const negative = g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: out(negativeEncoded), reference_latents_method: QWEN_EDIT.referenceMethod });

    const latent = g.add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 });
    const sampled = g.add('KSampler', {
      model: out(model), seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: QWEN_EDIT.sampler, scheduler: QWEN_EDIT.scheduler,
      positive: out(positive), negative: out(negative), latent_image: out(latent), denoise: 1,
    });
    const decoded = g.add('VAEDecode', { samples: out(sampled), vae: out(vae) });
    g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
