import type { PointerEvent as ReactPointerEvent } from 'react';

/** Tracks one pointer drag on window, so the gesture survives re-renders of the element that started it. */
export function startDrag(e: ReactPointerEvent, h: { move(ev: PointerEvent): void; end(committed: boolean): void }): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const onMove = (ev: PointerEvent): void => h.move(ev);
  const finish = (ok: boolean) => (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    h.end(ok);
  };
  const onUp = finish(true);
  const onCancel = finish(false);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
