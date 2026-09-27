import { GraphBuilder, out } from './graph.js';
import { MODELS } from './models.js';
import { RecipeInputError, type Recipe } from './types.js';

/** 4x-AnimeSharp; factor 2 = 4x then lanczos 0.5 (as P1's --upscale 2). */
export const upscale: Recipe = {
  id: 'upscale', label: 'Upscale (4x-AnimeSharp)', family: 'upscale',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: true,
  defaults: { steps: 1, cfg: 1 }, sizes: [],
  build(p) {
    if (!p.init) throw new RecipeInputError('upscale needs an input image');
    const g = new GraphBuilder();
    const input = g.add('LoadImage', { image: p.init.image });
    const upscaler = g.add('UpscaleModelLoader', { model_name: MODELS.animeSharp });
    let image = out(g.add('ImageUpscaleWithModel', { upscale_model: out(upscaler), image: out(input) }));
    if (p.upscale === 2) image = out(g.add('ImageScaleBy', { image, upscale_method: 'lanczos', scale_by: 0.5 }));
    g.add('SaveImage', { images: image, filename_prefix: p.filenamePrefix });
    return g.graph;
  },
};
