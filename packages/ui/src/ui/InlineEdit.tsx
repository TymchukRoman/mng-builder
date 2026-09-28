import { useEffect, useState, type JSX } from 'react';
import { cx } from '../lib/cx';
import { commitValue } from './formValues';

export function InlineEdit({ value, onCommit, label, multiline = false, required = false, placeholder, className }: {
  value: string; onCommit(v: string): void; label: string; multiline?: boolean; required?: boolean; placeholder?: string; className?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = (): void => {
    const next = commitValue(draft, value, { required, multiline });
    setEditing(false);
    if (next === null) setDraft(value);
    else onCommit(next);
  };
  const cancel = (): void => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        className={cx('inline-edit', multiline && 'inline-edit--multi', className)}
        // F17 ruling: the accessible name includes the current value, so it is not hidden from assistive tech
        // (the tooltip stays short since sighted users already see the value in the button).
        aria-label={`${label}: ${value}`}
        data-tip={`Edit ${label}`}
        onClick={() => setEditing(true)}
      >
        {value || <span className="inline-edit__placeholder">{placeholder ?? ''}</span>}
      </button>
    );
  }
  if (multiline) {
    return (
      <textarea
        className={cx('textarea inline-edit__field', className)} aria-label={label} rows={3} autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); commit(); }
        }}
      />
    );
  }
  return (
    <input
      className={cx('input inline-edit__field', className)} aria-label={label} autoFocus value={draft}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter') { e.preventDefault(); commit(); }
      }}
    />
  );
}
