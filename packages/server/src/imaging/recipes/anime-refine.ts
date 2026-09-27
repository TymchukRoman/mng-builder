import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

/** WAI img2img at low denoise with the manga LoRA: restores ink and screentone after qwen-edit-ref / klein-ref. */
export const animeRefine: Recipe = {
  id: 'anime-refine', label: 'Anime refine (img2img)', family: 'sdxl',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: true,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-refine', p, { ipAdapter: 'none', pose: 'none', init: 'required' }),
};
