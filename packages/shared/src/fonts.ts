import type { FrameKind } from './schemas.js';

export const FONT_FOR_KIND: Record<FrameKind, string> = {
  speech: 'Shantell Sans', thought: 'Shantell Sans', shout: 'Dela Gothic One',
  sfx: 'Dela Gothic One', narration: 'Sofia Sans Condensed', title: 'Unbounded',
};
export const DEFAULT_FONT_SIZE: Record<FrameKind, number> = { speech: 9, thought: 9, shout: 11, sfx: 20, narration: 8, title: 28 }; // pt
export const MIN_READABLE_PT = 7;
export const BUNDLED_FONTS: readonly string[] = ['Shantell Sans', 'Comic Relief', 'Dela Gothic One', 'Sofia Sans Condensed', 'Unbounded'];
