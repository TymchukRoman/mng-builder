import type { JSX } from 'react';
import { cx } from '../lib/cx';
import { useAutosaveDraft } from '../lib/useAutosaveDraft';

/** A text input or textarea that autosaves 300 ms after typing stops, and immediately on blur. */
export function AutoText({ value, onSave, label, multiline = false, rows = 3, placeholder, delay = 300, className }: {
  value: string; onSave(v: string): void | Promise<unknown>; label: string; multiline?: boolean; rows?: number; placeholder?: string; delay?: number; className?: string;
}): JSX.Element {
  const { draft, setDraft, flush } = useAutosaveDraft(value, onSave, delay);
  if (multiline) {
    return <textarea aria-label={label} className={cx('textarea', className)} rows={rows} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={flush} />;
  }
  return <input aria-label={label} className={cx('input', className)} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={flush} />;
}
