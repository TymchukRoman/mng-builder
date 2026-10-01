import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

// W1 Q2 through the real server and UI (fakes): a 2-page autopilot run stops after the cover and page 1, even in
// autopilot; Continue renders page 2 in the same step and the chapter becomes ready.
test('preview first: the run stops at page 1, Continue renders the rest and the chapter is ready', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const manga = (await (await request.post('/api/mangas', { data: { title: `E2E Preview ${Date.now()}` } })).json()) as { id: string };
  const aiko = (await (await request.post(`/api/mangas/${manga.id}/characters`, { data: { name: 'Aiko', appearanceTags: '1girl, short black hair' } })).json()) as { id: string };
  const chapter = (await (await request.post(`/api/mangas/${manga.id}/chapters`, { data: { title: 'Preview' } })).json()) as { id: string };
  const started = await request.post(`/api/chapters/${chapter.id}/episode`, {
    data: { input: { prompt: 'Aiko finds a lost cat in the rain', pages: 2, characterIds: [aiko.id] }, mode: 'autopilot' },
  });
  expect(started.ok()).toBe(true);
  expect(((await started.json()) as { input: { previewFirst?: boolean } }).input.previewFirst).toBe(true); // the API default

  await page.goto(`/m/${manga.id}/c/${chapter.id}`);
  const status = page.getByTestId('episode-status');
  await expect(status).toHaveText(/^Page 1 is ready — continue with \d+ panels \(~\d+ (s|min|h)\)\?$/, { timeout: 120_000 });

  type Detail = { panels: Array<{ activeImageId: string | null }> };
  const storyPages = (await (await request.get(`/api/chapters/${chapter.id}/pages`)).json()) as Array<{ id: string }>;
  const detail = async (id: string): Promise<Detail> => (await (await request.get(`/api/pages/${id}`)).json()) as Detail;
  expect(storyPages).toHaveLength(2);
  expect((await detail(storyPages[0]!.id)).panels.every((p) => p.activeImageId !== null)).toBe(true);
  expect((await detail(storyPages[1]!.id)).panels.every((p) => p.activeImageId === null)).toBe(true);

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(status).toHaveText('Chapter ready', { timeout: 120_000 });
  expect((await detail(storyPages[1]!.id)).panels.every((p) => p.activeImageId !== null)).toBe(true);
  await expect(page.getByTestId('episode-step-error')).toHaveCount(0);
  expect(errors.all()).toEqual([]);
});
