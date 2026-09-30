import { hasNoHumansTag } from './prompt.js';

/**
 * The subject gender a character's appearance tags describe. Style LoRAs and the base models drift towards a girl
 * unless a prompt says clearly otherwise (Roman: a "1other, fat man" rendered as a young woman), so the prompt
 * builders use this to write the right count tag, "male focus", the anti-female negative and the LoRA strength.
 */
export type Gender = 'male' | 'female' | 'other';

/** Explicit Danbooru count tags: `1boy`, `2boys`, `6+boys`, `multiple boys`, `male focus` (and the girls' ones). */
const MALE_COUNT = /(?<![a-z0-9+])(?:\d+\+?\s?boys?|multiple boys|male focus)(?![a-z0-9])/;
const FEMALE_COUNT = /(?<![a-z0-9+])(?:\d+\+?\s?girls?|multiple girls|female focus)(?![a-z0-9])/;

/** Words that name a man or a woman (English: appearance tags are English Danbooru tags). Whole words only. */
const MALE_WORDS = [
  'male', 'males', 'man', 'men', 'boy', 'boys', 'guy', 'guys', 'gentleman', 'gentlemen', 'husband', 'father', 'dad', 'son', 'brother',
  'uncle', 'nephew', 'grandpa', 'grandfather', 'grandson', 'king', 'prince', 'emperor', 'duke', 'baron', 'lord', 'sir', 'monk',
  'priest', 'businessman', 'salaryman', 'swordsman', 'policeman', 'fireman', 'fisherman', 'nobleman', 'madman', 'caveman',
  'boyfriend', 'groom', 'bridegroom', 'widower', 'wizard', 'sorcerer', 'lad', 'beard', 'bearded', 'mustache', 'moustache',
  'goatee', 'facial hair', 'stubble',
];
const FEMALE_WORDS = [
  'female', 'females', 'woman', 'women', 'girl', 'girls', 'gal', 'lady', 'ladies', 'wife', 'mother', 'mom', 'daughter', 'sister',
  'aunt', 'niece', 'grandma', 'grandmother', 'granddaughter', 'queen', 'princess', 'empress', 'duchess', 'baroness', 'madam',
  'nun', 'priestess', 'businesswoman', 'policewoman', 'noblewoman', 'girlfriend', 'bride', 'widow', 'witch', 'sorceress',
  'goddess', 'heroine', 'actress', 'waitress', 'schoolgirl', 'housewife', 'maiden', 'shrine maiden', 'miko', 'kunoichi', 'lass',
  'tomboy', 'breasts',
];
const wordsPattern = (words: readonly string[]): RegExp => new RegExp(String.raw`(?<![a-z0-9])(?:${words.join('|')})(?![a-z0-9])`, 'g');
const MALE_WORD = wordsPattern(MALE_WORDS);
const FEMALE_WORD = wordsPattern(FEMALE_WORDS);

/** Lowercase, `_` as a space, one space between words, so "Old_Man" and "old  man" read as "old man". */
const plain = (tags: string): string => tags.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');

/**
 * Male or female when the tags say so: an explicit `1boy`/`1girl` (or another count tag of one gender) decides;
 * otherwise the words must name only one gender ("fat man", "old woman", "king"). Anything else, including a
 * non-human (`no humans`), is 'other'.
 */
export function genderOf(appearanceTags: string): Gender {
  if (hasNoHumansTag(appearanceTags)) return 'other';
  const text = plain(appearanceTags);
  const maleCount = MALE_COUNT.test(text);
  const femaleCount = FEMALE_COUNT.test(text);
  if (maleCount !== femaleCount) return maleCount ? 'male' : 'female';
  const male = (text.match(MALE_WORD) ?? []).length;
  const female = (text.match(FEMALE_WORD) ?? []).length;
  if (male > 0 && female === 0) return 'male';
  if (female > 0 && male === 0) return 'female';
  return 'other';
}

const isOneOther = (tag: string): boolean => /^1\s?others?$/.test(plain(tag).trim());
const hasCountTag = (tags: string): boolean =>
  MALE_COUNT.test(plain(tags)) || FEMALE_COUNT.test(plain(tags)) || tags.split(',').some(isOneOther);

/**
 * The tags with the count tag their words call for: a gendered `1other` becomes `1boy`/`1girl` in place, and a
 * gendered list without any count tag gets one in front. Used where a character's tags enter a prompt (and on the
 * outline's new characters); the character's stored tags are never rewritten by it. Other tags are returned as they are.
 */
export function withCountTag(appearanceTags: string): string {
  const gender = genderOf(appearanceTags);
  if (gender === 'other') return appearanceTags;
  const count = gender === 'male' ? '1boy' : '1girl';
  const parts = appearanceTags.split(',');
  if (parts.some(isOneOther)) {
    return parts.map((p) => (isOneOther(p) ? p.replace(/\S.*\S|\S/, count) : p)).join(',');
  }
  return hasCountTag(appearanceTags) ? appearanceTags : `${count}, ${appearanceTags}`;
}

/** How many of a panel's humans are boys (men), girls (women) and others; non-humans (`no humans`) are not counted. */
export interface CastCount { girl: number; boy: number; other: number }

const KEY: Record<Gender, keyof CastCount> = { male: 'boy', female: 'girl', other: 'other' };

/**
 * Counts the humans of a cast by genderOf. A `no humans` character (a pet, a creature) is not a person: the live
 * smoke's kitten turned a one-girl panel into "Exactly two people", and the retry drew a second girl.
 */
export function castCount(cast: ReadonlyArray<{ appearanceTags: string }>): CastCount {
  const count: CastCount = { girl: 0, boy: 0, other: 0 };
  for (const c of cast) {
    if (hasNoHumansTag(c.appearanceTags)) continue;
    count[KEY[genderOf(c.appearanceTags)]] += 1;
  }
  return count;
}

export const humanCount = (c: CastCount): number => c.girl + c.boy + c.other;
/** Every human is male (and there is one): the prompt adds `male focus`. */
export const allMale = (c: CastCount): boolean => c.boy > 0 && c.girl === 0 && c.other === 0;

const MAX_COUNTED = 5;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/**
 * The Danbooru people-count tags for the tags style: `1boy, solo, male focus`, `1girl, solo`, `2boys, male focus`,
 * `1boy, 1girl`, `multiple boys`, or `no humans` for a cast without people.
 */
export function countTag(count: CastCount): string {
  const n = humanCount(count);
  if (n === 0) return 'no humans';
  const kinds = (['boy', 'girl', 'other'] as const)
    .filter((kind) => count[kind] > 0)
    .map((kind) => {
      const k = count[kind];
      return k === 1 ? `1${kind}` : k <= MAX_COUNTED ? `${k}${kind}s` : `multiple ${kind}s`;
    });
  return [...kinds, ...(n === 1 ? ['solo'] : []), ...(allMale(count) ? ['male focus'] : [])].join(', ');
}

const NOUNS: Record<keyof CastCount, [string, string]> = { boy: ['man', 'men'], girl: ['woman', 'women'], other: ['person', 'people'] };

/** The people count as a sentence for the natural style (qwen/klein scenes are plain English sentences). */
export function countSentence(count: CastCount): string {
  const n = humanCount(count);
  if (n === 0) return 'No people.';
  const present = (['boy', 'girl', 'other'] as const).filter((kind) => count[kind] > 0);
  if (present.length === 1) {
    const kind = present[0]!;
    return `Exactly ${numberWord(n)} ${NOUNS[kind][n === 1 ? 0 : 1]}.`;
  }
  const parts = present.map((kind) => {
    const k = count[kind];
    const noun = kind === 'other' ? (k === 1 ? 'other person' : 'other people') : NOUNS[kind][k === 1 ? 0 : 1];
    return `${numberWord(k)} ${noun}`;
  });
  return `Exactly ${numberWord(n)} people: ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}.`;
}

/** Steers a male subject away from the feminised look a style LoRA pulls towards (GPU test C/F/G). */
export const ANTI_FEMALE_NEGATIVE = '1girl, female, woman, breasts, feminine, makeup';

/** ANTI_FEMALE_NEGATIVE when the subject has a male and no female human, else ''. */
export function antiFemaleNegative(count: CastCount): string {
  return count.boy > 0 && count.girl === 0 ? ANTI_FEMALE_NEGATIVE : '';
}
