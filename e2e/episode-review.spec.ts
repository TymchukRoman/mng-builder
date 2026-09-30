import { expect, test } from '@playwright/test';
import { collectErrors, editPage, panelIds } from './helpers';

// M4 final M9: the review-mode journey through the real server and UI (fakes): Continue at the outline, edit and save
// a scripts line, then a confirmed scripts re-run, which is an editor History barrier and replaces the pages.
test('review mode: continue, edit a script line, re-run scripts; undo is cleared and the editor lands on a new page', async ({ page, request }) => {
  test.setTimeout(180_000);
  // The first re-run request answers 409 needs_confirm on purpose (the UI then asks); nothing else may fail.
  const errors = collectErrors(page, { allowedFailures: { status: 409, urlSuffix: '/steps/scripts/rerun' } });
  const manga = (await (await request.post('/api/mangas', { data: { title: `E2E Review ${Date.now()}` } })).json()) as { id: string };
  const aiko = (await (await request.post(`/api/mangas/${manga.id}/characters`, { data: { name: 'Aiko', appearanceTags: '1girl' } })).json()) as { id: string };
  const chapter = (await (await request.post(`/api/mangas/${manga.id}/chapters`, { data: { title: 'Review' } })).json()) as { id: string };
  const started = await request.post(`/api/chapters/${chapter.id}/episode`, {
    data: { input: { prompt: 'Aiko finds a lost cat in the rain', pages: 1, characterIds: [aiko.id] }, mode: 'review' },
  });
  expect(started.ok()).toBe(true);
  const storyPageIds = async (): Promise<string[]> =>
    ((await (await request.get(`/api/chapters/${chapter.id}/pages`)).json()) as Array<{ id: string }>).map((p) => p.id);

  await page.goto(`/m/${manga.id}/c/${chapter.id}`);
  const status = page.getByTestId('episode-status');

  // 1–2. The run stops at the outline; Continue moves it on to the scripts review
  await expect(status).toHaveText('Review: outline', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(status).toHaveText('Review: scripts', { timeout: 60_000 });

  // 3. Edit one script line and save it
  const action = page.getByLabel('pages[1].panels[1].action', { exact: true });
  await action.fill('Aiko opens her umbrella over the cat');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => {
    const run = (await (await request.get(`/api/chapters/${chapter.id}/episode`)).json()) as { steps: Array<{ output: unknown }> };
    return (run.steps[3]?.output as { pages: Array<{ panels: Array<{ action: string }> }> }).pages[0]?.panels[0]?.action;
  }).toBe('Aiko opens her umbrella over the cat');

  // An undoable editor change on the page the re-run will replace
  const oldPages = await storyPageIds();
  expect(oldPages).toHaveLength(1);
  await page.getByLabel('Page 1', { exact: true }).click();
  const canvas = editPage(page);
  await expect(canvas).toHaveAttribute('data-page-id', oldPages[0]!);
  const [first] = await panelIds(page);
  await canvas.locator(`[data-panel-id="${first}"]`).click();
  await page.getByRole('button', { name: 'Split into left and right' }).click();
  const undo = page.getByRole('button', { name: /^Undo/ });
  await expect(undo).toBeEnabled();

  // 4. Re-run the scripts: the UI asks first, then replaces the pages
  await page.getByRole('tab', { name: /^Scripts:/ }).click();
  await page.getByRole('button', { name: 'Re-run from here (later steps run again)' }).click();
  const confirm = page.getByRole('dialog', { name: 'Re-run scripts?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Re-run and replace the pages' }).click();
  await expect(confirm).toBeHidden();
  // The scripts step ran again: a new page replaced the old one, and the run waits at the scripts review again
  await expect.poll(storyPageIds, { timeout: 60_000 }).not.toEqual(oldPages);
  const newPages = await storyPageIds();
  expect(newPages).toHaveLength(1);
  await expect(status).toHaveText('Review: scripts', { timeout: 60_000 });

  // 5. Undo is cleared (its commands named the deleted page), and the editor shows the new page
  await expect(undo).toBeDisabled();
  await expect(canvas).toHaveAttribute('data-page-id', newPages[0]!);
  await expect(page).not.toHaveURL(new RegExp(`p=${oldPages[0]}`));
  expect(errors.all()).toEqual([]);
});
