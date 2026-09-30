// packages/shared/test/letter.test.ts
import { describe, expect, it } from 'vitest';
import { autoLetter, estimateTextBoxMm, PT_TO_MM, wrapText, type ExistingFrame, type LetterFrame } from '../src/letter.js';
import { DEFAULT_FONT_SIZE, FONT_FOR_KIND, NARRATION_PAD, TEXT_INSET } from '../src/fonts.js';
import type { Rect } from '../src/layout/index.js';
import { DEFAULT_PAGE_FORMAT, EMPTY_SCRIPT, type Box, type DialogueLine, type LayoutNode, type PanelScript, type ReadingDirection } from '../src/schemas.js';

const F = DEFAULT_PAGE_FORMAT;
const IX = 2 / F.widthMm;
const IY = 2 / F.heightMm;
const AIKO = 'cr_aiko00001';
const REN = 'cr_ren000001';
const CAST: PanelScript['characters'] = [
  { characterId: AIKO, pose: '', expression: '', position: 'left' },
  { characterId: REN, pose: '', expression: '', position: 'right' },
];
const WIDE: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.5 };
const script = (dialogue: DialogueLine[], characters = CAST): PanelScript => ({ ...EMPTY_SCRIPT, characters, dialogue });
const speech = (text: string, speakerId: string | null = AIKO): DialogueLine => ({ speakerId, kind: 'speech', text });
const one = (rect: Rect, s: PanelScript, direction: ReadingDirection = 'ltr', existingFrames: ExistingFrame[] = []): LetterFrame[] =>
  autoLetter({ layout: { type: 'panel', id: 'pn_1' }, format: F, direction, panels: [{ id: 'pn_1', rect, script: s }], existingFrames });
const inside = (b: Box, r: Rect): boolean =>
  b.x >= r.x - 1e-9 && b.y >= r.y - 1e-9 && b.x + b.w <= r.x + r.w + 1e-9 && b.y + b.h <= r.y + r.h + 1e-9;
const pointInside = (p: { x: number; y: number }, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
const noOverlaps = (frames: LetterFrame[]): boolean =>
  frames.every((a, i) => frames.every((b, j) => j <= i || a.panelId !== b.panelId || !overlap(a.box, b.box)));

describe('text box estimate', () => {
  it('wraps on words and hard-splits words longer than a line', () => {
    expect(wrapText('a verylongwordhere b', 5)).toEqual(['a', 'veryl', 'ongwo', 'rdher', 'e b']);
  });

  it('grows taller with longer text', () => {
    const short = estimateTextBoxMm('Hi!', 9, 40);
    const long = estimateTextBoxMm('This is a much longer line of dialogue that must wrap onto several lines', 9, 40);
    expect(short.lines).toBe(1);
    expect(long.lines).toBeGreaterThan(2);
    expect(long.h).toBeGreaterThan(short.h);
  });
});

describe('autoLetter', () => {
  it('LTR: the first bubble starts at the top-left inside the panel', () => {
    const [f] = one(WIDE, script([speech('Hello there!')]), 'ltr');
    expect(f!.box.x).toBeCloseTo(WIDE.x + IX, 9);
    expect(f!.box.y).toBeCloseTo(WIDE.y + IY, 9);
    expect(f).toMatchObject({ panelId: 'pn_1', kind: 'speech', text: 'Hello there!', speakerId: AIKO, rotation: 0, align: 'center', order: 0 });
  });

  it('RTL: the first bubble starts at the top-right inside the panel', () => {
    const [f] = one(WIDE, script([speech('Hello there!')]), 'rtl');
    expect(f!.box.x + f!.box.w).toBeCloseTo(WIDE.x + WIDE.w - IX, 9);
    expect(f!.box.y).toBeCloseTo(WIDE.y + IY, 9);
  });

  it('continues toward the reading end on the same row', () => {
    const rtl = one(WIDE, script([speech('First.'), speech('Second.', REN)]), 'rtl');
    expect(rtl[1]!.box.y).toBeCloseTo(rtl[0]!.box.y, 9);
    expect(rtl[1]!.box.x + rtl[1]!.box.w).toBeLessThanOrEqual(rtl[0]!.box.x);
    const ltr = one(WIDE, script([speech('First.'), speech('Second.', REN)]), 'ltr');
    expect(ltr[1]!.box.x).toBeGreaterThanOrEqual(ltr[0]!.box.x + ltr[0]!.box.w);
  });

  it('stacks down into new rows when a row is full, without overlaps', () => {
    const lines = [0, 1, 2, 3, 4].map((i) => speech(`Line ${i}: where did you put the umbrella?`, i % 2 ? REN : AIKO));
    const frames = one(WIDE, script(lines), 'rtl');
    expect(frames).toHaveLength(5);
    expect(new Set(frames.map((f) => f.box.y.toFixed(6))).size).toBeGreaterThanOrEqual(3);
    expect(noOverlaps(frames)).toBe(true);
    for (const f of frames) expect(inside(f.box, WIDE)).toBe(true);
  });

  it('crowded panel keeps every box and tail inside the panel', () => {
    const small: Rect = { x: 0.1, y: 0.1, w: 0.25, h: 0.12 };
    const long = 'Я не знаю, куди ми йдемо, але якщо ти залишишся тут, то я теж залишуся, бо сама я туди не піду.';
    const frames = one(small, script([speech(long), speech(long, REN), speech(long), { speakerId: null, kind: 'narration', text: long }]), 'rtl');
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect(inside(f.box, small)).toBe(true);
      if (f.tail) expect(pointInside(f.tail, small)).toBe(true);
    }
  });

  it('points the tail at the speaker position at 40% of the panel height', () => {
    const [a, r] = one(WIDE, script([speech('Left!', AIKO), speech('Right!', REN)]), 'ltr');
    expect(a!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.2, 9);
    expect(r!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.8, 9);
    expect(a!.tail!.y).toBeCloseTo(WIDE.y + WIDE.h * 0.4, 9);
  });

  it('pushes the tail below a bubble that reaches past 40% of the panel', () => {
    const flat: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.06 };
    const [f] = one(flat, script([speech('Hello there!')]), 'ltr');
    expect(f!.tail!.y).toBeGreaterThan(f!.box.y + f!.box.h);
    expect(f!.tail!.y).toBeLessThanOrEqual(flat.y + flat.h);
  });

  it('points to the panel centre when the speaker is not in the panel', () => {
    const [f] = one(WIDE, script([speech('Who said that?', 'cr_offscreen1')]), 'ltr');
    expect(f!.tail!.x).toBeCloseTo(WIDE.x + WIDE.w * 0.5, 9);
  });

  it('puts narration first, in the reading-start top corner, without a tail', () => {
    const frames = one(WIDE, script([speech('Hi.'), { speakerId: null, kind: 'narration', text: 'Meanwhile, in Kyiv.' }]), 'rtl');
    const n = frames[0]!;
    expect(n).toMatchObject({ kind: 'narration', tail: null, align: 'left', order: 0, font: FONT_FOR_KIND.narration });
    expect(n.box.x + n.box.w).toBeCloseTo(WIDE.x + WIDE.w - IX, 9);
    expect(n.box.y).toBeCloseTo(WIDE.y + IY, 9);
    expect(frames[1]).toMatchObject({ kind: 'speech', order: 1 });
  });

  it('centres SFX, rotates it −10° and keeps it clear of the bubbles', () => {
    const frames = one(WIDE, script([{ speakerId: null, kind: 'sfx', text: 'BANG' }, speech('What was that?')]), 'ltr');
    const sfx = frames.find((f) => f.kind === 'sfx')!;
    expect(sfx).toMatchObject({ rotation: -10, tail: null, font: FONT_FOR_KIND.sfx, fontSize: DEFAULT_FONT_SIZE.sfx });
    expect(sfx.box.x + sfx.box.w / 2).toBeCloseTo(WIDE.x + WIDE.w / 2, 9);
    expect(sfx.order).toBe(1);
    expect(noOverlaps(frames)).toBe(true);
  });

  it('uses the font and size of the kind', () => {
    const frames = one(WIDE, script([speech('Hey.'), { speakerId: REN, kind: 'shout', text: 'RUN!' }, { speakerId: AIKO, kind: 'thought', text: 'Hmm.' }]), 'ltr');
    expect(frames.map((f) => [f.kind, f.font, f.fontSize])).toEqual([
      ['speech', FONT_FOR_KIND.speech, DEFAULT_FONT_SIZE.speech],
      ['shout', FONT_FOR_KIND.shout, DEFAULT_FONT_SIZE.shout],
      ['thought', FONT_FOR_KIND.thought, DEFAULT_FONT_SIZE.thought],
    ]);
  });

  it('follows the reading order of panels and continues existing order numbers', () => {
    const layout: LayoutNode = { type: 'split', dir: 'v', ratio: 0.5, a: { type: 'panel', id: 'pn_a' }, b: { type: 'panel', id: 'pn_b' } };
    const frames = autoLetter({
      layout, format: F, direction: 'rtl',
      panels: [
        { id: 'pn_a', rect: { x: 0.05, y: 0.05, w: 0.43, h: 0.9 }, script: script([speech('Left panel.')]) },
        { id: 'pn_b', rect: { x: 0.52, y: 0.05, w: 0.43, h: 0.9 }, script: script([speech('Right panel.')]) },
      ],
      existingFrames: [{ panelId: null, text: 'page note', box: { x: 0, y: 0.97, w: 0.2, h: 0.02 }, order: 4 }],
    });
    expect(frames.map((f) => [f.panelId, f.order])).toEqual([['pn_b', 5], ['pn_a', 6]]);
  });

  it('skips lines already lettered in the panel and avoids their boxes', () => {
    const existing: ExistingFrame = { panelId: 'pn_1', text: 'Hello', box: { x: WIDE.x + IX, y: WIDE.y + IY, w: 0.2, h: 0.03 }, order: 0 };
    const frames = one(WIDE, script([speech('Hello'), speech('Second line')]), 'ltr', [existing]);
    expect(frames.map((f) => f.text)).toEqual(['Second line']);
    expect(overlap(frames[0]!.box, existing.box)).toBe(false);
    expect(frames[0]!.order).toBe(1);
  });

  it('avoids every frame on the page as an obstacle, whatever its panelId', () => {
    const blocker = { x: WIDE.x + IX, y: WIDE.y + IY, w: 0.3, h: 0.05 };
    for (const panelId of [null, 'pn_other']) {
      const frames = one(WIDE, script([speech('Hello there!')]), 'ltr', [{ panelId, text: 'not a line here', box: blocker, order: 0 }]);
      expect(frames).toHaveLength(1);
      expect(overlap(frames[0]!.box, blocker)).toBe(false);
    }
  });
});

describe('text insets shared with the UI bubble geometry', () => {
  it('pins the fractions of the frame box that hold the text', () => {
    expect(TEXT_INSET).toEqual({ speech: 0.7, thought: 0.54, shout: 0.52 });
    expect(NARRATION_PAD).toBe(0.08);
  });

  it('sizes each bubble so the inscribed text box holds the estimated text', () => {
    const text = 'Where did you put the umbrella that I lent you yesterday?';
    const est = estimateTextBoxMm(text, DEFAULT_FONT_SIZE.speech, 42);
    for (const kind of ['speech', 'thought', 'shout'] as const) {
      const t = estimateTextBoxMm(text, DEFAULT_FONT_SIZE[kind], 42);
      const [f] = one(WIDE, script([{ speakerId: AIKO, kind, text }]), 'ltr');
      expect(f!.box.w * F.widthMm * TEXT_INSET[kind]).toBeGreaterThanOrEqual(t.w - 1e-9);
      expect(f!.box.h * F.heightMm * TEXT_INSET[kind]).toBeGreaterThanOrEqual(t.h - 1e-9);
    }
    expect(est.lines).toBeGreaterThan(1);
  });

  it('sizes narration so its padded text box holds the estimated text, for wide and tall boxes', () => {
    for (const text of ['Meanwhile, in Kyiv.', 'A very long narration caption that has to wrap onto many many lines to become a tall box indeed.']) {
      const t = estimateTextBoxMm(text, DEFAULT_FONT_SIZE.narration, 50);
      const [f] = one(WIDE, script([{ speakerId: null, kind: 'narration', text }]), 'ltr');
      const w = f!.box.w * F.widthMm;
      const h = f!.box.h * F.heightMm;
      const pad = NARRATION_PAD * Math.min(w, h);
      expect(w - 2 * pad).toBeGreaterThanOrEqual(t.w - 1e-9);
      expect(h - 2 * pad).toBeGreaterThanOrEqual(t.h - 1e-9);
    }
  });

  it('keeps PT_TO_MM at 25.4 / 72', () => {
    expect(PT_TO_MM).toBeCloseTo(0.35278, 5);
  });
});
