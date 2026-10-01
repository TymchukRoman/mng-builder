import { existsSync, readFileSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { collectErrors, editPage } from './helpers';

test('a chapter generated in autopilot from the create modal exports as one PDF', async ({ page, request }) => {
  test.setTimeout(300_000);
  // Nothing here is expected to fail: any failed load or console error fails the test.
  const errors = collectErrors(page);
  const manga = (await (await request.post('/api/mangas', { data: { title: `E2E Episode ${Date.now()}` } })).json()) as { id: string };
  await request.post(`/api/mangas/${manga.id}/characters`, { data: { name: 'Aiko', appearanceTags: '1girl, short black hair' } });

  // Create the chapter with the AI section in autopilot
  await page.goto(`/m/${manga.id}`);
  await page.getByRole('button', { name: 'New chapter' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Rain');
  await page.getByRole('button', { name: 'Generate with AI' }).click();
  await page.getByLabel('Episode prompt').fill('Aiko finds a lost cat in the rain');
  await page.getByLabel('Pages', { exact: true }).fill('2');
  await page.getByRole('group', { name: 'Characters' }).getByRole('button', { name: 'Aiko' }).click();
  const autopilot = page.getByRole('button', { name: 'Autopilot', exact: true });
  await expect(autopilot).toHaveAttribute('aria-pressed', 'false');
  await autopilot.click();
  await expect(autopilot).toHaveAttribute('aria-pressed', 'true');
  // W1 Q2: the section previews page 1 first by default; this run goes straight through.
  const preview = page.getByRole('button', { name: 'Preview page 1 first', exact: true });
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('ai-estimate')).toHaveText(/^2 pages ≈ 9 panels ≈ /);
  await page.getByRole('button', { name: 'Create chapter' }).click();
  await expect(page).toHaveURL(/\/c\/ch_[a-z2-7]+/);

  // The stepper follows the run to the end; the page list fills in
  await expect(page.getByTestId('episode-panel')).toBeVisible();
  await expect(page.getByTestId('episode-status')).toHaveText('Chapter ready', { timeout: 200_000 });
  await expect(page.getByTestId('episode-step-error')).toHaveCount(0);
  await expect(page.getByLabel('Page 2', { exact: true })).toBeVisible();
  // The typed title is kept; the premise does not replace it (M4 final M6)
  const chapterId = /\/c\/(ch_[a-z2-7]+)/.exec(page.url())?.[1] ?? '';
  expect(((await (await request.get(`/api/chapters/${chapterId}`)).json()) as { title: string }).title).toBe('Rain');

  // Auto-letter: the episode already lettered page 1; delete a bubble, and the toolbar action brings it back
  await page.getByLabel('Page 1', { exact: true }).click();
  const canvas = editPage(page);
  await expect(canvas).toBeVisible();
  const frames = canvas.locator('[data-frame-id]');
  const pageId = (await canvas.getAttribute('data-page-id')) ?? '';
  expect(pageId).toMatch(/^pg_/);
  const serverFrames = async (): Promise<number> =>
    ((await (await request.get(`/api/pages/${pageId}`)).json()) as { frames: unknown[] }).frames.length;
  await expect(frames.first()).toBeVisible();
  const lettered = await frames.count();
  expect(lettered).toBeGreaterThan(0);
  expect(await serverFrames()).toBe(lettered);
  await frames.first().locator('.frame__hit').click();
  await page.keyboard.press('Delete');
  await expect(frames).toHaveCount(lettered - 1);
  await expect.poll(serverFrames).toBe(lettered - 1);
  await page.getByRole('button', { name: 'Auto-letter page (cannot be undone)' }).click();
  await expect(frames).toHaveCount(lettered);
  await expect.poll(serverFrames).toBe(lettered);

  // Export the whole chapter as PDF from the toolbar
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('radio', { name: 'PDF' }).click();
  await page.getByRole('radio', { name: 'Whole chapter' }).click();
  await page.getByRole('button', { name: 'Start export' }).click();
  const files = page.getByTestId('export-file');
  await expect(files.last()).toBeVisible({ timeout: 120_000 });
  const paths = await files.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['path'] ?? ''));
  const chapterPdf = paths.find((p) => p.endsWith('chapter.pdf'));
  expect(chapterPdf, paths.join('\n')).toBeDefined();
  expect(existsSync(chapterPdf!)).toBe(true);
  expect(statSync(chapterPdf!).size).toBeGreaterThan(1_000);
  expect(readFileSync(chapterPdf!).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pagePdfs = paths.filter((p) => /page-\d\d\.pdf$/.test(p));
  expect(pagePdfs).toHaveLength(2);
  for (const p of pagePdfs) expect(statSync(p).size).toBeGreaterThan(1_000);

  expect(errors.all()).toEqual([]);
});
