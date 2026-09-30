import type { FrameKind } from './schemas.js';

export const FONT_FOR_KIND: Record<FrameKind, string> = {
  speech: 'Shantell Sans', thought: 'Shantell Sans', shout: 'Dela Gothic One',
  sfx: 'Dela Gothic One', narration: 'Sofia Sans Condensed', title: 'Unbounded',
};
export const DEFAULT_FONT_SIZE: Record<FrameKind, number> = { speech: 9, thought: 9, shout: 11, sfx: 20, narration: 8, title: 28 }; // pt
export const MIN_READABLE_PT = 7;
export const BUNDLED_FONTS: readonly string[] = ['Shantell Sans', 'Comic Relief', 'Dela Gothic One', 'Sofia Sans Condensed', 'Unbounded'];

/**
 * Fraction of the frame box that holds the text, per bubble shape (centred). Chosen so the text box's
 * corners stay inside the shape: cloud valleys sit at ~0.77 (0.77/sqrt2 = 0.545), burst inner ring at 0.74 (0.523).
 * The UI's `textBox` and the auto-letter sizing both read these, so they cannot drift apart.
 */
export const TEXT_INSET = { speech: 0.7, thought: 0.54, shout: 0.52 } as const;
/** Narration padding on each side, as a fraction of the box's shorter side. */
export const NARRATION_PAD = 0.08;
