// packages/server/src/export/job.ts
import { mkdir } from 'node:fs/promises';
import { ExportSchema, type ExportRenderPayload, type ExportRenderResult, type ImageUpscalePayload, type Job } from '@manga/shared';
import { pageDetail } from '../domain/pages.js';
import { PermanentError, isTerminal, waitForJob, type JobContext, type JobHandler } from '../jobs/index.js';
import { renderWithChromium, type PageRenderer } from './browser.js';
import { planUpscales, type UpscalePlan } from './hires.js';
import { planExport } from './paths.js';
import { mergePdfs } from './pdf.js';

export interface ExportJobDeps { baseUrl(): string; render?: PageRenderer; probeUi?(baseUrl: string): Promise<void> }

/** The print route is a UI route: without packages/ui/dist the server answers JSON 404 and Chromium would wait 60 s for nothing. */
export async function probeUi(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/render/page/probe`).catch(() => null);
  const type = res?.headers.get('content-type') ?? '';
  if (!res?.ok || !type.includes('text/html')) {
    throw new PermanentError('The UI is not built (packages/ui/dist is missing): run "npm run build" before exporting');
  }
}

/** Spec §9.2: every image printed under the format's dpi gets one upscale first (once per image). A failed upscale only downgrades that image. */
async function ensureHires(ctx: JobContext, pageIds: string[]): Promise<void> {
  const seen = new Set<string>();
  const plans: UpscalePlan[] = [];
  for (const id of pageIds) {
    const detail = pageDetail(ctx.store, id);
    const format = ctx.store.mangas.require(detail.page.mangaId).pageFormat;
    for (const plan of planUpscales(ctx.store, detail, format)) {
      if (!seen.has(plan.imageId)) { seen.add(plan.imageId); plans.push(plan); }
    }
  }
  if (plans.length === 0) return;
  const label = `Upscaling ${plans.length} images for print`;
  ctx.progress(label, 0, plans.length);
  const children: Job[] = plans.map((p) => {
    const payload: ImageUpscalePayload = { imageId: p.imageId, factor: p.factor };
    return ctx.queue.enqueue({ kind: 'image.upscale', lane: 'gpu', payload });
  });
  let done = 0;
  let failed = 0;
  try {
    // F10: a signal-aware wait, so a cancelled export (or a stopping server) stops waiting at once.
    await Promise.all(children.map(async (child) => {
      const job = await waitForJob(ctx.queue, child.id, ctx.signal);
      if (job.status !== 'succeeded') failed++;
      ctx.progress(label, ++done, plans.length);
    }));
  } catch (err) {
    // F10: the export is gone, so nothing needs its upscales any more.
    if (ctx.signal.aborted) {
      for (const child of children) {
        if (!isTerminal(ctx.store.jobs.require(child.id).status)) ctx.queue.cancel(child.id);
      }
    }
    throw err;
  }
  if (failed > 0) ctx.progress(`${failed} upscales failed; those images export at their base resolution`);
}

export function exportJobHandler(deps: ExportJobDeps): JobHandler {
  return async (ctx): Promise<ExportRenderResult> => {
    const payload = ExportSchema.parse(ctx.job.payload) as ExportRenderPayload;
    const plan = planExport(ctx.store, payload);
    await ensureHires(ctx, plan.items.map((i) => i.pageId));
    const baseUrl = deps.baseUrl();
    await (deps.probeUi ?? probeUi)(baseUrl);
    ctx.signal.throwIfAborted();
    // Task 12: only this export's own files are written into the plan's dir; nothing else there is cleared or deleted.
    await mkdir(plan.dir, { recursive: true });
    const files = await (deps.render ?? renderWithChromium)({
      baseUrl, items: plan.items, format: plan.format, pageFormat: plan.pageFormat, signal: ctx.signal,
      onPage: (i, n) => ctx.progress(`Rendering page ${Math.min(i + 1, n)}/${n}`, i, n),
    });
    if (plan.chapterPdf) {
      ctx.progress('Merging the chapter PDF');
      files.push(await mergePdfs(files, plan.chapterPdf));
    }
    return { files };
  };
}
