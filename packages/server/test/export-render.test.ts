// packages/server/test/export-render.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { EMPTY_SCRIPT, type Chapter, type ExportRenderResult, type Job, type JobRef, type Manga, type PageDetail } from '@manga/shared';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

const UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const HAS_UI = existsSync(`${UI_DIR}/index.html`);
// The skip reason is part of the suite name, so it shows in the run output.
const SUITE = HAS_UI
  ? 'export with real Chromium'
  : 'export with real Chromium (SKIPPED: packages/ui/dist is missing; run `npm run build`)';

// The print size of the default page format at scale 1 (spec §9.2, G4): the PNG element screenshot is the PageView.
const PNG_WIDTH = 2150;
const PAGE_VIEW_HEIGHT = 3035;
const MM_TO_PT = 72 / 25.4;

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function job(server: M4TestServer, id: string): Promise<Job> {
  return server.until(async () => {
    const j = (await server.api<Job>('GET', `/api/jobs/${id}`)).body;
    return ['succeeded', 'failed', 'cancelled'].includes(j.status) ? j : null;
  }, 150_000);
}

// NOTE (F35): this test serves whatever is in packages/ui/dist. A stale dist still passes it but hides UI changes
// (for example the Task 17 `?hires=1` print route); rebuild with `npm run build` before trusting it.
describe.skipIf(!HAS_UI)(SUITE, { timeout: 180_000 }, () => {
  it('exports a page PNG at print size and a chapter PDF at 182×257 mm', async () => {
    s = await startM4TestServer({ uiDir: UI_DIR });
    const manga = (await s.api<Manga>('POST', '/api/mangas', { title: 'Export', language: 'uk' })).body;
    const chapter = (await s.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'Один' })).body;
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' })).body;
    const panel = page.panels[0]!;
    await s.api('PATCH', `/api/panels/${panel.id}`, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Привіт, світе!' }] } });
    const gen = (await s.api<JobRef>('POST', `/api/panels/${panel.id}/generate`, {})).body;
    expect((await job(s, gen.jobId)).status).toBe('succeeded');
    await s.api('POST', `/api/pages/${page.page.id}/auto-letter`);

    const png = await job(s, (await s.api<JobRef>('POST', '/api/export', { target: { type: 'page', id: page.page.id }, format: 'png' })).body.jobId);
    expect(png.status, png.error ?? '').toBe('succeeded');
    const [pngFile] = (png.result as ExportRenderResult).files;
    const bytes = readFileSync(pngFile!);
    // F6: an element screenshot of [data-testid="page-view"], so its height is the PageView's (3035 at scale 1).
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([PNG_WIDTH, PAGE_VIEW_HEIGHT]);

    const pdf = await job(s, (await s.api<JobRef>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'pdf' })).body.jobId);
    expect(pdf.status, pdf.error ?? '').toBe('succeeded');
    const files = (pdf.result as ExportRenderResult).files;
    expect(files.at(-1)!.endsWith('chapter.pdf')).toBe(true);
    const doc = await PDFDocument.load(readFileSync(files.at(-1)!));
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    // 182×257 mm in points; a small tolerance (±1 pt) for Chromium's rounding of the paper size.
    expect(Math.abs(width - 182 * MM_TO_PT)).toBeLessThan(1);
    expect(Math.abs(height - 257 * MM_TO_PT)).toBeLessThan(1);

    const images = (await s.api<Array<{ source: string }>>('GET', `/api/panels/${panel.id}/images`)).body;
    expect(images.some((i) => i.source === 'upscaled')).toBe(true);
  });
});
