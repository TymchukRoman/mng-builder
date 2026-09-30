import type { ImageGeneratePayload, ImageReviewPayload, Job, JobKind, ReviewResult } from '@manga/shared';
import type { EventBus } from '../../src/events/bus.js';
import { GpuArbiter, type EnqueueInput, type JobContext, type JobQueue } from '../../src/jobs/index.js';
import type { Store } from '../../src/store/index.js';
import { seedImage } from './seed.js';

export type FakeHandler = (job: Job, signal: AbortSignal) => unknown;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** In-memory JobQueue stand-in: jobs are real rows (store.jobs.list works); handlers run on the microtask queue. */
export class FakeQueue {
  private readonly handlers = new Map<JobKind, FakeHandler>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly order: string[] = [];
  private inflight = 0;

  constructor(private readonly store: Store) {}

  on(kind: JobKind, handler: FakeHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  enqueue(input: EnqueueInput): Job {
    const job = this.store.jobs.insert({
      kind: input.kind, lane: input.lane, payload: input.payload, priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3, nextRunAt: new Date().toISOString(), episodeRunId: input.episodeRunId ?? null,
    });
    this.order.push(job.id);
    const handler = this.handlers.get(input.kind);
    if (handler) {
      this.inflight++;
      queueMicrotask(() => { void this.run(job.id, handler); });
    }
    return job;
  }

  private async run(id: string, handler: FakeHandler): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      if (TERMINAL.has(this.store.jobs.require(id).status)) return;
      this.store.jobs.update(id, { status: 'running', startedAt: new Date().toISOString() });
      const result = await handler(this.store.jobs.require(id), controller.signal);
      this.settle(id, { status: 'succeeded', result: result ?? null });
    } catch (err) {
      this.settle(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.controllers.delete(id);
      this.inflight--;
    }
  }

  private settle(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job {
    const current = this.store.jobs.require(id);
    if (TERMINAL.has(current.status)) return current;
    const job = this.store.jobs.update(id, { ...patch, finishedAt: new Date().toISOString() });
    for (const resolve of this.waiters.get(id) ?? []) resolve(job);
    this.waiters.delete(id);
    return job;
  }

  succeed(id: string, result: unknown = null): Job { return this.settle(id, { status: 'succeeded', result }); }
  fail(id: string, error: string): Job { return this.settle(id, { status: 'failed', error }); }

  cancel(id: string): Job {
    this.controllers.get(id)?.abort();
    return this.settle(id, { status: 'cancelled' });
  }

  waitFor(id: string): Promise<Job> {
    const job = this.store.jobs.require(id);
    if (TERMINAL.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => { this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]); });
  }

  /** Jobs enqueued through this queue, in enqueue order. */
  jobs(kind?: JobKind): Job[] {
    return this.order.map((id) => this.store.jobs.require(id)).filter((j) => kind === undefined || j.kind === kind);
  }

  /** Resolves once no handler is running and none is scheduled. */
  async idle(): Promise<void> {
    for (let i = 0; i < 5_000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.inflight === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.inflight === 0) return;
      }
    }
    throw new Error('FakeQueue did not become idle');
  }

  asQueue(): JobQueue {
    return this as unknown as JobQueue;
  }
}

export function fakeJobContext(
  store: Store, bus: EventBus, queue: FakeQueue, job: Job, signal: AbortSignal = new AbortController().signal, progress: string[] = [],
): JobContext {
  return { job, signal, store, bus, gpu: new GpuArbiter(), queue: queue.asQueue(), progress: (label) => { progress.push(label); } };
}

export interface FakeImagingOptions {
  /** Issues to report for a review; [] or undefined = pass. */
  review?: (imageId: string, panelId: string | null) => ReviewResult['issues'] | undefined;
  /** Throw to make a panel render fail. */
  beforePanel?: (panelId: string) => void;
}

/** Stand-ins for M2's image.generate (panel + portrait) and image.review handlers. */
export function fakeImaging(store: Store, queue: FakeQueue, opts: FakeImagingOptions = {}): void {
  queue.on('image.generate', (job) => {
    const p = job.payload as ImageGeneratePayload;
    if (p.target === 'panel') {
      opts.beforePanel?.(p.panelId);
      const panel = store.panels.require(p.panelId);
      const page = store.pages.require(panel.pageId);
      const image = seedImage(store, page.mangaId, { type: 'panel', id: panel.id }, null);
      store.panels.update(panel.id, { activeImageId: image.id });
      return { imageId: image.id };
    }
    if (p.target === 'character-portrait') {
      const c = store.characters.require(p.characterId);
      return { imageId: seedImage(store, c.mangaId, { type: 'character', id: c.id }, 'portrait').id };
    }
    throw new Error(`fake imaging does not support ${p.target}`);
  });
  queue.on('image.review', (job) => {
    const p = job.payload as ImageReviewPayload;
    const issues = opts.review?.(p.imageId, p.panelId) ?? [];
    const review: ReviewResult = { engine: 'claude', pass: issues.length === 0, issues, at: new Date().toISOString() };
    store.images.update(p.imageId, { review });
    return review;
  });
}
