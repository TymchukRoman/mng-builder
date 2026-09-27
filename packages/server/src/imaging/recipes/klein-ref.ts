import { SDXL_SIZES } from '@manga/shared';
import type { Link } from '../comfy-graph.js';
import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import type { Recipe } from './types.js';

/** From ComfyUI's image_flux2_klein_image_edit_4b_distilled template (matches claude-image-gen graph.py `_flux2` exactly). */
export const KLEIN = { sampler: 'euler', scaleMethod: 'nearest-exact', megapixels: 1 } as const;

export const kleinRef: Recipe = {
  id: 'klein-ref', label: 'FLUX.2 klein 4B (references)', family: 'flux2',
  maxRefs: 4, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
  defaults: { steps: 4, cfg: 1 }, sizes: SDXL_SIZES,
  build(p) {
    const g = new GraphBuilder();
    const unet = g.add('UNETLoader', { unet_name: MODELS.klein, weight_dtype: 'default' });
    const clip = g.add('CLIPLoader', { clip_name: MODELS.kleinEncoder, type: 'flux2', device: 'default' });
    const vae = g.add('VAELoader', { vae_name: MODELS.flux2Vae });
    const text = g.add('CLIPTextEncode', { text: p.prompt, clip: out(clip) });
    let positive: Link = out(text);
    let negative: Link = out(g.add('ConditioningZeroOut', { conditioning: out(text) }));
    for (const ref of p.refs.slice(0, 4)) {
      const loaded = g.add('LoadImage', { image: ref });
      const scaled = g.add('ImageScaleToTotalPixels', { image: out(loaded), upscale_method: KLEIN.scaleMethod, megapixels: KLEIN.megapixels, resolution_steps: 1 });
      const latent = g.add('VAEEncode', { pixels: out(scaled), vae: out(vae) });
      positive = out(g.add('ReferenceLatent', { conditioning: positive, latent: out(latent) }));
      negative = out(g.add('ReferenceLatent', { conditioning: negative, latent: out(latent) }));
    }
    const guider = g.add('CFGGuider', { model: out(unet), positive, negative, cfg: p.cfg });
    const sampler = g.add('KSamplerSelect', { sampler_name: KLEIN.sampler });
    const sigmas = g.add('Flux2Scheduler', { steps: p.steps, width: p.width, height: p.height });
    const noise = g.add('RandomNoise', { noise_seed: p.seed });
    const empty = g.add('EmptyFlux2LatentImage', { width: p.width, height: p.height, batch_size: 1 });
    const sampled = g.add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sigmas), latent_image: out(empty) });
    const decoded = g.add('VAEDecode', { samples: out(sampled, 0), vae: out(vae) });
    g.add('SaveImage', { images: out(decoded), filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
