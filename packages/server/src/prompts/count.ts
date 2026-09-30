import { castCount, countSentence, countTag, grownMen, humanCount, isGrownMan, type CastCount } from '@manga/shared';
import type { PromptStyle } from '../imaging/route.js';
import { normalizeTag } from './camera.js';

/**
 * People-count and gender-focus tags an LLM may write into a scene (`1girl` … `6+girls`, `multiple boys`, `1other`,
 * `solo`, `male focus`, …). The panel's cast decides the count, not the model (live: a panel of the Rogue Ninja, a
 * `1boy`, got `2girls` from the prompts step), so the build strips them and puts the cast's count first.
 */
const COUNT_TAG = /^(?:\d+\+?\s?(?:girls?|boys?|others?)|multiple (?:girls|boys|others)|solo|solo focus|(?:male|female) focus)$/;

/** Drops every people-count tag (any case, `_` or weight syntax) from a comma-separated tag list. */
export function stripCountTags(tags: string): string {
  return tags.split(',').map((t) => t.trim()).filter((t) => t && !COUNT_TAG.test(normalizeTag(t))).join(', ');
}

const NUMBER = '(?:no|one|two|three|four|five|six|seven|eight|nine|ten|\d+|a single|a|an)';
const PEOPLE = '(?:people|persons?|men|women|man|woman|boys?|girls?|characters?|figures?)';
/** A sentence that only states the people count: "Exactly two people: two girls.", "One man.", "Solo.", "No people." */
const COUNT_SENTENCE = new RegExp(String.raw`^(?:(?:exactly|only|just)\s+)?${NUMBER}\s+${PEOPLE}(?:\s*:[^.!?]*)?[.!?]?$|^solo[.!?]?$`, 'i');

/** Natural style: drops the sentences that only state a people count; every other sentence stays as written. */
export function stripCountSentences(text: string): string {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !COUNT_SENTENCE.test(s)).join(' ');
}

export interface CastPrompt {
  /** The count tags (tags style) and each character's tags without its own count tag, in cast order. */
  characterTags: string[];
  /** The scene without the model's people count; for the natural style it opens with the count sentence. */
  scene: string;
  count: CastCount;
}

/**
 * The panel's subject: one people count computed from its cast (the panelCharacters the router counts, by genderOf,
 * the same count a character-count retry writes) in place of every count the LLM or a character's tags carry, so
 * the prompt has exactly one. The tags style gets the count tags ahead of the character tags (`1boy, solo, male
 * focus`); the natural style gets the count sentence ahead of the scene ("Exactly one man.", "Exactly one grown man."
 * when every man is grown). A grown man (isGrownMan) gets `mature male` at the front of his own tags. A cast without a
 * human (a pet only, or no characters: a crowd, a street) leaves everything as written, since extras are not in it.
 */
export function castPrompt(style: PromptStyle, cast: ReadonlyArray<{ appearanceTags: string }>, scene: string): CastPrompt {
  const count = castCount(cast);
  const tags = cast.map((c) => c.appearanceTags);
  if (humanCount(count) === 0) return { characterTags: tags.filter((t) => t.trim() !== ''), scene, count };
  // A grown man's own tags open with `mature male` (only his: a boy beside him gets none); the count set stays first.
  const characterTags = tags.map((t) => (isGrownMan(t) ? ['mature male', stripCountTags(t)].filter((p) => p !== '').join(', ') : stripCountTags(t)))
    .filter((t) => t !== '');
  if (style === 'tags') return { characterTags: [countTag(count), ...characterTags], scene: stripCountTags(scene), count };
  return { characterTags, scene: [countSentence(count, { grownMen: grownMen(cast) }), stripCountSentences(scene)].filter((s) => s !== '').join(' '), count };
}
