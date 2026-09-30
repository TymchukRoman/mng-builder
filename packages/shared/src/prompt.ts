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

/**
 * The Danbooru "no humans" count tag, however it is written: `no humans`, `no_humans`, `No Humans`, `no human`, extra
 * spaces (M4 final S4 and the Task 22 review minor 1: a variant must not count a pet as a person).
 */
export function isNoHumansTag(tag: string): boolean {
  return /^no humans?$/.test(tag.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
}

/** Whether a comma-separated tag list carries the "no humans" tag. */
export function hasNoHumansTag(tags: string): boolean {
  return tags.split(',').some(isNoHumansTag);
}

/**
 * Drops every "no humans" tag from a comma-separated list (M4 final S4: a panel with a person in its cast must not ask
 * for "no humans" because a pet in it is tagged so). A list without one is returned unchanged, character tags verbatim.
 */
export function dropNoHumansTags(text: string): string {
  const parts = text.split(',');
  if (!parts.some(isNoHumansTag)) return text;
  return parts.filter((p) => !isNoHumansTag(p)).map((p) => p.trim()).filter((p) => p.length > 0).join(', ');
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
