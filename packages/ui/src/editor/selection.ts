import type { PageDetail } from '@manga/shared';

export type Selection =
  | { kind: 'page' }
  | { kind: 'panel'; panelId: string; mergeWith: string | null; adjust: boolean }
  | { kind: 'frame'; frameId: string };

export const PAGE_SELECTION: Selection = { kind: 'page' };

export function panelSelection(panelId: string, opts: { mergeWith?: string | null; adjust?: boolean } = {}): Selection {
  return { kind: 'panel', panelId, mergeWith: opts.mergeWith ?? null, adjust: opts.adjust ?? false };
}

export function frameSelection(frameId: string): Selection {
  return { kind: 'frame', frameId };
}

/** Plain click selects; shift-click on a different panel keeps the first and records the merge partner. */
export function clickPanel(current: Selection, panelId: string, shift: boolean): Selection {
  if (current.kind === 'panel') {
    if (shift && current.panelId !== panelId) return { ...current, mergeWith: panelId, adjust: false };
    if (!shift && current.panelId === panelId) return current;
  }
  return panelSelection(panelId);
}

export function selectedPanelId(s: Selection): string | null {
  return s.kind === 'panel' ? s.panelId : null;
}

/** Drops parts of a selection that no longer exist on the page (after a delete, merge or reload). */
export function reconcileSelection(s: Selection, detail: PageDetail): Selection {
  if (s.kind === 'panel') {
    const ids = new Set(detail.panels.map((p) => p.id));
    if (!ids.has(s.panelId)) return PAGE_SELECTION;
    if (s.mergeWith !== null && !ids.has(s.mergeWith)) return { ...s, mergeWith: null };
    return s;
  }
  if (s.kind === 'frame' && !detail.frames.some((f) => f.id === s.frameId)) return PAGE_SELECTION;
  return s;
}
