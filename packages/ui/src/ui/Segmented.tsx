import type { JSX } from 'react';
import { cx } from '../lib/cx';
import type { LucideIcon } from './icons';

export interface SegOption<T extends string> { value: T; label: string; icon?: LucideIcon }

/** A radio group. Options with an icon show only the icon (label in the tooltip); others show the short label. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<SegOption<T>>; onChange(v: T): void; label: string }): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={o.value === value} aria-label={o.label}
          data-tip={o.icon ? o.label : undefined}
          className={cx('segmented__opt', o.value === value && 'is-on')}
          onClick={() => onChange(o.value)}
        >
          {o.icon ? <o.icon size={14} aria-hidden /> : o.label}
        </button>
      ))}
    </div>
  );
}
