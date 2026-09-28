import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { placeTip, type Side } from './tipPlacement';

interface Shown { text: string; anchor: HTMLElement; side: Side }

function tipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
}

/** Draws every [data-tip] tooltip into document.body, so scroll containers never clip it. */
export function TooltipLayer(): JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    const show = (el: HTMLElement, delay: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const text = el.dataset.tip;
        if (text && el.isConnected) setShown({ text, anchor: el, side: (el.dataset.tipSide as Side | undefined) ?? 'bottom' });
      }, delay);
    };
    const hide = (): void => { window.clearTimeout(timer); setShown(null); setPos(null); };
    const over = (e: PointerEvent): void => { const el = tipOf(e.target); if (el) show(el, 350); };
    const out = (e: PointerEvent): void => {
      const el = tipOf(e.target);
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    };
    const focusIn = (e: FocusEvent): void => {
      const el = tipOf(e.target);
      if (el && el.matches(':focus-visible')) show(el, 0);
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerout', out);
    window.addEventListener('focusin', focusIn);
    window.addEventListener('focusout', hide);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointerout', out);
      window.removeEventListener('focusin', focusIn);
      window.removeEventListener('focusout', hide);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!shown || !bubble.current) return;
    const a = shown.anchor.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    setPos(placeTip(a, b, { width: window.innerWidth, height: window.innerHeight }, shown.side));
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div ref={bubble} role="tooltip" className="tooltip" style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}>
      {shown.text}
    </div>,
    document.body,
  );
}
