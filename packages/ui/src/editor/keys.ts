export type KeyAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'nudge'; dx: number; dy: number };

export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): KeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
  if (mod && key === 'y') return { type: 'redo' };
  if (mod) return null;
  if (e.key === 'Delete' || e.key === 'Backspace') return { type: 'delete' };
  if (e.key === 'Escape') return { type: 'escape' };
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case 'ArrowLeft': return { type: 'nudge', dx: -step, dy: 0 };
    case 'ArrowRight': return { type: 'nudge', dx: step, dy: 0 };
    case 'ArrowUp': return { type: 'nudge', dx: 0, dy: -step };
    case 'ArrowDown': return { type: 'nudge', dx: 0, dy: step };
    default: return null;
  }
}

/** Editor shortcuts never fire while the user types in a field. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}
