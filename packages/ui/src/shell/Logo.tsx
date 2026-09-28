import type { JSX } from 'react';

/** A page split into three panels: the product in one glyph. */
export function Logo(): JSX.Element {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden className="logo">
      <rect x="0.75" y="0.75" width="16.5" height="20.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="3" width="5.5" height="7" fill="currentColor" opacity="0.85" />
      <rect x="10" y="3" width="5" height="7" fill="currentColor" opacity="0.45" />
      <rect x="3" y="12" width="12" height="7" fill="currentColor" opacity="0.65" />
    </svg>
  );
}
