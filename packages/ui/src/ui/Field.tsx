import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * A <label> wrapper, so getByLabel(label) finds the control.
 * `group` renders a <div role="group"> instead: a <label> around buttons (Segmented) would forward
 * every click on the label text to the first button.
 */
export function Field({ label, hint, inline = false, group = false, children }: {
  label: string; hint?: string; inline?: boolean; group?: boolean; children: ReactNode;
}): JSX.Element {
  const body = (
    <>
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </>
  );
  const className = cx('field', inline && 'field--inline');
  return group
    ? <div className={className} role="group" aria-label={label}>{body}</div>
    : <label className={className}>{body}</label>;
}
