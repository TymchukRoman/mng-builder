export type OpenFocusTarget = 'first' | 'self';

/**
 * Where to move focus when a portal-rendered overlay (Popover) opens: its first focusable
 * descendant, or the overlay container itself (which must carry tabIndex={-1} to accept it).
 */
export function openFocusTarget(hasFocusable: boolean): OpenFocusTarget {
  return hasFocusable ? 'first' : 'self';
}

/**
 * Whether to restore focus, on close, to the element that held it before the overlay opened.
 * Skipped when that element is no longer in the document (e.g. it was removed while the overlay was open).
 */
export function shouldRestoreFocus(previousStillConnected: boolean): boolean {
  return previousStillConnected;
}

/** What `initialFocusIndex` needs to know about one focusable element of a Modal or Drawer, in document order. */
export interface FocusCandidate { autofocus: boolean; inBody: boolean }

/** What a Modal or Drawer focuses on open when no element is marked `data-autofocus`: its first body control (Modal), or itself (Drawer). */
export type FocusFallback = 'first-control' | 'container';

/**
 * Which element a Modal or Drawer focuses on open (I2): the one marked `data-autofocus` (a create form's first field).
 * With none marked, a Modal takes the first focusable element of its body, else the first focusable element at all
 * (the header's Close button); a Drawer takes -1, which means its own container (tabIndex -1), because its body holds
 * settings whose first control (a language radio) a stray Enter or Space would change. -1 also when nothing is focusable.
 * React's `autoFocus` renders no attribute, and the header comes first in document order, so a plain query found Close.
 */
export function initialFocusIndex(candidates: readonly FocusCandidate[], fallback: FocusFallback = 'first-control'): number {
  const marked = candidates.findIndex((c) => c.autofocus);
  if (marked >= 0) return marked;
  if (fallback === 'container') return -1;
  const body = candidates.findIndex((c) => c.inBody);
  if (body >= 0) return body;
  return candidates.length > 0 ? 0 : -1;
}
