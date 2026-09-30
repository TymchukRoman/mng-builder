/** Ukrainian national transliteration (KMU 2010), plus a few Russian letters; lower-case output. */
const LETTERS: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'io', "'": '', '\u2019': '', '\u02BC': '',
};
const WORD_INITIAL: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
const APOSTROPHES = new Set(["'", '\u2019', '\u02BC']);

export function transliterate(text: string): string {
  let out = '';
  let inWord = false;
  let prev = '';
  // NFC first, so a decomposed й (и + U+0306) is the single letter the table knows.
  for (const ch of text.normalize('NFC')) {
    const lower = ch.toLowerCase();
    // KMU 2010: "зг" is "zgh", so that it is not read as the "zh" of ж.
    const mapped = lower === 'г' && prev === 'з' ? 'gh' : (!inWord ? WORD_INITIAL[lower] : undefined) ?? LETTERS[lower];
    out += mapped ?? ch;
    // An apostrophe inside a word does not start a new one (з'їзд).
    if (!APOSTROPHES.has(ch)) inWord = /\p{L}/u.test(ch);
    prev = lower;
  }
  return out;
}

/** ASCII folder/file name: [a-z0-9-], at most 60 chars, never empty. Cannot contain separators or dots, so it is safe as a path segment. */
export function slugify(text: string, fallback: string): string {
  const ascii = transliterate(text).normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || fallback;
}
