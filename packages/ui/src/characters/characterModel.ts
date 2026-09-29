import type { Character, Image, RecipeInfo, RefSlot } from '@manga/shared';
import { portraitRecipes } from '../lib/recipes';

export const REF_SLOTS: readonly RefSlot[] = ['portrait', 'fullbody', 'side', 'back'];

/** Portraits queued per click (the server accepts 1-8). */
export const PORTRAIT_BATCH = 4;

const SLOT_LABEL: Record<RefSlot, string> = { portrait: 'Portrait', fullbody: 'Full body', side: 'Side', back: 'Back' };

export function slotLabel(slot: RefSlot): string {
  return SLOT_LABEL[slot];
}

export function imagesForSlot(images: readonly Image[] | undefined, slot: RefSlot): Image[] {
  return (images ?? []).filter((i) => i.role === slot).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function canGenerateSheet(c: Character): { enabled: boolean; reason: string } {
  return c.refs.portrait
    ? { enabled: true, reason: 'Generate sheet (full body, side, back)' }
    : { enabled: false, reason: 'Generate sheet: pick a portrait first' };
}

/** "Auto" plus the portrait recipes. A recipe set some other way (CLI, older data) stays listed so the select never shows a wrong value. */
export function characterRecipeOptions(list: readonly RecipeInfo[] | undefined, current: string | null): Array<{ value: string; label: string }> {
  const options = [{ value: '', label: 'Auto' }, ...portraitRecipes(list).map((r) => ({ value: r.id, label: r.label }))];
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: (list ?? []).find((r) => r.id === current)?.label ?? current });
  }
  return options;
}
