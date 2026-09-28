import { useEffect, useState, type JSX } from 'react';
import { parseNumberDraft } from './formValues';

/** Commits on blur or Enter only, so half-typed numbers are never saved. Invalid input snaps back. */
export function NumberField({ value, onSave, label, min, max, step = 1, integer = false }: {
  value: number; onSave(n: number): void; label: string; min?: number; max?: number; step?: number; integer?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const commit = (): void => {
    const n = parseNumberDraft(draft, { integer, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) });
    if (n === null || n === value) { setDraft(String(value)); return; }
    setDraft(String(n));
    onSave(n);
  };
  return (
    <input
      aria-label={label} className="input" type="number" inputMode="decimal" step={step} min={min} max={max} value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
    />
  );
}
