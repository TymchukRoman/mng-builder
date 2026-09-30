// packages/server/test/export-job.test.ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_PAGE_FORMAT, type ApiErrorBody, type Chapter, type ExportRenderResult, type Job, type JobRef, type Manga, type PageDetail } from '@manga/shared';
import { encodeSolidPng } from '../src/dev/png.js';
import { createCoverPage, createPage } from '../src/domain/pages.js';
import { pdfScale, type PageRenderer } from '../src/export/browser.js';
import { exportJobHandler, probeUi } from '../src/export/job.js';
import { mergePdfs } from '../src/export/pdf.js';
import { EventBus } from '../src/events/bus.js';
import { TWO_PANEL_PRESET, seedEpisodeWorld } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';
import { seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let server: M4TestServer | null = null;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(async () => {
  lib.close();
  await server?.close();
  server = null;
});

async function onePagePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([515.9, 728.5]);
  await writeFile(path, await doc.save());
}

/** Writes a real (tiny) file per item, like Chromium would. */
function stubRenderer(rendered: string[]): PageRenderer {
  return async (req) => {
    for (const item of req.items) {
      if (req.format === 'pdf') await onePagePdf(item.file);
      else await writeFile(item.file, encodeSolidPng(8, 8, [0, 0, 0]));
      rendered.push(item.pageId);
      req.onPage?.(rendered.length, req.items.length);
    }
    return req.items.map((i) => i.file);
  };
}

function exportContext(payload: unknown, queue = new FakeQueue(lib.store), progress: string[] = [], signal?: AbortSignal) {
  const job = lib.store.jobs.insert({ kind: 'export.render', lane: 'cpu', payload, priority: 0, maxAttempts: 1, nextRunAt: new Date().toISOString(), episodeRunId: null });
  return fakeJobContext(lib.store, new EventBus(), queue, job, signal, progress);
}

const noProbe = async (): Promise<void> => undefined;

/** A splash page whose one panel shows a 512 px image: it needs a 4x upscale for print. */
function lowResPage() {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  const page = createPage(lib.store, chapter.id, 'splash');
  const panel = page.panels[0]!;
  const small = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null, [512, 512]);
  lib.store.panels.update(panel.id, { activeImageId: small.id });
  return { manga, page, panel, small };
}

describe('pdf helpers', () => {
  it('merges page PDFs in order', async () => {
    const a = join(lib.dir, 'a.pdf');
    const b = join(lib.dir, 'b.pdf');
    await onePagePdf(a);
    await onePagePdf(b);
    const out = await mergePdfs([a, b], join(lib.dir, 'all.pdf'));
    expect((await PDFDocument.load(await readFile(out))).getPageCount()).toBe(2);
  });

  it('scales the print-pixel layout onto the paper width', () => {
    expect(pdfScale(DEFAULT_PAGE_FORMAT)).toBeCloseTo(687.87 / 2150, 4);
  });
});

describe('exportJobHandler', () => {
  it('exports a chapter as page PDFs plus a merged chapter.pdf, cover first', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { mangaTitle: 'Rain Town', chapterTitle: 'One' });
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const cover = createCoverPage(lib.store, manga.id, chapter.id);
    const rendered: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer(rendered), probeUi: noProbe });
    const result = (await handler(exportContext({ target: { type: 'chapter', id: chapter.id }, format: 'pdf' }))) as ExportRenderResult;
    const dir = join(lib.dir, 'exports', 'rain-town', '01-one');
    expect(result.files).toEqual(['cover.pdf', 'page-01.pdf', 'page-02.pdf', 'chapter.pdf'].map((f) => join(dir, f)));
    expect(rendered[0]).toBe(cover.page.id);
    expect((await PDFDocument.load(await readFile(join(dir, 'chapter.pdf')))).getPageCount()).toBe(3);
  });

  it('exports one page as PNG into outDir', async () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const page = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const out = join(lib.dir, 'custom-out');
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer([]), probeUi: noProbe });
    const result = (await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png', outDir: out }))) as ExportRenderResult;
    expect(result.files).toEqual([join(out, 'page-01.png')]);
    expect(existsSync(result.files[0]!)).toBe(true);
  });

  it('writes only its own files into outDir and leaves everything else there alone', async () => {
    const { chapter } = seedEpisodeWorld(lib.store);
    const page = createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const out = join(lib.dir, 'shared-out');
    await mkdir(join(out, 'keep'), { recursive: true });
    await writeFile(join(out, 'notes.txt'), 'mine');
    await writeFile(join(out, 'keep', 'old.png'), 'old');
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer([]), probeUi: noProbe });
    await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png', outDir: out }));
    expect(await readFile(join(out, 'notes.txt'), 'utf8')).toBe('mine');
    expect(await readFile(join(out, 'keep', 'old.png'), 'utf8')).toBe('old');
    expect(existsSync(join(out, 'page-01.png'))).toBe(true);
  });

  it('upscales low-resolution images before rendering', async () => {
    const { manga, page, panel, small } = lowResPage();
    const queue = new FakeQueue(lib.store).on('image.upscale', (job) => {
      const p = job.payload as { imageId: string; factor: number };
      const up = lib.store.images.create({
        mangaId: manga.id, ownerType: 'panel', ownerId: panel.id, role: null, path: 'mangas/x/images/up.png',
        width: 512 * p.factor, height: 512 * p.factor, source: 'upscaled', parentImageId: p.imageId, gen: null, review: null,
      });
      return { imageId: up.id };
    });
    const progress: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer([]), probeUi: noProbe });
    await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png' }, queue, progress));
    expect(queue.jobs('image.upscale').map((j) => [j.lane, j.payload])).toEqual([['gpu', { imageId: small.id, factor: 4 }]]);
    expect(progress[0]).toBe('Upscaling 1 images for print');
  });

  it('a failed upscale only downgrades that image: the export still renders', async () => {
    const { page } = lowResPage();
    const queue = new FakeQueue(lib.store).on('image.upscale', () => { throw new Error('comfy is down'); });
    const progress: string[] = [];
    const rendered: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer(rendered), probeUi: noProbe });
    const result = (await handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png' }, queue, progress))) as ExportRenderResult;
    expect(rendered).toEqual([page.page.id]);
    expect(result.files).toHaveLength(1);
    expect(progress).toContain('1 upscales failed; those images export at their base resolution');
  });

  it('F10: an aborted export stops waiting at once and cancels its child upscale jobs', async () => {
    const { page } = lowResPage();
    const queue = new FakeQueue(lib.store); // no image.upscale handler: the child stays queued, as behind other GPU work
    const controller = new AbortController();
    const rendered: string[] = [];
    const handler = exportJobHandler({ baseUrl: () => 'http://127.0.0.1:1', render: stubRenderer(rendered), probeUi: noProbe });
    const running = handler(exportContext({ target: { type: 'page', id: page.page.id }, format: 'png' }, queue, [], controller.signal));
    for (let i = 0; i < 100 && queue.jobs('image.upscale').length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const [child] = queue.jobs('image.upscale');
    expect(child?.status).toBe('queued');
    controller.abort(new Error('cancelled'));
    await expect(running).rejects.toThrow('cancelled');
    expect(lib.store.jobs.require(child!.id).status).toBe('cancelled');
    expect(rendered).toEqual([]);
  });

  it('refuses to export when the UI is not built', async () => {
    server = await startM4TestServer({ uiDir: null });
    await expect(probeUi(server.url)).rejects.toThrow('The UI is not built (packages/ui/dist is missing): run "npm run build" before exporting');
  });
});

describe('export routes', { timeout: 60_000 }, () => {
  it('POST /api/export validates, queues an export.render job on the cpu lane, and the job reports a missing UI', async () => {
    server = await startM4TestServer({ uiDir: null });
    const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Export' })).body;
    const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
    await server.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: TWO_PANEL_PRESET });
    expect((await server.api<ApiErrorBody>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id }, format: 'tiff' })).status).toBe(400);
    expect((await server.api<ApiErrorBody>('POST', '/api/export', { target: { type: 'chapter', id: 'ch_missing000' } })).status).toBe(404);
    const { body } = await server.api<JobRef>('POST', '/api/export', { target: { type: 'chapter', id: chapter.id } });
    const job = await server.until(async () => {
      const j = (await server!.api<Job>('GET', `/api/jobs/${body.jobId}`)).body;
      return j.status === 'failed' || j.status === 'succeeded' ? j : null;
    });
    expect(job).toMatchObject({ kind: 'export.render', lane: 'cpu', status: 'failed' });
    expect(job.error).toContain('The UI is not built');
  });

  it('GET /api/pages/:id/print serves the print view', async () => {
    server = await startM4TestServer({ uiDir: null });
    const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Print' })).body;
    const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
    const page = (await server.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: 'splash' })).body;
    const store = server.deps.store;
    const panel = page.panels[0]!;
    const base = seedImage(store, manga.id, { type: 'panel', id: panel.id }, null, [512, 512]);
    store.panels.update(panel.id, { activeImageId: base.id });
    const up = store.images.create({
      mangaId: manga.id, ownerType: 'panel', ownerId: panel.id, role: null, path: base.path, width: 2048, height: 2048,
      source: 'upscaled', parentImageId: base.id, gen: null, review: null,
    });
    const print = (await server.api<PageDetail>('GET', `/api/pages/${page.page.id}/print`)).body;
    expect(print.panels[0]!.activeImageId).toBe(up.id);
    expect((await server.api<PageDetail>('GET', `/api/pages/${page.page.id}`)).body.panels[0]!.activeImageId).toBe(base.id);
  });
});
