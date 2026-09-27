import type { ComfyGraph, Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type RecipeParams } from './types.js';

/** WAI-illustrious v17 settings from the P1 design (§4.4): 28 steps, cfg 5.5, euler_ancestral/normal, CLIP skip 2. */
export const SDXL_DEFAULTS = { steps: 28, cfg: 5.5 } as const;
export const SDXL_SAMPLER = 'euler_ancestral';
export const SDXL_SCHEDULER = 'normal';
export const CLIP_SKIP = -2;
/**
 * P1 alignment (claude-image-gen graph.py `_ipadapter`, smoke-verified): references are loaded
 * straight into IPAdapterAdvanced, batched (not pre-processed through PrepImageForClipVision),
 * and their embeddings concatenated rather than averaged.
 */
export const IPADAPTER = {
  weightType: 'linear',
  combineEmbeds: 'concat',
  embedsScaling: 'V only',
} as const;

export interface SdxlFeatures {
  ipAdapter: 'none' | 'optional' | 'required';
  pose: 'none' | 'required';
  init: 'none' | 'optional' | 'required';
}

/** noobIPA on WAI: each reference loads directly, batched when there are two, then IP-Adapter concatenates their embeddings. */
export function addIpAdapter(g: GraphBuilder, model: Link, refs: string[], weight: number): Link {
  const ipadapter = g.add('IPAdapterModelLoader', { ipadapter_file: MODELS.noobIpa });
  const clipVision = g.add('CLIPVisionLoader', { clip_name: MODELS.clipVisionBigG });
  const loaded: Link[] = refs.slice(0, 2).map((ref) => out(g.add('LoadImage', { image: ref })));
  const [first, second] = loaded;
  if (!first) throw new RecipeInputError('IP-Adapter needs at least one reference image');
  const image = second ? out(g.add('ImageBatch', { image1: first, image2: second })) : first;
  return out(g.add('IPAdapterAdvanced', {
    model, ipadapter: out(ipadapter), image, weight, weight_type: IPADAPTER.weightType,
    combine_embeds: IPADAPTER.combineEmbeds, start_at: 0, end_at: 1, embeds_scaling: IPADAPTER.embedsScaling, clip_vision: out(clipVision),
  }));
}

export function buildSdxl(id: string, p: RecipeParams, f: SdxlFeatures): ComfyGraph {
  if (f.ipAdapter === 'required' && p.refs.length === 0) throw new RecipeInputError(`${id} needs 1-2 reference images`);
  if (f.pose === 'required' && p.control?.kind !== 'pose') throw new RecipeInputError(`${id} needs a pose image`);
  if (f.init === 'required' && !p.init) throw new RecipeInputError(`${id} needs an input image`);

  const g = new GraphBuilder();
  const checkpoint = g.add('CheckpointLoaderSimple', { ckpt_name: MODELS.waiCheckpoint });
  let model = out(checkpoint, 0);
  let clip = out(checkpoint, 1);
  const vae = out(checkpoint, 2);
  for (const lora of p.loras) {
    const loader = g.add('LoraLoader', { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength });
    model = out(loader, 0);
    clip = out(loader, 1);
  }
  clip = out(g.add('CLIPSetLastLayer', { clip, stop_at_clip_layer: CLIP_SKIP }));
  if (f.ipAdapter !== 'none' && p.refs.length > 0) model = addIpAdapter(g, model, p.refs, p.refWeight);

  let positive = out(g.add('CLIPTextEncode', { text: p.prompt, clip }));
  let negative = out(g.add('CLIPTextEncode', { text: p.negative, clip }));
  if (f.pose !== 'none' && p.control?.kind === 'pose') {
    const controlNet = g.add('ControlNetLoader', { control_net_name: MODELS.noobOpenpose });
    const pose = g.add('LoadImage', { image: p.control.image });
    const apply = g.add('ControlNetApplyAdvanced', {
      positive, negative, control_net: out(controlNet), image: out(pose), strength: p.control.strength, start_percent: 0, end_percent: 1, vae,
    });
    positive = out(apply, 0);
    negative = out(apply, 1);
  }

  let latent: Link;
  let denoise = 1;
  if (f.init !== 'none' && p.init) {
    const init = g.add('LoadImage', { image: p.init.image });
    latent = out(g.add('VAEEncode', { pixels: out(init), vae }));
    denoise = p.init.denoise;
  } else {
    latent = out(g.add('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 }));
  }
  const sampled = g.add('KSampler', {
    model, seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: SDXL_SAMPLER, scheduler: SDXL_SCHEDULER,
    positive, negative, latent_image: latent, denoise,
  });
  const decoded = g.add('VAEDecode', { samples: out(sampled), vae });
  g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
  return g.graph;
}
