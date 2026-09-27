import { SDXL_SIZES } from '@manga/shared';
import { buildAnima } from './anima.js';
import { MODELS } from './models.js';
import type { Recipe } from './types.js';

export const animaTurbo: Recipe = {
  id: 'anima-turbo', label: 'Anima Turbo (v1.1)', family: 'anima',
  maxRefs: 0, requiresRefs: false, supportsPose: true, supportsLineart: true, supportsLoras: true, supportsInit: false,
  defaults: { steps: 8, cfg: 1 }, sizes: SDXL_SIZES,
  build: (p) => buildAnima(MODELS.animaTurbo, p),
};
