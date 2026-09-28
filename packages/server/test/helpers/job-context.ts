import type { JobKind, Lane, ServerEvent } from '@manga/shared';
import { EventBus } from '../../src/events/bus.js';
import { GpuArbiter, JobQueue, type JobContext } from '../../src/jobs/index.js';
import type { Store } from '../../src/store/index.js';

export interface TestJobContext {
  ctx: JobContext;
  events: ServerEvent[];
  progress: Array<{ label: string; value?: number; max?: number }>;
  controller: AbortController;
}

/** The lane a route enqueues `kind` into under DEFAULT_SETTINGS (engine mode 'claude'): text jobs run on Claude. */
const defaultLane = (kind: JobKind): Lane => (kind === 'llm.step' || kind === 'image.review' ? 'claude' : 'gpu');

/** A JobContext around a real Job row, without starting the queue. The job's lane decides the text engine (I1). */
export function jobContext(store: Store, kind: JobKind, payload: unknown, opts: { gpu?: GpuArbiter; lane?: Lane } = {}): TestJobContext {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.on((e) => { events.push(e); });
  const gpu = opts.gpu ?? new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const lane = opts.lane ?? defaultLane(kind);
  const job = store.jobs.insert({ kind, lane, payload, priority: 0, maxAttempts: 1, nextRunAt: new Date().toISOString(), episodeRunId: null });
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
