// packages/server/src/workflows/episode/fit.ts
import { PRESET_NAMES, presetPanelCount, sameName, type PanelScriptDraft } from '@manga/shared';

/** The most panels any layout preset holds (6: '2x3'). A page script with more is folded into this many. */
export const MAX_PRESET_PANELS = Math.max(...PRESET_NAMES.map(presetPanelCount));

/** The layout a page with this many panels gets when its breakdown preset has another count and no sibling fits. */
const DEFAULT_PRESET: Readonly<Record<number, string>> = { 1: 'splash', 2: '2-rows', 3: '3-rows', 4: '2x2', 5: '5-stagger', 6: '2x3' };

/** A preset of the same family with `count` panels: "N-rows" (1: 'splash') or "big-top-K" (a big panel over K). */
function sibling(preset: string, count: number): string | undefined {
  const candidate = /^\d-rows$/.test(preset) ? (count === 1 ? 'splash' : `${count}-rows`)
    : /^big-top-\d$/.test(preset) ? `big-top-${count - 1}`
      : undefined;
  return candidate !== undefined && PRESET_NAMES.includes(candidate) && presetPanelCount(candidate) === count ? candidate : undefined;
}

/**
 * The layout for a page whose script has `count` panels (1..MAX_PRESET_PANELS): the breakdown's `preset` when its count
 * fits; otherwise a preset of the same family, then a fixed default per count. Deterministic.
 */
export function fitPreset(preset: string, count: number): string {
  if (presetPanelCount(preset) === count) return preset;
  const fitted = sibling(preset, count) ?? DEFAULT_PRESET[count] ?? PRESET_NAMES.find((p) => presetPanelCount(p) === count);
  if (fitted === undefined) throw new Error(`no layout preset has ${count} panels`);
  return fitted;
}

/**
 * At most `max` panels: panels max..N fold into panel `max` — their actions joined with " Then ", their characters united
 * (by name, first kept, at most 4 as a panel script allows), their dialogue in order; that panel keeps its own shot,
 * angle and background. Fewer panels come back unchanged.
 */
export function foldPanels(panels: PanelScriptDraft[], max: number): PanelScriptDraft[] {
  if (panels.length <= max) return panels;
  const rest = panels.slice(max - 1);
  const first = rest[0]!;
  const characters: PanelScriptDraft['characters'] = [];
  for (const c of rest.flatMap((p) => p.characters)) {
    if (characters.length < 4 && !characters.some((k) => sameName(k.name, c.name))) characters.push(c);
  }
  return [
    ...panels.slice(0, max - 1),
    { ...first, action: rest.map((p) => p.action.trim()).join(' Then '), characters, dialogue: rest.flatMap((p) => p.dialogue) },
  ];
}
