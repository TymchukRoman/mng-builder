import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { initialFocusIndex, type FocusFallback } from './focusReturn';

// Exported so Popover (which manages its own focus lifecycle instead of calling this hook, since it
// already owns outside-click and Escape handling) can reuse the same definition of "focusable".
export const FOCUSABLE = '[data-autofocus], input:not([type="hidden"]), textarea, select, button:not([aria-disabled="true"])';

/** Focus the `data-autofocus` field on open, else per `fallback` (see initialFocusIndex: the body's first control, or the container itself), close on Escape (unless a popover consumed it), restore focus on close. */
export function useOverlay(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>, fallback: FocusFallback = 'first-control'): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const body = root.querySelector('.modal__body, .drawer__body');
      const index = initialFocusIndex(els.map((el) => ({ autofocus: el.hasAttribute('data-autofocus'), inBody: body?.contains(el) ?? false })), fallback);
      (els[index] ?? root).focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, ref, fallback]);
}
