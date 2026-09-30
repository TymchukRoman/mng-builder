const FORBIDDEN_WORDS =
  'manga|comics?|text|speech ?bubbles?|word ?balloons?|captions?|lettering|sound effects?|onomatopoeia|watermarks?|signatures?';
const FORBIDDEN = new RegExp(`\\b(?:${FORBIDDEN_WORDS})\\b`, 'i');

/** Comma-separated tags: drops any tag containing a forbidden word, trims, de-duplicates case-insensitively. */
export function sanitizeTags(tags: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags.split(',')) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag || FORBIDDEN.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

/** Plain sentences: removes forbidden words (with a leading "no"/"without") and tidies the punctuation left behind. */
export function sanitizeSentences(text: string): string {
  const pattern = new RegExp(`\\b(?:no |without )?(?:${FORBIDDEN_WORDS})\\b`, 'gi');
  return text
    .replace(pattern, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[,;]+([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
    .trim();
}

/** Chromatic colours only: black, white, grey/gray and silver are values a black-and-white page can show. */
const COLOUR_WORDS = [
  'red', 'reddish', 'orange', 'orangey', 'yellow', 'yellowish', 'green', 'greenish', 'blue', 'bluish', 'blueish', 'purple', 'purplish',
  'violet', 'pink', 'pinkish', 'brown', 'brownish', 'cyan', 'magenta', 'teal', 'gold', 'golden', 'crimson', 'scarlet', 'amber',
  'turquoise', 'indigo', 'lavender', 'maroon', 'emerald', 'azure', 'beige', 'blond', 'blonde',
].join('|');
/** An optional article before it (re-chosen for the next word), "light-blue", "blue-green", "red-haired", "gold-tinted". */
const COLOUR_PHRASE = new RegExp(
  `(\\b(?:an?)\\s+)?-?\\b(?:${COLOUR_WORDS})(?:-(?:${COLOUR_WORDS}))*(?:-(?:colou?red|tinted|toned|hued|haired|eyed))?\\b(?=[\\s,]*(\\w)?)`,
  'gi',
);

/**
 * F26 / Task 4 review M3: removes chromatic colour words from a black-and-white scene ("orange sky" rendered as colour
 * in a B&W book, live M2). Works on tags and sentences alike; run sanitizeTags/sanitizeSentences after it to tidy the
 * gaps. Words that only contain a colour ("greenhouse", "shredded") stay.
 */
export function stripColourWords(text: string): string {
  return text.replace(COLOUR_PHRASE, (_match, article: string | undefined, next: string | undefined) => {
    if (article === undefined) return '';
    const an = next !== undefined && /^[aeiou]/i.test(next);
    const first = article[0] === 'A' ? 'A' : 'a';
    return `${first}${an ? 'n' : ''} `;
  });
}

export function normalizeAppearanceTags(tags: string): string {
  return sanitizeTags(tags.toLowerCase());
}
