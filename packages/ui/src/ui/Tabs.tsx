import type { JSX } from 'react';
import { cx } from '../lib/cx';
import type { LucideIcon } from './icons';

export interface TabItem<T extends string> { id: T; label: string; icon?: LucideIcon }

export function Tabs<T extends string>({ items, value, onChange, label }: { items: Array<TabItem<T>>; value: T; onChange(id: T): void; label: string }): JSX.Element {
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={it.id === value} className={cx('tabs__tab', it.id === value && 'is-active')} onClick={() => onChange(it.id)}>
          {it.icon && <it.icon size={14} aria-hidden />}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
