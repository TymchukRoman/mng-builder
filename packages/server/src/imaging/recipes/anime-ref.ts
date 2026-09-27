import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const animeRef: Recipe = {
  id: 'anime-ref', label: 'Anime + reference (noobIPA)', family: 'sdxl',
  maxRefs: 2, requiresRefs: true, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: false,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-ref', p, { ipAdapter: 'required', pose: 'none', init: 'none' }),
};
