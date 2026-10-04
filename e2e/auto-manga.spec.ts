import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

// "From a prompt" through the real server and UI (fakes): the New manga dialog takes one brief, the manga page shows the run,
// and when it has finished the manga has its poster, its chapter (with its own model) and its images in the gallery.
test('a manga from one prompt: dialog, progress, poster, chapters and the gallery', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New manga' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'From a prompt' }).click();
  await dialog.getByLabel('Plot and notes').fill('Two friends on a harbour pier. Simplistic art style, short dialogue.');
  await dialog.getByLabel('Chapters', { exact: true }).fill('2');
  await dialog.getByLabel('Pages per chapter').fill('1');
  await dialog.getByLabel('Image model', { exact: true }).selectOption('flux2');
  await dialog.locator('summary', { hasText: 'Image model per chapter' }).click();
  await dialog.getByLabel('Image model of chapter 2').selectOption('anima');
  await expect(dialog.getByTestId('auto-estimate')).toHaveText(/^2 chapters × 1 page ≈ \d+ panels ≈ /);
  await page.screenshot({ path: '/tmp/claude-0/shots/auto-dialog.png' });
  await dialog.getByRole('button', { name: 'Create manga from the prompt' }).click();

  await expect(page).toHaveURL(/\/m\/mg_/);
  const mangaId = new URL(page.url()).pathname.split('/')[2]!;
  await expect(page.getByTestId('auto-run')).toBeVisible();
  await page.screenshot({ path: '/tmp/claude-0/shots/auto-running.png' });
  // A clean finish hides the panel; the manga is named by the plan and has its two chapters.
  await expect(page.getByTestId('auto-run')).toHaveCount(0, { timeout: 150_000 });
  await expect(page.getByRole('heading', { name: 'Harbour Tales' })).toBeVisible();
  await expect(page.locator('.chapter-row[data-chapter-id]')).toHaveCount(2);
  await page.screenshot({ path: '/tmp/claude-0/shots/auto-done.png' });

  const manga = (await (await request.get(`/api/mangas/${mangaId}`)).json()) as { imageModel: string; coverPageId: string | null };
  expect(manga.imageModel).toBe('flux2');
  expect(manga.coverPageId).not.toBeNull();
  const chapters = (await (await request.get(`/api/mangas/${mangaId}/chapters`)).json()) as Array<{ imageModel: string | null; status: string }>;
  expect(chapters.map((c) => [c.imageModel, c.status])).toEqual([[null, 'ready'], ['anima', 'ready']]);

  // The gallery lists what was drawn: portraits, the poster and the chapters' pictures.
  await page.getByRole('button', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/gallery$/);
  await expect(page.locator('img[loading="lazy"]').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/claude-0/shots/gallery.png' });
  expect(errors.all()).toEqual([]);
});
