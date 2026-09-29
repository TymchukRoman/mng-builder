import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { TextFrame } from '@manga/shared';
import { TriangleAlert } from '../ui/icons';
import { AUTOFIT_MIN_PT, fitFontSize, fitWarning, fontFamilyFor, measureBox, type FitResult } from './autofit';
import type { BoxPx } from './bubbles';
import { ptToPx } from './geometry';
import { useFontsReady } from './useFontsReady';

export interface FrameTextProps {
  frame: TextFrame;
  /** The inscribed text box (bubbles.textBox), in page pixels. */
  box: BoxPx;
  /** Pixels per mm of the current render (edit, thumbnail or print). */
  ppm: number;
  /** Pixels per mm at full print DPI: the scale the fit is computed at, so the pt is the same in every mode. */
  printPpm: number;
  mode: 'edit' | 'thumb' | 'print';
}

export function FrameText({ frame, box, ppm, printPpm, mode }: FrameTextProps): JSX.Element {
  const measureRef = useRef<HTMLDivElement>(null);
  const fontsTick = useFontsReady();
  const [fit, setFit] = useState<FitResult>({ pt: frame.fontSize, overflow: false });

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const pm = measureBox(box, ppm, printPpm);
    el.style.width = `${pm.w}px`;
    const measure = (pt: number): { w: number; h: number } => {
      el.style.fontSize = `${ptToPx(pt, pm.ppm)}px`;
      return { w: el.scrollWidth, h: el.scrollHeight };
    };
    let next: FitResult;
    if (frame.autoFit) {
      next = fitFontSize({ maxPt: frame.fontSize, minPt: AUTOFIT_MIN_PT, box: pm, measure });
    } else {
      const m = measure(frame.fontSize);
      next = { pt: frame.fontSize, overflow: m.w > pm.w + 0.5 || m.h > pm.h + 0.5 };
    }
    setFit((prev) => (prev.pt === next.pt && prev.overflow === next.overflow ? prev : next));
  }, [frame.text, frame.font, frame.fontSize, frame.autoFit, frame.kind, box.w, box.h, ppm, printPpm, fontsTick]);

  const fontPx = ptToPx(fit.pt, ppm);
  const family = fontFamilyFor(frame.font);
  const rotated = frame.rotation !== 0 && (frame.kind === 'sfx' || frame.kind === 'title');
  const style: CSSProperties & Record<'--stroke', string> = {
    left: box.x, top: box.y, width: box.w, height: box.h,
    fontFamily: family, fontSize: `${fontPx}px`, textAlign: frame.align,
    '--stroke': `${Math.max(1, fontPx * 0.14)}px`,
    ...(rotated ? { transform: `rotate(${frame.rotation}deg)` } : {}),
  };
  const warnText = mode === 'edit' ? fitWarning(fit, frame.fontSize, frame.autoFit) : null;

  return (
    <>
      <div className={`frame-text frame-text--${frame.kind}`} style={style} data-fit-pt={fit.pt}>
        <div className="frame-text__inner">{frame.text}</div>
      </div>
      <div ref={measureRef} aria-hidden className={`frame-text__measure frame-text--${frame.kind}`} style={{ left: -99999, top: 0, fontFamily: family }}>
        {frame.text || ' '}
      </div>
      {warnText && (
        <span className="frame-warn" role="img" aria-label={warnText} data-tip={warnText} style={{ left: box.x + box.w - 7, top: box.y - 7 }}>
          <TriangleAlert size={12} aria-hidden />
        </span>
      )}
    </>
  );
}
