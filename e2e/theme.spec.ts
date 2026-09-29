import { expect, test } from '@playwright/test';
import { collectErrors, editPage, seedManga } from './helpers';

// --bg per theme (packages/ui/src/styles/tokens.css)
const BG = { light: 'rgb(239, 239, 236)', dark: 'rgb(22, 23, 25)' } as const;

for (const scheme of ['light', 'dark'] as const) {
  test(`the ${scheme} theme loads every screen without console errors`, async ({ page, request }, testInfo) => {
    const errors = collectErrors(page);
    const { mangaId, chapterId, pageId } = await seedManga(request, `E2E ${scheme}`);
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New manga' })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG[scheme]);
    // The status dot's tooltip carries a live detail from the server: check the prefix only.
    await expect(page.getByRole('img', { name: /^(Claude|Local \(ollama\)) (ready|unavailable|paused)/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scheme}-home.png`), fullPage: true });

    await page.goto(`/m/${mangaId}`);
    await expect(page.getByRole('button', { name: 'Edit cover' })).toBeVisible();
    await page.goto(`/m/${mangaId}/c/${chapterId}?p=${pageId}`);
    await expect(editPage(page).locator('[data-panel-id]')).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath(`${scheme}-editor.png`) });

    await page.goto('/settings');
    await expect(page.getByRole('button', { name: /^Switch to (light|dark) theme$/ })).toBeVisible();
    expect(errors.all()).toEqual([]);
  });
}

test('the theme toggle persists across a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New manga' })).toBeVisible();

  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG.light);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
  expect(errors.all()).toEqual([]);
});

test('the app still works when localStorage throws', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New manga' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors.all()).toEqual([]);
});
