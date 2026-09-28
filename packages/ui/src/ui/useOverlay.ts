import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = '[autofocus], input:not([type="hidden"]), textarea, select, button:not([aria-disabled="true"])';

/** Focus the first control on open, close on Escape (unless a popover consumed it), restore focus on close. */
export function useOverlay(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, ref]);
}
