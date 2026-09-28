import type { ComponentPropsWithRef, JSX } from 'react';
import { cx } from '../lib/cx';
import { LoaderCircle, type LucideIcon } from './icons';
import type { Side } from './tipPlacement';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'title' | 'disabled'> {
  icon: LucideIcon;
  /** Tooltip text; also the accessible name. */
  label: string;
  /** Present only on toggle buttons: renders aria-pressed. */
  active?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  size?: 'sm' | 'md';
  busy?: boolean;
  disabled?: boolean;
  tipSide?: Side;
  badge?: number | null;
}

export function IconButton({
  icon: Icon, label, active, tone = 'default', size = 'md', busy = false, disabled = false,
  tipSide = 'bottom', badge = null, className, onClick, type = 'button', ...rest
}: IconButtonProps): JSX.Element {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      data-tip={label}
      data-tip-side={tipSide}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      {...(active === undefined ? {} : { 'aria-pressed': active })}
      className={cx('icon-btn', `icon-btn--${size}`, tone !== 'default' && `icon-btn--${tone}`, active && 'is-active', className)}
      onClick={(e) => {
        if (disabled || busy) { e.preventDefault(); return; }
        onClick?.(e);
      }}
    >
      {busy ? <LoaderCircle className="spin" size={iconSize} aria-hidden /> : <Icon size={iconSize} strokeWidth={1.75} aria-hidden />}
      {badge !== null && badge > 0 && <span className="icon-btn__badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}
