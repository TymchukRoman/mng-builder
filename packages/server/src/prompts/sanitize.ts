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
const COLOUR = `(?:${COLOUR_WORDS})`;
/** Values a black-and-white page shows: "red and white flag" keeps "white flag". */
const KEPT_COLOUR = '(?:black|white|gr[ae]y|silver)';
/** Between the colours of one list: "red, orange or golden", "red and blue", "blue-green", "golden orange". */
const COLOUR_SEP = String.raw`(?:\s*,\s*|\s+(?:and|or)\s+|-(?:and|or)-|-|\s+)`;
/**
 * One colour phrase with an optional article before it (re-chosen for the next word): a list of colours, a leading
 * hyphen ("light-blue"), a compound suffix ("red-haired", "gold-tinted"), a link to a kept value ("red-and-white",
 * "red and white") or a bare trailing hyphen ("blue-striped").
 */
const COLOUR_PHRASE = new RegExp(
  String.raw`(\b(?:an?)\s+)?-?\b${COLOUR}(?:${COLOUR_SEP}${COLOUR})*\b(?:-(?:colou?red|tinted|toned|hued|haired|eyed)\b)?` +
    String.raw`(?:(?:-(?:and|or)-|\s+(?:and|or)\s+)(?=${KEPT_COLOUR}\b)|-(?=[a-z]))?`,
  'gi',
);
const NEXT_WORD = /^[\s,]*([^\s,.;:!?]+)/;
/** Masked names become private-use placeholders, which no colour or word pattern matches. */
const MASK = /(\d+)/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * F26 / Task 4 review M3: removes chromatic colour words from a black-and-white scene ("orange sky" rendered as colour
 * in a B&W book, live M2). Works on tags and sentences alike; run sanitizeTags/sanitizeSentences after it to tidy the
 * gaps. Words that only contain a colour ("greenhouse", "shredded") stay, and so do the `keep` names (the manga's
 * characters, e.g. Amber or Violet), matched as whole words case-insensitively (review M1).
 * An article before a removed colour is re-chosen for the next word ("an orange sky" → "a sky"), kept as it is before
 * "and"/"or"/"with", and dropped when no word follows (review M2).
 */
export function stripColourWords(text: string, keep: readonly string[] = []): string {
  const names = keep.map((n) => n.trim()).filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  const masked: string[] = [];
  let work = text;
  if (names.length > 0) {
    const name = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${names.map(escapeRegExp).join('|')})(?![\p{L}\p{N}_])`, 'giu');
    work = work.replace(name, (m) => `${masked.push(m) - 1}`);
  }
  const unmask = (s: string): string => s.replace(MASK, (_m, i: string) => masked[Number(i)] ?? '');
  work = work.replace(COLOUR_PHRASE, (match: string, article: string | undefined, offset: number, whole: string) => {
    if (article === undefined) return '';
    const next = NEXT_WORD.exec(whole.slice(offset + match.length))?.[1];
    if (next === undefined) return ''; // nothing follows: drop the dangling article
    const word = unmask(next);
    if (/^(?:and|or|with)$/i.test(word)) return article;
    const first = article[0] === 'A' ? 'A' : 'a';
    return `${first}${/^[aeiou]/i.test(word) ? 'n' : ''} `;
  });
  return unmask(work);
}

export function normalizeAppearanceTags(tags: string): string {
  return sanitizeTags(tags.toLowerCase());
}
