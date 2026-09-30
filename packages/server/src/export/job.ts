// packages/server/src/export/job.ts
import { mkdir } from 'node:fs/promises';
import { ExportSchema, type ExportRenderPayload, type ExportRenderResult, type ImageUpscalePayload, type Job } from '@manga/shared';
import { pageDetail } from '../domain/pages.js';
import { PermanentError, isTerminal, waitForJob, type JobContext, type JobHandler } from '../jobs/index.js';
import { renderWithChromium, type PageRenderer } from './browser.js';
import { planUpscales, type UpscalePlan } from './hires.js';
import { planExport } from './paths.js';
import { mergePdfs } from './pdf.js';

export interface ExportJobDeps { baseUrl(): string; render?: PageRenderer; probeUi?(baseUrl: string, signal?: AbortSignal): Promise<void> }

/** The progress label of an export waiting for another one to finish (M4 final M5). */
export const WAITING_FOR_EXPORT = 'Waiting for another export';

/**
 * One export at a time (M4 final M5): the cpu lane runs two jobs so a render driver never blocks an export, and this
 * lock keeps two exports from rendering in Chromium side by side. Waiters are served in order; the lock is handed on.
 */
export class ExportLock {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  get busy(): boolean {
    return this.held;
  }

  /** Resolves with the release function once this caller holds the lock; rejects with the signal's reason if aborted first. */
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const release = (): void => {
      const next = this.waiting.shift();
      if (next) next();
      else this.held = false;
    };
    if (!this.held) {
      this.held = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiting.indexOf(wake);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(release);
      };
      this.waiting.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** How long the UI check waits for this server to answer. */
export const PROBE_TIMEOUT_MS = 10_000;

function errorDetail(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return `${err instanceof Error ? err.message : String(err)}${cause}`;
}

/**
 * The print route is a UI route: without packages/ui/dist the server answers JSON 404 and Chromium would wait 60 s for
 * nothing. M4 (review): bounded by `signal` (the job's; an abort rethrows its reason) and PROBE_TIMEOUT_MS, and a server
 * that cannot be reached is reported as such, not as a missing UI.
 */
export async function probeUi(baseUrl: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/render/page/probe`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new PermanentError(`The export server at ${baseUrl} did not answer the UI check within ${PROBE_TIMEOUT_MS / 1000} s`);
    throw new PermanentError(`Could not reach the export server at ${baseUrl} to check the UI: ${errorDetail(err)}`);
  }
  await res.body?.cancel().catch(() => undefined); // only the status and type matter
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('text/html')) {
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
  const lock = new ExportLock();
  return async (ctx): Promise<ExportRenderResult> => {
    const payload = ExportSchema.parse(ctx.job.payload) as ExportRenderPayload;
    planExport(ctx.store, payload); // a missing target fails at once, not after the wait
    if (lock.busy) ctx.progress(WAITING_FOR_EXPORT);
    const release = await lock.acquire(ctx.signal);
    try {
      return await exportNow(deps, ctx, payload);
    } finally {
      release();
    }
  };
}

async function exportNow(deps: ExportJobDeps, ctx: JobContext, payload: ExportRenderPayload): Promise<ExportRenderResult> {
  const plan = planExport(ctx.store, payload); // again: the chapter may have changed while this export waited
  const baseUrl = deps.baseUrl();
  // M5 (review): check the UI first, so a missing UI fails at once without spending GPU time on upscales.
  await (deps.probeUi ?? probeUi)(baseUrl, ctx.signal);
  await ensureHires(ctx, plan.items.map((i) => i.pageId));
  ctx.signal.throwIfAborted();
  // Task 12: only this export's own files are written into the plan's dir; nothing else there is cleared or deleted.
  // M3 (review), partial failure: page files are overwritten in place, each written whole by Chromium. An export
  // that fails at page k leaves this run's pages 1..k beside the previous export's later pages and chapter.pdf;
  // the failed job says so, and a re-run replaces them. chapter.pdf itself is replaced atomically (mergePdfs).
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
}
