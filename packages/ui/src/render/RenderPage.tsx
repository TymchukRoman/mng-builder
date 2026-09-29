import { useEffect, useRef, type JSX } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { PageView } from '../page/PageView';
import { renderSize } from '../page/pageModel';
import { useManga, usePageDetail } from '../queries';
import { errorText } from '../ui/toasts';
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
  const detail = usePageDetail(pageId);
  const manga = useManga(detail.data?.page.mangaId);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('render-mode');
    return () => document.documentElement.classList.remove('render-mode');
  }, []);

  useEffect(() => {
    const err = detail.error ?? manga.error;
    if (err) window.__MANGA_RENDER_ERROR__ = errorText(err);
  }, [detail.error, manga.error]);

  useEffect(() => {
    if (!detail.data || !manga.data) return;
    let cancelled = false;
    void (async () => {
      await document.fonts.ready;
      const imgs = Array.from(rootRef.current?.querySelectorAll('img') ?? []);
      await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
      await frames(2); // lets FrameText re-measure with the loaded fonts and commit
      await document.fonts.ready;
      await frames(1); // a font that finished loading just now re-fits the text; let that commit before signalling
      if (!cancelled) window.__MANGA_RENDER_READY__ = true;
    })();
    return () => { cancelled = true; };
  }, [detail.data, manga.data]);

  if (!detail.data || !manga.data) return <div className="render-root" />;
  const size = renderSize(manga.data.pageFormat, search.get('scale'));
  return (
    <div ref={rootRef} className="render-root" style={{ width: size.w, height: size.h }}>
      <PageView detail={detail.data} manga={manga.data} widthPx={size.w} mode="print" />
    </div>
  );
}
