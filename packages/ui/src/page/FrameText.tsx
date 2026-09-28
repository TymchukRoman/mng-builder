import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { MIN_READABLE_PT, type TextFrame } from '@manga/shared';
import { TriangleAlert } from '../ui/icons';
import { AUTOFIT_MIN_PT, fitFontSize, isBelowReadable, type FitResult } from './autofit';
import type { BoxPx } from './bubbles';
import { ptToPx } from './geometry';
import { useFontsReady } from './useFontsReady';

export interface FrameTextProps {
  frame: TextFrame;
  /** The inscribed text box (bubbles.textBox), in page pixels. */
  box: BoxPx;
  ppm: number;
  mode: 'edit' | 'thumb' | 'print';
}

export function FrameText({ frame, box, ppm, mode }: FrameTextProps): JSX.Element {
  const measureRef = useRef<HTMLDivElement>(null);
  const fontsTick = useFontsReady();
  const [fit, setFit] = useState<FitResult>({ pt: frame.fontSize, overflow: false });

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const measure = (pt: number): { w: number; h: number } => {
      el.style.fontSize = `${ptToPx(pt, ppm)}px`;
      return { w: el.scrollWidth, h: el.scrollHeight };
    };
    if (!frame.autoFit) {
      const m = measure(frame.fontSize);
      setFit({ pt: frame.fontSize, overflow: m.w > box.w + 0.5 || m.h > box.h + 0.5 });
      return;
    }
    setFit(fitFontSize({ maxPt: frame.fontSize, minPt: AUTOFIT_MIN_PT, box: { w: box.w, h: box.h }, measure }));
  }, [frame.text, frame.font, frame.fontSize, frame.autoFit, frame.kind, box.w, box.h, ppm, fontsTick]);

  const fontPx = ptToPx(fit.pt, ppm);
  const family = `"${frame.font}", sans-serif`;
  const rotated = frame.rotation !== 0 && (frame.kind === 'sfx' || frame.kind === 'title');
  const style: CSSProperties & Record<'--stroke', string> = {
    left: box.x, top: box.y, width: box.w, height: box.h,
    fontFamily: family, fontSize: `${fontPx}px`, textAlign: frame.align,
    '--stroke': `${Math.max(1, fontPx * 0.14)}px`,
    ...(rotated ? { transform: `rotate(${frame.rotation}deg)` } : {}),
  };
  const warn = mode === 'edit' && (fit.overflow || isBelowReadable(fit.pt));
  const warnText = fit.overflow ? 'Text does not fit the frame' : `Text shrank to ${fit.pt} pt (below ${MIN_READABLE_PT} pt)`;

  return (
    <>
      <div className={`frame-text frame-text--${frame.kind}`} style={style} data-fit-pt={fit.pt}>
        <div className="frame-text__inner">{frame.text}</div>
      </div>
      <div ref={measureRef} aria-hidden className={`frame-text__measure frame-text--${frame.kind}`} style={{ width: box.w, fontFamily: family }}>
        {frame.text || ' '}
      </div>
      {warn && (
        <span className="frame-warn" role="img" aria-label={warnText} data-tip={warnText} style={{ left: box.x + box.w - 7, top: box.y - 7 }}>
          <TriangleAlert size={12} aria-hidden />
        </span>
      )}
    </>
  );
}
