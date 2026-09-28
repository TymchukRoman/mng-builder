import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { placePopover } from './tipPlacement';

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  align?: 'start' | 'end';
  label: string;
  className?: string;
  children: ReactNode;
}

export function Popover({ anchor, open, onClose, align = 'start', label, className, children }: PopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = (): void => {
      const a = anchor.current;
      const p = ref.current;
      if (!a || !p) return;
      setPos(placePopover(a.getBoundingClientRect(), p.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, align));
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [open, align, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    // Capture phase + preventDefault, so an enclosing Modal or Drawer does not also close on the same Escape.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} className={cx('popover', className)} style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}>
      {children}
    </div>,
    document.body,
  );
}
