import { SDXL_SIZES } from '@manga/shared';
import { buildSdxl, SDXL_DEFAULTS } from './sdxl.js';
import type { Recipe } from './types.js';

export const animePose: Recipe = {
  id: 'anime-pose', label: 'Anime + pose (OpenPose)', family: 'sdxl',
  maxRefs: 2, requiresRefs: false, supportsPose: true, supportsLineart: false, supportsLoras: true, supportsInit: false,
  defaults: { ...SDXL_DEFAULTS }, sizes: SDXL_SIZES,
  build: (p) => buildSdxl('anime-pose', p, { ipAdapter: 'optional', pose: 'required', init: 'none' }),
};
