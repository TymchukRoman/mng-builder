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

/**
 * Which element a Modal or Drawer focuses on open (I2): the one marked `data-autofocus`, else the first focusable element
 * of its body, else the first focusable element at all (the header's Close button). -1 when nothing is focusable.
 * React's `autoFocus` renders no attribute, and the header comes first in document order, so a plain query found Close.
 */
export function initialFocusIndex(candidates: readonly FocusCandidate[]): number {
  const marked = candidates.findIndex((c) => c.autofocus);
  if (marked >= 0) return marked;
  const body = candidates.findIndex((c) => c.inBody);
  if (body >= 0) return body;
  return candidates.length > 0 ? 0 : -1;
}
