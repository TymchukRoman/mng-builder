import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** A response the test expects to fail, so that Chrome's console line for it is not an error. */
export interface AllowedFailure { status: number; urlSuffix: string }

export interface ErrorLog {
  /** Console errors and uncaught exceptions so far. A "Failed to load resource" line counts unless a recorded response of an allowed failure explains it. */
  all(): string[];
}

/**
 * Console errors and uncaught exceptions. Chrome logs every failed load (404, 409, 500...) as a console error without a status
 * in the message, so each one is matched to its recorded response: only `allowedFailures` are dropped, anything else stays an error.
 */
export function collectErrors(page: Page, opts: { allowedFailures?: AllowedFailure | AllowedFailure[] } = {}): ErrorLog {
  const allowed = opts.allowedFailures === undefined ? [] : [opts.allowedFailures].flat();
  const errors: string[] = [];
  const resourceErrors: Array<{ text: string; url: string }> = [];
  const failed = new Map<string, number>(); // url -> status of the failed responses seen
  page.on('response', (r) => { if (r.status() >= 400) failed.set(r.url(), r.status()); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource')) resourceErrors.push({ text: m.text(), url: m.location().url });
    else errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return {
    all: () => [
      ...errors,
      // Judged on read, so a console line that arrives before its response event still matches.
      ...resourceErrors
        .filter(({ url }) => !allowed.some((a) => failed.get(url) === a.status && url.endsWith(a.urlSuffix)))
        .map((e) => e.text),
    ],
  };
}

/** The editable page on the canvas (thumbnails are PageViews too, in `thumb` mode). */
export function editPage(page: Page): Locator {
  return page.locator('.page-view--edit');
}

export function panelIds(page: Page): Promise<string[]> {
  return editPage(page).locator('[data-panel-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['panelId'] ?? ''));
}

/** The page's layout tree as the server has it, serialised so two reads compare with `toBe`. */
export async function layoutOf(request: APIRequestContext, pageId: string): Promise<string> {
  const res = await request.get(`/api/pages/${pageId}`);
  expect(res.ok()).toBe(true);
  return JSON.stringify(((await res.json()) as { page: { layout: unknown } }).page.layout);
}

/** Creates a manga (and optionally a chapter with one page) straight through the API, so a spec that is not about creation starts from data. */
export async function seedManga(request: APIRequestContext, title: string): Promise<{ mangaId: string; chapterId: string; pageId: string }> {
  const manga = await request.post('/api/mangas', { data: { title, language: 'en', colorMode: 'bw', readingDirection: 'rtl' } });
  expect(manga.ok()).toBe(true);
  const mangaId = ((await manga.json()) as { id: string }).id;
  const chapter = await request.post(`/api/mangas/${mangaId}/chapters`, { data: { title: 'Chapter one' } });
  expect(chapter.ok()).toBe(true);
  const chapterId = ((await chapter.json()) as { id: string }).id;
  const pageRes = await request.post(`/api/chapters/${chapterId}/pages`, { data: {} });
  expect(pageRes.ok()).toBe(true);
  const pageId = ((await pageRes.json()) as { page: { id: string } }).page.id;
  return { mangaId, chapterId, pageId };
}
