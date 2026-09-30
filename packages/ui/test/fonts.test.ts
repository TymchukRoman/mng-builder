import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { create } from 'fontkit';
import { BUNDLED_FONTS } from '@manga/shared';
// @ts-expect-error -- a plain .mjs build script without type declarations
import { excludeCodepoint } from '../scripts/fetch-fonts.mjs';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = join(UI, 'src', 'styles', 'fonts.css');
const FONT_DIR = join(UI, 'public', 'fonts');

interface Face { family: string; file: string; ranges: Array<[number, number]> }

function parseRanges(value: string): Array<[number, number]> {
  return value.split(',').map((part) => {
    const token = part.trim().replace(/^U\+/i, '');
    const [a, b] = token.split('-');
    if (!a) throw new Error(`bad unicode-range token "${part}"`);
    if (a.includes('?')) return [parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'F'), 16)];
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
}

function parseFaces(css: string): Face[] {
  const faces: Face[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1] ?? '';
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const url = /url\('\/fonts\/([^']+)'\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    if (!family || !url || !range) throw new Error(`incomplete @font-face: ${body}`);
    faces.push({ family, file: url, ranges: parseRanges(range) });
  }
  return faces;
}

const cache = new Map<string, { hasGlyphForCodePoint(cp: number): boolean }>();
function open(file: string) {
  const hit = cache.get(file);
  if (hit) return hit;
  const f = create(readFileSync(join(FONT_DIR, file)));
  if (!('hasGlyphForCodePoint' in f)) throw new Error(`${file} is a font collection`);
  cache.set(file, f);
  return f;
}

// U+2019 (’) is the apostrophe used in both English and Ukrainian text; it is a hard requirement like
// the letters. U+02BC (ʼ, the modifier-letter apostrophe) is checked separately below: it must never be
// falsely claimed by a unicode-range, but is not required to be present in every family.
const REQUIRED = [...'іїєґІЇЄҐ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz', '’'];
const faces = existsSync(CSS_PATH) ? parseFaces(readFileSync(CSS_PATH, 'utf8')) : [];

describe('bundled fonts', () => {
  it('declares every bundled family', () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const family of BUNDLED_FONTS) expect(faces.some((f) => f.family === family), family).toBe(true);
  });

  it('declares exactly the files on disk', () => {
    const onDisk = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();
    const declared = [...new Set(faces.map((f) => f.file))].sort();
    expect(declared).toEqual(onDisk);
  });

  it('ships an OFL licence per family', () => {
    const licences = readdirSync(join(FONT_DIR, 'licenses'));
    expect(licences.filter((f) => f.endsWith('-OFL.txt'))).toHaveLength(BUNDLED_FONTS.length);
  });

  for (const family of BUNDLED_FONTS) {
    it(`${family} has glyphs for Latin and Ukrainian letters`, () => {
      for (const ch of REQUIRED) {
        const cp = ch.codePointAt(0) ?? 0;
        const covering = faces.filter((f) => f.family === family && f.ranges.some(([lo, hi]) => cp >= lo && cp <= hi));
        expect(covering.length, `${family}: no @font-face covers U+${cp.toString(16).toUpperCase()} (${ch})`).toBeGreaterThan(0);
        for (const face of covering) {
          expect(open(face.file).hasGlyphForCodePoint(cp), `${face.file} lacks ${ch}`).toBe(true);
        }
      }
    });
  }

  it('never claims U+02BC (modifier-letter apostrophe) without a glyph', () => {
    const cp = 0x02bc;
    for (const face of faces) {
      if (!face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
      expect(open(face.file).hasGlyphForCodePoint(cp), `${face.file} (${face.family}) claims U+02BC without a glyph`).toBe(true);
    }
  });
});

describe('excludeCodepoint', () => {
  it('splits an interior codepoint out of a range', () => {
    expect(excludeCodepoint('U+0460-052F', 0x0491)).toBe('U+0460-0490, U+0492-052F');
  });

  it('trims the start edge of a range', () => {
    expect(excludeCodepoint('U+0460-052F', 0x0460)).toBe('U+0461-052F');
  });

  it('trims the end edge of a range', () => {
    expect(excludeCodepoint('U+0460-052F', 0x052f)).toBe('U+0460-052E');
  });

  it('empties a single-codepoint range', () => {
    expect(excludeCodepoint('U+02BC', 0x02bc)).toBe('');
  });

  it('leaves an unrelated range untouched and only trims the matching one', () => {
    expect(excludeCodepoint('U+0301, U+0490-0491, U+2116', 0x0490)).toBe('U+0301, U+0491, U+2116');
  });
});
