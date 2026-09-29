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
