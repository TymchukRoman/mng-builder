/** Returns the value to save, or null when nothing should be saved (unchanged, or an empty required value). */
export function commitValue(draft: string, original: string, opts: { required: boolean; multiline: boolean }): string | null {
  const next = opts.multiline ? draft.replace(/\s+$/u, '') : draft.trim();
  if (opts.required && next.length === 0) return null;
  return next === original ? null : next;
}

export function parseNumberDraft(draft: string, opts: { min?: number; max?: number; integer: boolean }): number | null {
  const text = draft.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  let v = opts.integer ? Math.round(n) : n;
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return v;
}
