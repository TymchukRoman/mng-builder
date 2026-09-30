// packages/shared/src/letter.ts
import { DEFAULT_FONT_SIZE, FONT_FOR_KIND, NARRATION_PAD, TEXT_INSET } from './fonts.js';
import { readingOrder, type Rect } from './layout/index.js';
import type { Box, DialogueLine, FrameKind, LayoutNode, PageFormat, PanelScript, ReadingDirection } from './schemas.js';

export const PT_TO_MM = 25.4 / 72;
/** Spec §9.3: the tail tip points at the speaker, 40 % down the panel. */
export const TAIL_Y = 0.4;
const CHAR_W_EM = 0.55;
const LINE_H_EM = 1.2;
const INSET_MM = 2;
const GAP_MM = 1.5;
const EPS = 1e-9;
const POSITION_X = { left: 0.2, center: 0.5, right: 0.8 } as const;

export interface LetterPanel { id: string; rect: Rect; script: PanelScript }
export interface ExistingFrame { panelId: string | null; text: string; box: Box; order: number }
export interface AutoLetterInput {
  layout: LayoutNode; format: PageFormat; direction: ReadingDirection; panels: LetterPanel[]; existingFrames: ExistingFrame[];
}
export interface LetterFrame {
  panelId: string; kind: FrameKind; text: string; speakerId: string | null; box: Box; tail: { x: number; y: number } | null;
  rotation: number; font: string; fontSize: number; align: 'left' | 'center' | 'right'; order: number;
}

interface Area { left: number; right: number; top: number; bottom: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Greedy word wrap by character count; words longer than a line are hard-split. */
export function wrapText(text: string, charsPerLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.trim().split(/\s+/).filter(Boolean)) {
    while (word.length > charsPerLine) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, charsPerLine));
      word = word.slice(charsPerLine);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= charsPerLine) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/** Size of the text block in mm (the UI's auto-fit shrinks the font later if this is off). */
export function estimateTextBoxMm(text: string, fontSizePt: number, maxWidthMm: number): { w: number; h: number; lines: number } {
  const em = fontSizePt * PT_TO_MM;
  const perLine = Math.max(4, Math.floor(maxWidthMm / (em * CHAR_W_EM)));
  const lines = wrapText(text, perLine);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { w: longest * em * CHAR_W_EM, h: lines.length * em * LINE_H_EM, lines: lines.length };
}

/**
 * Frame box (mm) that holds the text estimate once the UI's `textBox` insets are applied: bubbles divide by
 * `TEXT_INSET[kind]` (the text sits in that fraction of the box), narration adds `NARRATION_PAD` of the shorter side per edge.
 */
function frameSizeMm(kind: FrameKind, text: string, fontSize: number, panelWidthMm: number): { w: number; h: number } {
  if (kind === 'narration') {
    const t = estimateTextBoxMm(text, fontSize, Math.min(panelWidthMm * 0.5, 50));
    const keep = 1 - 2 * NARRATION_PAD;
    // Pad is a fraction of the shorter side: solve assuming h is the shorter side, else w.
    let h = t.h / keep;
    let w = t.w + 2 * NARRATION_PAD * h;
    if (w < h) { w = t.w / keep; h = t.h + 2 * NARRATION_PAD * w; }
    return { w: w + 1, h: h + 1 };
  }
  if (kind === 'sfx') {
    const em = fontSize * PT_TO_MM;
    return { w: text.length * em * CHAR_W_EM * 1.1 + 2, h: em * LINE_H_EM + 2 };
  }
  const t = estimateTextBoxMm(text, fontSize, Math.min(panelWidthMm * 0.42, 42));
  const inset = kind === 'shout' || kind === 'thought' || kind === 'speech' ? TEXT_INSET[kind] : 1;
  return { w: t.w / inset + 2, h: t.h / inset + 2 };
}

/** True when a and b are closer than the gap (EPS keeps "exactly one gap apart" from counting as a hit). */
function tooClose(a: Box, b: Box, gx: number, gy: number): boolean {
  return a.x < b.x + b.w + gx - EPS && b.x < a.x + a.w + gx - EPS && a.y < b.y + b.h + gy - EPS && b.y < a.y + a.h + gy - EPS;
}

/** True when the box overlaps the area (touching edges do not count). */
function intersects(b: Box, area: Area): boolean {
  return b.x < area.right - EPS && b.x + b.w > area.left + EPS && b.y < area.bottom - EPS && b.y + b.h > area.top + EPS;
}

function placeBubble(w: number, h: number, area: Area, dir: ReadingDirection, occupied: Box[], gx: number, gy: number): Box {
  let y = area.top;
  for (let row = 0; row < 500 && y + h <= area.bottom + EPS; row++) {
    let x = dir === 'rtl' ? area.right - w : area.left;
    for (let step = 0; step < 500 && x >= area.left - EPS && x + w <= area.right + EPS; step++) {
      const cand: Box = { x, y, w, h };
      const hit = occupied.find((o) => tooClose(cand, o, gx, gy));
      if (!hit) return cand;
      x = dir === 'rtl' ? hit.x - gx - w : hit.x + hit.w + gx;
    }
    const blockers = occupied.filter((o) => o.y < y + h + gy - EPS && y < o.y + o.h + gy - EPS).map((o) => o.y + o.h + gy);
    const next = blockers.length > 0 ? Math.min(...blockers) : y + gy;
    y = next > y + EPS ? next : y + gy;
  }
  // No room left: clamp into the bottom reading-start corner (may overlap; the user adjusts).
  return { x: dir === 'rtl' ? area.right - w : area.left, y: Math.max(area.top, area.bottom - h), w, h };
}

function placeSfx(w: number, h: number, area: Area, occupied: Box[], gy: number): Box {
  const x = (area.left + area.right) / 2 - w / 2;
  const centred = (area.top + area.bottom) / 2 - h / 2;
  const lowest = occupied.reduce((m, o) => Math.max(m, o.y + o.h + gy), area.top);
  let y = Math.max(centred, lowest);
  if (y + h > area.bottom) y = Math.max(area.top, area.bottom - h);
  return { x, y, w, h };
}

function tailTip(panel: LetterPanel, line: DialogueLine, box: Box, area: Area): { x: number; y: number } {
  const speaker = line.speakerId === null ? undefined : panel.script.characters.find((c) => c.characterId === line.speakerId);
  const r = panel.rect;
  const x = r.x + r.w * POSITION_X[speaker?.position ?? 'center'];
  let y = r.y + r.h * TAIL_Y;
  const bottom = box.y + box.h;
  if (y < bottom + r.h * 0.05) y = bottom + r.h * 0.08;
  return { x: clamp(x, area.left, area.right), y: clamp(y, area.top, area.bottom) };
}

/**
 * Frames to create for every not-yet-lettered dialogue line, panels in reading order (spec §9.3). Pure.
 * Adds frames for lines with no frame of the same text (exact match, per panel): an edited bubble is lettered again.
 * Each frame carries its `panelId`, so it follows its panel when the layout changes later.
 */
export function autoLetter(input: AutoLetterInput): LetterFrame[] {
  const { format, direction } = input;
  const byId = new Map(input.panels.map((p) => [p.id, p]));
  const gx = GAP_MM / format.widthMm;
  const gy = GAP_MM / format.heightMm;
  const ix = INSET_MM / format.widthMm;
  const iy = INSET_MM / format.heightMm;
  let order = input.existingFrames.reduce((m, f) => Math.max(m, f.order), -1) + 1;
  const out: LetterFrame[] = [];

  for (const id of readingOrder(input.layout, direction)) {
    const panel = byId.get(id);
    if (!panel) continue;
    const r = panel.rect;
    const area: Area = { left: r.x + ix, right: r.x + r.w - ix, top: r.y + iy, bottom: r.y + r.h - iy };
    const existing = input.existingFrames.filter((f) => f.panelId === id);
    // Obstacles: every frame whose box reaches into this panel's lettering area, whatever its panelId (page-level frames
    // included). Frames wholly in other panels must not count: `placeSfx` would slide below them. Only the text match is per panel.
    const occupied: Box[] = input.existingFrames.map((f) => f.box).filter((b) => intersects(b, area));
    const todo = panel.script.dialogue.filter((l) => !existing.some((f) => f.text === l.text));
    const sorted = [
      ...todo.filter((l) => l.kind === 'narration'),
      ...todo.filter((l) => l.kind !== 'narration' && l.kind !== 'sfx'),
      ...todo.filter((l) => l.kind === 'sfx'),
    ];
    for (const line of sorted) {
      const kind: FrameKind = line.kind;
      const fontSize = DEFAULT_FONT_SIZE[kind];
      const mm = frameSizeMm(kind, line.text, fontSize, r.w * format.widthMm);
      const w = Math.min(mm.w / format.widthMm, area.right - area.left);
      const h = Math.min(mm.h / format.heightMm, area.bottom - area.top);
      const box = kind === 'sfx' ? placeSfx(w, h, area, occupied, gy) : placeBubble(w, h, area, direction, occupied, gx, gy);
      const tail = kind === 'sfx' || kind === 'narration' ? null : tailTip(panel, line, box, area);
      occupied.push(box);
      out.push({
        panelId: id, kind, text: line.text, speakerId: line.speakerId, box, tail, rotation: kind === 'sfx' ? -10 : 0,
        font: FONT_FOR_KIND[kind], fontSize, align: kind === 'narration' ? 'left' : 'center', order: order++,
      });
    }
  }
  return out;
}
