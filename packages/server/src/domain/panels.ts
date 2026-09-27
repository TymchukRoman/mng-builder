import { DEFAULT_TRANSFORM, EMPTY_SCRIPT } from '@manga/shared';
import type { NewPanel } from '../store/index.js';
import { randomSeed } from './seed.js';

/** A blank panel row for a layout leaf. */
export function newPanelInput(pageId: string, id: string): NewPanel {
  return {
    id, pageId, script: structuredClone(EMPTY_SCRIPT), prompt: { scene: '', negative: '' }, recipe: null,
    seedLock: false, seed: randomSeed(), refCharacterIds: [], activeImageId: null, imageTransform: { ...DEFAULT_TRANSFORM },
  };
}
