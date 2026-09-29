import { useEffect, useLayoutEffect, useRef } from 'react';
import { isTypingTarget, keyAction } from './keys';

export interface EditorKeyHandlers {
  onUndo(): void;
  onRedo(): void;
  onDelete(): void;
  onEscape(): void;
  onNudge(dx: number, dy: number): void;
}

/** Spec §9.3 shortcuts. Never while typing in a field, and never while a modal, drawer or popover owns the keyboard. */
export function useEditorKeys(handlers: EditorKeyHandlers): void {
  const ref = useRef(handlers);
  useLayoutEffect(() => { ref.current = handlers; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('.overlay-scrim, .popover')) return;
      const action = keyAction(e);
      if (!action) return;
      e.preventDefault();
      const h = ref.current;
      switch (action.type) {
        case 'undo': h.onUndo(); break;
        case 'redo': h.onRedo(); break;
        case 'delete': h.onDelete(); break;
        case 'escape': h.onEscape(); break;
        case 'nudge': h.onNudge(action.dx, action.dy); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
