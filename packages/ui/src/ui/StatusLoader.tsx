import type { JSX } from 'react';
import { cx } from '../lib/cx';
import { LoaderCircle } from './icons';

/** A spinner that always says what is happening, plus a progress bar when the step count is known. */
export function StatusLoader({ label, value, max, className }: { label: string; value?: number | undefined; max?: number | undefined; className?: string }): JSX.Element {
  const pct = value !== undefined && max !== undefined && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : null;
  return (
    <div role="status" aria-live="polite" className={cx('status-loader', className)}>
      <LoaderCircle className="spin" size={14} aria-hidden />
      <span className="status-loader__label">{label}</span>
      {pct !== null && <span className="status-loader__bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>}
    </div>
  );
}
