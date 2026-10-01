import { expect, test } from '@playwright/test';
import { collectErrors, seedManga } from './helpers';

test('the jobs popover pauses and resumes the GPU queue, and the top bar chip follows (W1 R2)', async ({ page, request }) => {
  const errors = collectErrors(page);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /^(Jobs|\d+ jobs running or queued)$/ }).click();
    await page.getByRole('button', { name: 'Pause GPU queue (images and local AI)' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'GPU queue paused' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume GPU queue' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume GPU queue' }).click();
    await expect(page.getByRole('button', { name: 'Pause GPU queue (images and local AI)' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'GPU queue paused' })).toHaveCount(0);
    expect(errors.all()).toEqual([]);
  } finally {
    // Task 9 minor 3: the specs share one server; a failure above must not leave its GPU lane paused for the others.
    const lanes = (await (await request.post('/api/queue/gpu/resume')).json()) as { pausedLanes: unknown[] };
    expect(lanes.pausedLanes).toEqual([]);
  }
});

test('a chapter summary is edited from the chapter row, and the confirm setting saves (W1 Q1, C2)', async ({ page, request }) => {
  const errors = collectErrors(page);
  const { mangaId, chapterId } = await seedManga(request, 'E2E summary');
  await page.goto(`/m/${mangaId}`);
  await page.getByRole('button', { name: 'Add chapter summary' }).click();
  await page.getByRole('textbox', { name: 'Chapter summary' }).fill('  Kai finds the key.  ');
  await page.getByRole('button', { name: 'Save summary' }).click();
  await expect(page.getByRole('button', { name: 'Edit chapter summary' })).toBeVisible();
  await expect.poll(async () => ((await (await request.get(`/api/chapters/${chapterId}`)).json()) as { summary: string }).summary).toBe('Kai finds the key.');

  await page.goto('/settings');
  const field = page.getByRole('spinbutton', { name: 'Confirm renders over (min)' });
  await field.fill('90');
  await field.blur();
  await expect.poll(async () => ((await (await request.get('/api/settings')).json()) as { episode: { confirmRenderMinutes: number } }).episode.confirmRenderMinutes).toBe(90);
  expect(errors.all()).toEqual([]);
});
