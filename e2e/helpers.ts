import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** Console errors and uncaught exceptions. `ignoreResourceErrors` drops Chrome's "Failed to load resource" lines (e.g. an expected 409). */
export function collectErrors(page: Page, opts: { ignoreResourceErrors: boolean }): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (opts.ignoreResourceErrors && m.text().startsWith('Failed to load resource')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
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
