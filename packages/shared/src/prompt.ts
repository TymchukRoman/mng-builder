import type { ColorMode, StyleGuide } from './schemas.js';

export const BW_TOKENS = 'monochrome, greyscale, screentone, lineart';
export const BASE_NEGATIVE = 'text, speech bubble, sound effects, signature, watermark, logo';

/** "manga", "comic", "comics" as whole words (an attached hyphen goes too: "manga-style" → "style"). */
const BANNED_WORDS = /-?\b(?:manga|comics?)\b-?/gi;

/** Removes the banned words from AI-written scene text and tidies the comma list it leaves behind. */
function stripBannedWords(text: string): string {
  return text
    .replace(BANNED_WORDS, ' ')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Joins non-empty parts with ', '; removes the whole words "manga" and "comic(s)" (case-insensitive) from the
 * positive prompt; tags/style are inserted verbatim.
 *
 * The stripping applies to the scene only: style prompt and character tags are the user's own canonical text
 * and must reach the model unchanged, or characters drift.
 */
export function assemblePrompt(input: {
  styleGuide: StyleGuide; colorMode: ColorMode; characterTags: string[]; scene: string; extraNegative?: string;
}): { prompt: string; negative: string } {
  return {
    prompt: joinParts([
      input.styleGuide.stylePrompt,
      input.colorMode === 'bw' ? BW_TOKENS : '',
      ...input.characterTags,
      stripBannedWords(input.scene),
    ]),
    negative: joinParts([input.styleGuide.negativePrompt, BASE_NEGATIVE, input.extraNegative]),
  };
}
