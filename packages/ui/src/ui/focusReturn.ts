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
