import type { JobKind, ServerEvent } from '@manga/shared';
import { EventBus } from '../../src/events/bus.js';
import { GpuArbiter, JobQueue, type JobContext } from '../../src/jobs/index.js';
import type { Store } from '../../src/store/index.js';

export interface TestJobContext {
  ctx: JobContext;
  events: ServerEvent[];
  progress: Array<{ label: string; value?: number; max?: number }>;
  controller: AbortController;
}

/** A JobContext around a real Job row, without starting the queue. */
export function jobContext(store: Store, kind: JobKind, payload: unknown, opts: { gpu?: GpuArbiter } = {}): TestJobContext {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.on((e) => { events.push(e); });
  const gpu = opts.gpu ?? new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const job = store.jobs.insert({ kind, lane: 'gpu', payload, priority: 0, maxAttempts: 1, nextRunAt: new Date().toISOString(), episodeRunId: null });
  const progress: TestJobContext['progress'] = [];
  const controller = new AbortController();
  const ctx: JobContext = {
    job, signal: controller.signal, store, bus, gpu, queue,
    progress: (label, value, max) => {
      progress.push({ label, ...(value !== undefined ? { value } : {}), ...(max !== undefined ? { max } : {}) });
    },
  };
  return { ctx, events, progress, controller };
}
