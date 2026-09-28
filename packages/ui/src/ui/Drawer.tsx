import { useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import { X } from './icons';
import { useOverlay } from './useOverlay';

export function Drawer({ open, onClose, title, actions, children }: { open: boolean; onClose(): void; title: string; actions?: ReactNode; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLElement>(null);
  useOverlay(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="overlay-scrim overlay-scrim--light" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-label={title} className="drawer">
        <header className="drawer__head">
          <h2>{title}</h2>
          <div className="row">{actions}<IconButton icon={X} label="Close" size="sm" onClick={onClose} /></div>
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
