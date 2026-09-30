import { expect, test } from '@playwright/test';
import { collectErrors, seedManga } from './helpers';

test('a crafted cover link sends no POST and leaves the server up (I1)', async ({ page, request }) => {
  const errors = collectErrors(page);
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') sent.push(`${r.method()} ${r.url()}`); });

  // React Router decodes the param to "x/../../shutdown?"; unvalidated, it became POST /api/shutdown?/cover.
  await page.goto('/m/x%2F..%2F..%2Fshutdown%3F/cover');
  await page.waitForLoadState('networkidle');
  expect(sent).toEqual([]);
  await expect(page.getByText('Not found')).toBeVisible();
  await page.goto('/m/mg_abc/c/x%2F..%2F..%2Fshutdown%3F/cover');
  await expect(page.getByText('Not found')).toBeVisible();

  expect(sent).toEqual([]);
  expect((await request.get('/api/health')).ok()).toBe(true);
  expect(errors.all()).toEqual([]);
});

test('create dialogs open on their first field: typing fills it and Enter does not close the dialog (I2)', async ({ page, request }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New manga' }).click();
  const dialog = page.getByRole('dialog', { name: 'New manga' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
  // Enter on the empty title submits nothing; on the Close button it used to discard the dialog.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('X');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('X');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const { mangaId } = await seedManga(request, 'E2E focus');
  await page.goto(`/m/${mangaId}`);
  await page.getByRole('button', { name: 'New chapter' }).click();
  await expect(page.getByRole('dialog', { name: 'New chapter' }).getByLabel('Title', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.goto(`/m/${mangaId}?tab=characters`);
  await page.getByRole('button', { name: 'New character' }).click();
  await expect(page.getByRole('dialog', { name: 'New character' }).getByLabel('Name', { exact: true })).toBeFocused();
  expect(errors.all()).toEqual([]);
});

test('the Manga settings drawer opens on its container, so a stray Enter or Space changes nothing; Escape closes it and returns focus', async ({ page, request }) => {
  const errors = collectErrors(page);
  const { mangaId } = await seedManga(request, 'E2E drawer focus');
  await page.goto(`/m/${mangaId}`);
  const trigger = page.getByRole('button', { name: 'Manga settings' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Manga settings' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();
  const english = drawer.getByRole('radio', { name: 'English' });
  const ukrainian = drawer.getByRole('radio', { name: 'Українська' });
  const before = await english.getAttribute('aria-checked');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await english.getAttribute('aria-checked')).toBe(before);
  expect(await ukrainian.getAttribute('aria-checked')).not.toBe(before);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(errors.all()).toEqual([]);
});

const INJECTED = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Injected failure' } }) };

test('a failed load says so and offers Retry, which recovers once the server answers (M1, M2)', async ({ page, request }) => {
  const { mangaId, chapterId, pageId } = await seedManga(request, 'E2E retry');
  const errors = collectErrors(page, { allowedFailures: [{ status: 503, urlSuffix: '/api/mangas' }, { status: 503, urlSuffix: `/api/pages/${pageId}` }] });

  // The manga list: the error, Retry, and the "+" card stays.
  await page.route('**/api/mangas', (route) => route.fulfill(INJECTED));
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'Injected failure' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New manga' })).toBeVisible();
  await page.unroute('**/api/mangas');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator(`[data-manga-id="${mangaId}"]`)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Injected failure' })).toHaveCount(0);

  // The editor canvas: a page that failed to load is not "No pages yet".
  await page.route(`**/api/pages/${pageId}`, (route) => route.fulfill(INJECTED));
  await page.goto(`/m/${mangaId}/c/${chapterId}?p=${pageId}`);
  const canvas = page.locator('.canvas');
  await expect(canvas.getByRole('alert').filter({ hasText: 'Injected failure' })).toBeVisible();
  await expect(canvas.getByText('No pages yet')).toHaveCount(0);
  await page.unroute(`**/api/pages/${pageId}`);
  await canvas.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.page-view--edit [data-panel-id]')).toHaveCount(4);
  expect(errors.all()).toEqual([]);
});

test('a panel image that fails to load shows a warning badge, not a blank panel (M7)', async ({ page, request }) => {
  const { mangaId, chapterId, pageId } = await seedManga(request, 'E2E broken image');
  const detail = (await (await request.get(`/api/pages/${pageId}`)).json()) as { panels: Array<{ id: string }> };
  const panelId = detail.panels[0]?.id ?? '';
  const job = (await (await request.post(`/api/panels/${panelId}/generate`, { data: {} })).json()) as { jobId: string };
  await expect.poll(async () => ((await (await request.get(`/api/jobs/${job.jobId}`)).json()) as { status: string }).status).toBe('succeeded');

  const errors = collectErrors(page, { allowedFailures: { status: 404, urlSuffix: '.png' } });
  await page.route('**/files/images/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`/m/${mangaId}/c/${chapterId}?p=${pageId}`);
  const panel = page.locator(`.page-view--edit [data-panel-id="${panelId}"]`);
  await expect(panel.getByRole('img', { name: 'Image failed to load' })).toBeVisible();
  await expect(panel).toHaveClass(/panel--empty/);
  await expect(panel.locator('img')).toHaveCount(0);
  expect(errors.all()).toEqual([]);
});

test('the print route flags a missing page and a crafted id as errors, never as ready', async ({ page }) => {
  const errors = collectErrors(page, { allowedFailures: { status: 404, urlSuffix: '/api/pages/pg_missing' } });
  await page.goto('/render/page/pg_missing');
  await expect.poll(() => page.evaluate('window.__MANGA_RENDER_ERROR__ ?? null') as Promise<string | null>).toContain('pg_missing');
  expect(await page.evaluate('window.__MANGA_RENDER_READY__ ?? false')).toBe(false);

  const pageRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/pages/')) pageRequests.push(r.url()); });
  // Unvalidated, this was GET /api/pages/pg_x/shutdown?. (A crafted id with dots never reaches the SPA: the server's fallback skips paths with an extension.)
  await page.goto('/render/page/pg_x%2Fshutdown%3F');
  await expect.poll(() => page.evaluate('window.__MANGA_RENDER_ERROR__ ?? null') as Promise<string | null>).toContain('not found');
  expect(await page.evaluate('window.__MANGA_RENDER_READY__ ?? false')).toBe(false);
  expect(pageRequests).toEqual([]);
  expect(errors.all()).toEqual([]);
});
