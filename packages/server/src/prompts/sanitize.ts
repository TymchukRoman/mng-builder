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

export function normalizeAppearanceTags(tags: string): string {
  return sanitizeTags(tags.toLowerCase());
}
