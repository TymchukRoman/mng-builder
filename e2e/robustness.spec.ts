import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

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
