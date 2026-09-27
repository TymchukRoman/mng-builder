import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const anime: Recipe = {
  id: 'anime', label: 'Anime (WAI Illustrious)', family: 'sdxl',
  maxRefs: 0, requiresRefs: false, supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: true,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime', p, { ipAdapter: 'none', pose: 'none', init: 'optional' }),
};
