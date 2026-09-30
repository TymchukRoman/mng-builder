// packages/server/src/export/browser.ts
import { printSizePx, type PageFormat } from '@manga/shared';
import type { Browser } from 'playwright';
import { PermanentError } from '../jobs/index.js';
import type { ExportItem } from './paths.js';

export const RENDER_TIMEOUT_MS = 60_000;

export interface RenderRequest {
  baseUrl: string; items: ExportItem[]; format: 'png' | 'pdf'; pageFormat: PageFormat; signal: AbortSignal;
  onPage?(done: number, total: number): void; timeoutMs?: number;
}
export type PageRenderer = (req: RenderRequest) => Promise<string[]>;

/** The print route lays the page out at print pixels (2150 px wide); page.pdf must shrink that onto 182 mm (= 687.9 CSS px). */
export function pdfScale(format: PageFormat): number {
  const cssWidth = (format.widthMm / 25.4) * 96;
  return Math.min(2, Math.max(0.1, cssWidth / printSizePx(format).w));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Playwright appends a multi-line call log; the job error keeps its first line. */
const firstLine = (text: string): string => text.split('\n', 1)[0] ?? text;

/**
 * One Chromium (the headless shell) per export job; one tab reused for every page. The browser is always closed, and
 * an abort closes it at once, so a cancelled export never waits out a page's render timeout.
 */
export const renderWithChromium: PageRenderer = async (req) => {
  // F29: loaded here, not at the top, so importers of @manga/server (CLI, tests) do not load Playwright.
  const { chromium, errors } = await import('playwright');
  const px = printSizePx(req.pageFormat);
  const timeout = req.timeoutMs ?? RENDER_TIMEOUT_MS;
  const cancelled = (): PermanentError => new PermanentError('Export cancelled');
  if (req.signal.aborted) throw cancelled();
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new PermanentError(`Could not start Chromium for export (run "npx playwright install --only-shell chromium"): ${messageOf(err)}`);
  }
  const onAbort = (): void => { void browser.close().catch(() => undefined); };
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await browser.newContext({ viewport: { width: px.w, height: px.h }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (req.format === 'pdf') await page.emulateMedia({ media: 'screen' });
    const files: string[] = [];
    for (const [i, item] of req.items.entries()) {
      if (req.signal.aborted) throw cancelled();
      req.onPage?.(i, req.items.length);
      // Contract E: ?hires=1 makes the print route load GET /api/pages/:id/print (the upscaled images).
      const url = `${req.baseUrl}/render/page/${encodeURIComponent(item.pageId)}?hires=1`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout });
      } catch (err) {
        // M1 (review): a stuck or failed navigation names the page, like a render timeout does.
        if (err instanceof errors.TimeoutError) throw new PermanentError(`Export timed out after ${Math.round(timeout / 1000)} s opening page ${item.pageId}`);
        throw new PermanentError(`Export could not open page ${item.pageId}: ${firstLine(messageOf(err))}`);
      }
      try {
        // M3's print route sets __MANGA_RENDER_READY__ when fonts and images are in, or __MANGA_RENDER_ERROR__ (a string) when loading failed.
        await page.waitForFunction('window.__MANGA_RENDER_READY__ === true || typeof window.__MANGA_RENDER_ERROR__ === "string"', undefined, { timeout });
      } catch (err) {
        if (err instanceof errors.TimeoutError) throw new PermanentError(`Export render timed out after ${Math.round(timeout / 1000)} s on page ${item.pageId}`);
        throw err;
      }
      const renderError = (await page.evaluate('window.__MANGA_RENDER_ERROR__ ?? null')) as string | null;
      if (renderError !== null) throw new PermanentError(`Export failed on page ${item.pageId}: ${renderError}`);
      if (req.format === 'png') {
        // F6 / Contract E print route notes: the PageView element, not the viewport (they differ by up to 3 px at scales other than 1).
        await page.locator('[data-testid="page-view"]').screenshot({ path: item.file, type: 'png' });
      } else {
        await page.pdf({
          path: item.file, width: `${req.pageFormat.widthMm}mm`, height: `${req.pageFormat.heightMm}mm`, printBackground: true,
          pageRanges: '1', margin: { top: '0', right: '0', bottom: '0', left: '0' }, scale: pdfScale(req.pageFormat),
        });
      }
      files.push(item.file);
    }
    req.onPage?.(req.items.length, req.items.length);
    return files;
  } catch (err) {
    if (req.signal.aborted) throw cancelled(); // the abort closed the browser under a pending call
    throw err;
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => undefined);
  }
};
