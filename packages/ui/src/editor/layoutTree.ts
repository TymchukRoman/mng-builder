import { LayoutError, MAX_RATIO, MIN_RATIO, mergePanels, panelIds, type LayoutNode, type Rect, type SplitDir, type SplitPath } from '@manga/shared';
import type { Selection } from './selection';

/**
 * True when `a` and `b` are the two leaves of one split. Delegates to `mergePanels`, so the sibling
 * rule is exactly the server's and the Merge button is enabled precisely when the merge would be accepted.
 */
export function areSiblings(tree: LayoutNode, a: string, b: string): boolean {
  try {
    mergePanels(tree, a, b);
    return true;
  } catch (e) {
    if (e instanceof LayoutError) return false;
    throw e;
  }
}

/** The split ratio for a gutter drag: pointer position inside the split's parent rect, clamped like the server. */
export function ratioFromPointer(handle: { dir: SplitDir; parent: Rect }, p: { x: number; y: number }): number {
  const { parent } = handle;
  const raw = handle.dir === 'v' ? (p.x - parent.x) / parent.w : (p.y - parent.y) / parent.h;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw));
}

export function pathKey(path: SplitPath): string {
  return path.length === 0 ? 'root' : path.join('');
}

/** The panel id that exists in `after` but not in `before` (what a split created). */
export function newPanelId(before: LayoutNode, after: LayoutNode): string | null {
  const old = new Set(panelIds(before));
  return panelIds(after).find((id) => !old.has(id)) ?? null;
}

export function mergeState(tree: LayoutNode, s: Selection): { enabled: boolean; reason: string } {
  if (s.kind !== 'panel' || s.mergeWith === null) return { enabled: false, reason: 'Merge: select a panel, then shift-click its neighbour' };
  if (!areSiblings(tree, s.panelId, s.mergeWith)) return { enabled: false, reason: 'Merge: only two panels from the same split can merge' };
  return { enabled: true, reason: 'Merge panels (cannot be undone)' };
}

export function splitState(s: Selection): { enabled: boolean; reason: string } {
  return s.kind === 'panel' ? { enabled: true, reason: '' } : { enabled: false, reason: 'Select a panel to split' };
}
