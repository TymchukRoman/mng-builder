import { useEffect, useRef, type JSX } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { isId } from '../lib/ids';
import { PageView } from '../page/PageView';
import { renderPageSize } from '../page/pageModel';
import { useManga } from '../queries';
import { errorText } from '../ui/toasts';
import { usePrintDetail } from './printDetail';
import { renderOutcome } from './renderOutcome';
import './render.css';

declare global {
  interface Window {
    __MANGA_RENDER_READY__?: boolean;
    __MANGA_RENDER_ERROR__?: string;
  }
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const step = (): void => { i += 1; if (i >= n) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

/** /render/page/:pageId?scale= — one page at exact print pixels, no chrome (Contract B, spec §10). */
export function RenderPage(): JSX.Element {
  const { pageId } = useParams();
  const [search] = useSearchParams();
  const valid = isId(pageId, 'pg'); // I1: a crafted id never reaches a request; it fails like a missing page
  const detail = usePrintDetail(valid ? pageId : undefined, search.get('hires') === '1');
  const manga = useManga(detail.data?.page.mangaId);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('render-mode');
    return () => document.documentElement.classList.remove('render-mode');
  }, []);

  useEffect(() => {
    if (!valid) { window.__MANGA_RENDER_ERROR__ = `page ${pageId ?? ''} not found`; return; }
    const err = detail.error ?? manga.error;
    if (err) window.__MANGA_RENDER_ERROR__ = errorText(err);
  }, [valid, pageId, detail.error, manga.error]);

  useEffect(() => {
    if (!detail.data || !manga.data) return;
    let cancelled = false;
    void (async () => {
      await document.fonts.ready;
      const imgs = Array.from(rootRef.current?.querySelectorAll('img') ?? []);
      const results = await Promise.all(imgs.map((img) => img.decode().then(
        () => ({ label: img.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId ?? img.src, ok: true }),
        () => ({ label: img.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId ?? img.src, ok: false }),
      )));
      const outcome = renderOutcome(results);
      if (!outcome.ready) {
        if (!cancelled) window.__MANGA_RENDER_ERROR__ = outcome.error; // fail fast: the exporter must not wait for READY
        return;
      }
      await frames(2); // lets FrameText re-measure with the loaded fonts and commit
      await document.fonts.ready;
      await frames(1); // a font that finished loading just now re-fits the text; let that commit before signalling
      if (!cancelled) window.__MANGA_RENDER_READY__ = true;
    })();
    return () => { cancelled = true; };
  }, [detail.data, manga.data]);

  if (!detail.data || !manga.data) return <div className="render-root" />;
  // Root and PageView share one size (PageView derives its height from the width), so no sliver of paper shows at any scale.
  const size = renderPageSize(manga.data.pageFormat, search.get('scale'));
  return (
    <div ref={rootRef} className="render-root" style={{ width: size.w, height: size.h }}>
      <PageView detail={detail.data} manga={manga.data} widthPx={size.w} mode="print" />
    </div>
  );
}
