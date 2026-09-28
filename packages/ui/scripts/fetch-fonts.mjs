// Downloads the five OFL lettering fonts (latin + cyrillic subsets, woff2) and writes src/styles/fonts.css.
// Run once; commit the outputs. Re-running overwrites them.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create } from 'fontkit';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(PKG, 'public', 'fonts');
const LICENSE_DIR = join(FONT_DIR, 'licenses');
const CSS_OUT = join(PKG, 'src', 'styles', 'fonts.css');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KEEP = ['cyrillic-ext', 'cyrillic', 'latin'];
const REQUIRED = ['cyrillic', 'latin'];

// Same set the glyph-coverage test (packages/ui/test/fonts.test.ts) checks: Latin, the four
// Ukrainian-specific Cyrillic letters, and U+2019 (’, the apostrophe used in both English and
// Ukrainian text). Google's per-subset unicode-range blocks are fixed strings shared across many
// families and sometimes overlap (e.g. "cyrillic-ext" nominally covers U+0460-052F, which contains
// U+0490/0491, even on families whose cyrillic-ext file has no glyph there while the main "cyrillic"
// file does). A browser resolves overlapping unicode-range faces in source order, so an overlap like
// that can make it pick the face lacking the glyph. We verify actual glyph coverage per codepoint and
// narrow away any face's claimed range that its file doesn't back up, as long as another face of the
// same family truly covers it. These are hard requirements: if NO face of a family truly has the
// glyph, the script stops rather than shipping a family that silently can't render required text.
const HARD_CANARY = [...'іїєґІЇЄҐ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', '’'].map((ch) =>
  ch.codePointAt(0),
);

// Codepoints that must never be falsely claimed by a unicode-range even if no bundled face actually
// renders them. U+02BC (ʼ, the modifier-letter apostrophe) sits inside Google's shared Latin range
// block for every family here, but at least one family's downloaded file has no glyph for it. Unlike
// HARD_CANARY, a missing glyph here is not fatal — the CSS font stack falls back to the next font — but
// the range must be narrowed so a browser never picks a glyph-less face for it.
const SOFT_NEVER_CLAIM = [0x02bc];

function parseRanges(value) {
  return value.split(',').map((part) => {
    const token = part.trim().replace(/^U\+/i, '');
    const [a, b] = token.split('-');
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
}

function formatRanges(ranges) {
  return ranges
    .map(([lo, hi]) => {
      const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
      return lo === hi ? `U+${hex(lo)}` : `U+${hex(lo)}-${hex(hi)}`;
    })
    .join(', ');
}

/**
 * Removes a single codepoint from a unicode-range string, splitting any bounded range that spans it.
 * Returns '' when nothing is left (e.g. the range was exactly that one codepoint).
 */
export function excludeCodepoint(rangeStr, cp) {
  const ranges = parseRanges(rangeStr);
  const kept = [];
  for (const [lo, hi] of ranges) {
    if (cp < lo || cp > hi) { kept.push([lo, hi]); continue; }
    if (lo < cp) kept.push([lo, cp - 1]);
    if (hi > cp) kept.push([cp + 1, hi]);
  }
  return formatRanges(kept);
}

/**
 * Checks one codepoint against every face of a family that declares it. `hard: true` (HARD_CANARY)
 * throws if no face actually has the glyph — a real gap; do not substitute or fake a font. `hard: false`
 * (SOFT_NEVER_CLAIM) instead narrows the codepoint away from every covering face and records the family
 * in `softGaps`, so the browser falls back to the next font in the CSS stack instead of showing tofu.
 * Either way, any face that lacks the glyph gets it excluded from its declared range so a browser never
 * mis-resolves an overlapping unicode-range to a face that can't render the character. If narrowing ever
 * empties a face's range entirely, we stop rather than ship a useless @font-face whose file nothing on
 * disk would then correspond to.
 */
function reconcileCodepoint(familyName, faces, fonts, cp, { hard, softGaps }) {
  const covering = faces
    .map((face, i) => ({ face, font: fonts[i] }))
    .filter(({ face }) => parseRanges(face.range).some(([lo, hi]) => cp >= lo && cp <= hi));
  if (covering.length === 0) return; // not claimed by any face; unrelated to this family's subsets
  const has = covering.filter(({ font }) => font.hasGlyphForCodePoint(cp));
  const lacks = covering.filter(({ font }) => !font.hasGlyphForCodePoint(cp));
  if (has.length === 0) {
    if (hard) {
      throw new Error(
        `${familyName}: no downloaded face actually has a glyph for U+${cp.toString(16).toUpperCase()} ` +
        `despite unicode-range claiming coverage — stop and report; do not substitute a font.`,
      );
    }
    softGaps.add(familyName);
  }
  for (const { face } of lacks) {
    const next = excludeCodepoint(face.range, cp);
    if (next === '') {
      throw new Error(
        `${familyName}: excluding U+${cp.toString(16).toUpperCase()} from the ${face.subset} face ` +
        `(weight ${face.weight}) would leave its unicode-range empty — stop and report.`,
      );
    }
    face.range = next;
  }
}

/** Reconciles both the hard-required and never-falsely-claimed codepoints for one family's faces. */
function reconcileRanges(familyName, faces, softGaps) {
  const fonts = faces.map((face) => create(face.bytes));
  for (const cp of HARD_CANARY) reconcileCodepoint(familyName, faces, fonts, cp, { hard: true, softGaps });
  for (const cp of SOFT_NEVER_CLAIM) reconcileCodepoint(familyName, faces, fonts, cp, { hard: false, softGaps });
}

const FAMILIES = [
  { family: 'Shantell Sans', slug: 'shantell-sans', query: 'Shantell+Sans:wght@400..700', ofl: 'shantellsans' },
  { family: 'Comic Relief', slug: 'comic-relief', query: 'Comic+Relief:wght@400;700', ofl: 'comicrelief' },
  { family: 'Dela Gothic One', slug: 'dela-gothic-one', query: 'Dela+Gothic+One', ofl: 'delagothicone' },
  { family: 'Sofia Sans Condensed', slug: 'sofia-sans-condensed', query: 'Sofia+Sans+Condensed:wght@400..700', ofl: 'sofiasanscondensed' },
  { family: 'Unbounded', slug: 'unbounded', query: 'Unbounded:wght@400..700', ofl: 'unbounded' },
];

async function fetchOk(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

/** Google's CSS labels each @font-face with a comment naming its subset. */
function parseFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const pick = (key) => new RegExp(`${key}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
    const src = /url\((https:[^)]+\.woff2)\)/.exec(body)?.[1];
    if (!src) continue;
    faces.push({ subset: m[1], weight: pick('font-weight') ?? '400', style: pick('font-style') ?? 'normal', range: pick('unicode-range') ?? '', src });
  }
  return faces;
}

async function main() {
  await rm(FONT_DIR, { recursive: true, force: true });
  await mkdir(LICENSE_DIR, { recursive: true });
  const rules = [];
  const softGaps = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  for (const f of FAMILIES) {
    const css = await (await fetchOk(`https://fonts.googleapis.com/css2?family=${f.query}&display=block`)).text();
    const faces = parseFaces(css).filter((face) => KEEP.includes(face.subset));
    for (const need of REQUIRED) {
      if (!faces.some((face) => face.subset === need)) throw new Error(`${f.family} has no "${need}" subset on Google Fonts — stop and report; do not substitute a font.`);
    }
    for (const face of faces) {
      face.bytes = new Uint8Array(await (await fetchOk(face.src)).arrayBuffer());
    }
    reconcileRanges(f.family, faces, softGaps);
    for (const face of faces) {
      const file = `${f.slug}-${face.weight.replace(/\s+/g, '-')}-${face.subset}.woff2`;
      await writeFile(join(FONT_DIR, file), face.bytes);
      rules.push(
        `@font-face {\n  font-family: '${f.family}';\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: block;\n` +
        `  src: url('/fonts/${file}') format('woff2');\n  unicode-range: ${face.range};\n}`,
      );
      console.log(`${file}  ${face.bytes.byteLength} bytes`);
      totalBytes += face.bytes.byteLength;
      fileCount += 1;
    }
    const licence = await (await fetchOk(`https://raw.githubusercontent.com/google/fonts/main/ofl/${f.ofl}/OFL.txt`)).text();
    await writeFile(join(LICENSE_DIR, `${f.slug}-OFL.txt`), licence);
    console.log(`licenses/${f.slug}-OFL.txt`);
  }
  const header = '/* Generated by packages/ui/scripts/fetch-fonts.mjs — do not edit by hand. SIL Open Font License 1.1, see /fonts/licenses. */\n';
  await writeFile(CSS_OUT, header + rules.join('\n\n') + '\n');
  console.log(`wrote ${rules.length} @font-face rules to src/styles/fonts.css`);
  console.log(`total: ${fileCount} font files, ${totalBytes} bytes (${(totalBytes / 1024).toFixed(1)} KiB)`);
  console.log(
    softGaps.size > 0
      ? `no bundled face has U+02BC (modifier-letter apostrophe): ${[...softGaps].join(', ')} — narrowed away; CSS font stack will fall back for it`
      : 'U+02BC (modifier-letter apostrophe) is covered by at least one face in every family',
  );
}

// Only run when invoked directly (e.g. `node scripts/fetch-fonts.mjs`), not when imported by the test
// suite for its unit tests of the pure helpers above — importing must never hit the network or touch disk.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
