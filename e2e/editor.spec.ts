import { expect, test, type APIRequestContext } from '@playwright/test';
import { collectErrors, editPage, layoutOf, panelIds, seedManga } from './helpers';

/** The texts of a page's frames as the server holds them. */
async function frameTexts(request: APIRequestContext, pageId: string): Promise<string[]> {
  const res = await request.get(`/api/pages/${pageId}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { frames: Array<{ text: string }> }).frames.map((f) => f.text);
}

test('create, lay out, letter and generate a page; everything survives a reload', async ({ page, request }) => {
  // The preset step answers 409 needs_confirm on purpose; Chrome logs that one as a resource error. Any other failed load fails the test.
  const errors = collectErrors(page, { allowedFailures: { status: 409, urlSuffix: '/layout/preset' } });
  const canvas = editPage(page);
  const panels = canvas.locator('[data-panel-id]');
  const frame = canvas.locator('[data-frame-id]');

  // Manga → chapter → editor
  await page.goto('/');
  await page.getByRole('button', { name: 'New manga' }).click();
  await page.getByLabel('Title', { exact: true }).fill('E2E Manga');
  await page.getByRole('button', { name: 'Create manga' }).click();
  await expect(page).toHaveURL(/\/m\/mg_[a-z2-7]+$/);
  await page.getByRole('button', { name: 'New chapter' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Chapter one');
  await page.getByRole('button', { name: 'Create chapter' }).click();
  await expect(page).toHaveURL(/\/c\/ch_[a-z2-7]+/);

  // Add a page (server default preset 2x2)
  await page.getByRole('button', { name: 'Add page' }).click();
  await expect(panels).toHaveCount(4);
  const pageId = (await canvas.getAttribute('data-page-id')) ?? '';
  expect(pageId).toMatch(/^pg_/);

  // A preset with fewer panels asks first; "Keep the current layout" leaves the page untouched
  const layoutBefore2x2 = await layoutOf(request, pageId);
  await page.getByRole('button', { name: 'Layout presets' }).click();
  await page.getByRole('button', { name: /^3-rows,/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace layout?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep the current layout' }).click();
  await expect(dialog).toBeHidden();
  await expect(panels).toHaveCount(4);
  expect(await layoutOf(request, pageId)).toBe(layoutBefore2x2);

  // The same preset, confirmed this time
  await page.getByRole('button', { name: 'Layout presets' }).click();
  await page.getByRole('button', { name: /^3-rows,/ }).click();
  await dialog.getByRole('button', { name: 'Apply layout' }).click();
  await expect(panels).toHaveCount(3);
  await expect(dialog).toBeHidden();

  // Split, undo, redo (Ctrl+Z / Ctrl+Y)
  const before = await panelIds(page);
  await canvas.locator(`[data-panel-id="${before[0]}"]`).click();
  await page.getByRole('button', { name: 'Split into left and right' }).click();
  await expect(panels).toHaveCount(4);
  await page.keyboard.press('Control+z');
  await expect(panels).toHaveCount(3);
  await page.keyboard.press('Control+y');
  await expect(panels).toHaveCount(4);
  const created = (await panelIds(page)).find((id) => !before.includes(id)) ?? '';
  expect(created).toMatch(/^pn_/);

  // Merge the new panel back into its sibling (shift-click selects the partner)
  await canvas.locator(`[data-panel-id="${created}"]`).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Merge panels (cannot be undone)' }).click();
  await expect(panels).toHaveCount(3);

  // Resize by dragging the root gutter along its axis, then undo and redo it from the keyboard
  const layoutBefore = await layoutOf(request, pageId);
  const gutter = canvas.locator('[data-gutter="root"]');
  const horizontal = ((await gutter.getAttribute('class')) ?? '').includes('gutter--h');
  const g = await gutter.boundingBox();
  if (!g) throw new Error('root gutter not rendered');
  const resized = page.waitForResponse((r) => r.url().endsWith('/layout/resize') && r.request().method() === 'POST');
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + (horizontal ? 0 : 60), g.y + g.height / 2 + (horizontal ? 60 : 0), { steps: 8 });
  await page.mouse.up();
  expect((await resized).ok()).toBe(true);
  const layoutAfter = await layoutOf(request, pageId);
  expect(layoutAfter).not.toBe(layoutBefore);
  await page.keyboard.press('Control+z');
  await expect.poll(() => layoutOf(request, pageId)).toBe(layoutBefore);
  await page.keyboard.press('Control+y');
  await expect.poll(() => layoutOf(request, pageId)).toBe(layoutAfter);

  // Speech bubble with Ukrainian text
  const target = (await panelIds(page))[0] ?? '';
  await canvas.locator(`[data-panel-id="${target}"]`).click();
  await page.getByRole('button', { name: 'Add speech bubble' }).click();
  await expect(frame).toHaveCount(1);
  const text = page.getByLabel('Text', { exact: true });
  await text.fill('Привіт, їжаку!!');
  // Editor keys never fire while typing: Backspace edits the text, and neither it nor Delete removes the frame.
  await text.press('Backspace');
  await text.press('End');
  await text.press('Delete');
  await expect(frame).toHaveCount(1);
  await expect(text).toHaveValue('Привіт, їжаку!');
  await expect.poll(() => frameTexts(request, pageId)).toEqual(['Привіт, їжаку!']);
  await expect(frame).toContainText('Привіт, їжаку!');

  // A frame edit is one undoable command. The canvas click also takes the focus away from the text box.
  await page.locator('.canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(frame).not.toContainText('Привіт');
  await expect.poll(() => frameTexts(request, pageId)).toEqual(['']);
  await page.keyboard.press('Control+y');
  await expect(frame).toContainText('Привіт, їжаку!');
  await expect.poll(() => frameTexts(request, pageId)).toEqual(['Привіт, їжаку!']);

  // With the canvas focused, Delete does remove the selected frame; Ctrl+Z brings it back
  await frame.locator('.frame__hit').click();
  await page.keyboard.press('Delete');
  await expect(frame).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(frame).toHaveCount(1);
  await expect(frame).toContainText('Привіт, їжаку!');

  // Generate two variants for the panel (fake ComfyUI), then pick the one that is not active
  await canvas.locator(`[data-panel-id="${target}"]`).click({ position: { x: 10, y: 10 } });
  const variants = page.locator('[data-variant-id]');
  const generateVariant = page.getByRole('button', { name: 'Generate a new variant' });
  await generateVariant.click();
  await expect(variants).toHaveCount(1, { timeout: 60_000 });
  await generateVariant.click();
  await expect(variants).toHaveCount(2, { timeout: 60_000 });
  const inactive = page.locator('[data-variant-id][aria-pressed="false"]').first();
  const pickedId = (await inactive.getAttribute('data-variant-id')) ?? '';
  await inactive.click();
  await expect(page.locator(`[data-variant-id="${pickedId}"]`)).toHaveAttribute('aria-pressed', 'true');
  const panelImg = canvas.locator(`[data-panel-id="${target}"] img`);
  await expect(panelImg).toHaveAttribute('src', `/files/images/${pickedId}.png`);
  // The manga is B&W: the stored PNG is untouched and the display is grey.
  await expect(panelImg).toHaveCSS('filter', 'grayscale(1)');

  // Reload: layout, text and picked variant are all persisted
  await page.reload();
  await expect(panels).toHaveCount(3);
  await expect(frame).toContainText('Привіт, їжаку!');
  await expect(panelImg).toHaveAttribute('src', `/files/images/${pickedId}.png`);
  expect(await layoutOf(request, pageId)).toBe(layoutAfter);

  // Print route renders the page at exact print size and signals readiness
  await page.goto(`/render/page/${pageId}`);
  await page.waitForFunction(() => (window as unknown as { __MANGA_RENDER_READY__?: boolean }).__MANGA_RENDER_READY__ === true, null, { timeout: 30_000 });
  const size = await page.getByTestId('page-view').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(size).toEqual({ w: 2150, h: 3035 });
  await expect(page.locator(`[data-panel-id="${target}"] img`)).toHaveCSS('filter', 'grayscale(1)');

  expect(errors.all()).toEqual([]);
});

test('the cover editors create their page with exactly one POST each', async ({ page, request }) => {
  const errors = collectErrors(page);
  const { mangaId, chapterId } = await seedManga(request, 'E2E Cover');
  const posts: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.endsWith('/cover')) posts.push(path);
  });

  await page.goto(`/m/${mangaId}`);
  await page.getByRole('button', { name: 'Edit cover' }).click();
  await expect(page).toHaveURL(new RegExp(`/m/${mangaId}/cover$`));
  await expect(editPage(page)).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Editor tools' })).toContainText('Cover');
  await page.waitForLoadState('networkidle'); // a late second POST would land here
  expect(posts).toEqual([`/api/mangas/${mangaId}/cover`]);

  await page.goto(`/m/${mangaId}`);
  await page.getByRole('button', { name: 'Edit chapter cover' }).click();
  await expect(page).toHaveURL(new RegExp(`/m/${mangaId}/c/${chapterId}/cover$`));
  await expect(editPage(page)).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(posts).toEqual([`/api/mangas/${mangaId}/cover`, `/api/chapters/${chapterId}/cover`]);

  // A cover keeps its one panel: the layout tools are not offered
  await expect(page.getByRole('button', { name: 'Layout presets' })).toHaveCount(0);
  expect(errors.all()).toEqual([]);
});
