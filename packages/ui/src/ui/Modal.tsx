import { useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import { X } from './icons';
import { useOverlay } from './useOverlay';

export function Modal({ open, onClose, title, width = 420, children }: { open: boolean; onClose(): void; title: string; width?: number; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="overlay-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="modal" style={{ width }}>
        <header className="modal__head">
          <h2>{title}</h2>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
