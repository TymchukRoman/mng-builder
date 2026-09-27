import type { Job, JobKind, JobProgress, JobStatus, Lane, ServiceStatus } from '@manga/shared';
import type { EventBus } from '../events/bus.js';
import type { Store } from '../store/index.js';
import { PermanentError, TransientError } from './errors.js';
import type { GpuArbiter } from './gpu.js';

export interface JobContext {
  job: Job; signal: AbortSignal; store: Store; bus: EventBus; gpu: GpuArbiter; queue: JobQueue;
  progress(label: string, value?: number, max?: number): void;   // persists + emits {type:'job'}
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;
export interface EnqueueInput { kind: JobKind; lane: Lane; payload: unknown; priority?: number; maxAttempts?: number; episodeRunId?: string | null }
export interface JobQueueOptions {
  store: Store; bus: EventBus; gpu: GpuArbiter;
  limits?: Partial<Record<Lane, number>>; pollMs?: number; backoffMs?: number[]; now?: () => Date;
}

export const DEFAULT_LANE_LIMITS: Readonly<Record<Lane, number>> = { gpu: 1, claude: 2, cpu: 1 };
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];
const LANES: readonly Lane[] = ['gpu', 'claude', 'cpu'];
const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

interface Running { lane: Lane; controller: AbortController; cancelled: boolean; done: Promise<void> }
type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Durable queue: every job is a row first. One worker loop, three lanes with their own concurrency. */
export class JobQueue {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly gpu: GpuArbiter;
  private readonly limits: Record<Lane, number>;
  private readonly pollMs: number;
  private readonly backoffMs: readonly number[];
  private readonly now: () => Date;
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly running = new Map<string, Running>();
  private readonly paused = new Map<Lane, { until: Date | null; reason: string }>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping = false;

  constructor(opts: JobQueueOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.gpu = opts.gpu;
    this.limits = { ...DEFAULT_LANE_LIMITS, ...opts.limits };
    this.pollMs = opts.pollMs ?? 250;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = opts.now ?? (() => new Date());
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Default lane limits: gpu 1, claude 2, cpu 1; maxAttempts default 3. */
  enqueue(input: EnqueueInput): Job {
    const job = this.store.jobs.insert({
      kind: input.kind,
      lane: input.lane,
      priority: input.priority ?? 0,
      payload: input.payload ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      nextRunAt: this.now().toISOString(),
      episodeRunId: input.episodeRunId ?? null,
    });
    this.publish(job);
    this.kick();
    return job;
  }

  /** queued → cancelled; running → abort signal, status cancelled. Terminal jobs are returned unchanged. */
  cancel(id: string): Job {
    const job = this.store.jobs.require(id);
    if (isTerminal(job.status)) return job;
    const run = this.running.get(id);
    if (run) run.cancelled = true;
    const cancelled = this.store.jobs.update(id, { status: 'cancelled', finishedAt: this.now().toISOString() });
    run?.controller.abort(new Error('cancelled'));
    this.publish(cancelled);
    this.settle(cancelled);
    return cancelled;
  }

  /** until null = until resumeLane. */
  pauseLane(lane: Lane, until: Date | null, reason: string): void {
    this.paused.set(lane, { until, reason });
  }

  resumeLane(lane: Lane): void {
    this.paused.delete(lane);
    this.kick();
  }

  pausedLanes(): ServiceStatus['queue']['pausedLanes'] {
    this.expirePauses();
    return [...this.paused.entries()].map(([lane, p]) => ({ lane, until: p.until ? p.until.toISOString() : null, reason: p.reason }));
  }

  /** Resolves at succeeded/failed/cancelled. */
  waitFor(id: string): Promise<Job> {
    const job = this.store.jobs.require(id);
    if (isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** resetRunning() then poll loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.store.jobs.resetRunning();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
    this.tick();
  }

  /** Aborts running handlers and waits for them to settle. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const runs = [...this.running.values()];
    for (const run of runs) run.controller.abort(new Error('server stopping'));
    await Promise.allSettled(runs.map((run) => run.done));
    this.started = false;
  }

  private kick(): void {
    if (this.started && !this.stopping) setImmediate(() => this.tick());
  }

  private expirePauses(): void {
    const now = this.now().getTime();
    for (const [lane, pause] of this.paused) {
      if (pause.until !== null && pause.until.getTime() <= now) this.paused.delete(lane);
    }
  }

  private runningIn(lane: Lane): number {
    let count = 0;
    for (const run of this.running.values()) if (run.lane === lane) count += 1;
    return count;
  }

  private tick(): void {
    if (!this.started || this.stopping) return;
    this.expirePauses();
    for (const lane of LANES) {
      if (this.paused.has(lane)) continue;
      while (this.runningIn(lane) < this.limits[lane]) {
        const job = this.store.jobs.claimNext(lane, this.now().toISOString());
        if (job === null) break;
        this.launch(job);
      }
    }
  }

  private launch(job: Job): void {
    this.publish(job);
    const run: Running = { lane: job.lane, controller: new AbortController(), cancelled: false, done: Promise.resolve() };
    this.running.set(job.id, run);
    run.done = this.execute(job, run).finally(() => {
      this.running.delete(job.id);
      this.kick();
    });
  }

  private async execute(job: Job, run: Running): Promise<void> {
    const handler = this.handlers.get(job.kind);
    let outcome: Outcome;
    if (handler === undefined) {
      outcome = { ok: false, error: new PermanentError(`no handler registered for job kind ${job.kind}`) };
    } else {
      try {
        outcome = { ok: true, result: (await handler(this.context(job, run))) ?? null };
      } catch (error) {
        outcome = { ok: false, error };
      }
    }
    this.finish(job.id, run, outcome);
  }

  private finish(id: string, run: Running, outcome: Outcome): void {
    if (run.cancelled) return; // cancel() already recorded, published and settled it
    const current = this.store.jobs.get(id);
    if (current === null || current.status !== 'running') return;
    const nowIso = this.now().toISOString();

    if (outcome.ok) {
      this.complete(this.store.jobs.update(id, { status: 'succeeded', result: outcome.result, error: null, finishedAt: nowIso }));
      return;
    }
    if (this.stopping && run.controller.signal.aborted) {
      // Interrupted by shutdown, not by its own fault: back in line, attempt not spent.
      this.publish(this.store.jobs.update(id, { status: 'queued', startedAt: null, attempts: Math.max(0, current.attempts - 1) }));
      return;
    }
    const message = messageOf(outcome.error);
    if (outcome.error instanceof TransientError && current.attempts < current.maxAttempts) {
      const delay = this.backoffMs[Math.min(current.attempts - 1, this.backoffMs.length - 1)] ?? 0;
      this.publish(this.store.jobs.update(id, {
        status: 'queued', error: message, startedAt: null, nextRunAt: new Date(this.now().getTime() + delay).toISOString(),
      }));
      return;
    }
    this.complete(this.store.jobs.update(id, { status: 'failed', error: message, finishedAt: nowIso }));
  }

  private complete(job: Job): void {
    this.publish(job);
    this.settle(job);
  }

  private context(job: Job, run: Running): JobContext {
    return {
      job,
      signal: run.controller.signal,
      store: this.store,
      bus: this.bus,
      gpu: this.gpu,
      queue: this,
      progress: (label, value, max) => {
        if (run.controller.signal.aborted) return;
        const current = this.store.jobs.get(job.id);
        if (current === null || current.status !== 'running') return;
        const progress: JobProgress = { label, ...(value === undefined ? {} : { value }), ...(max === undefined ? {} : { max }) };
        this.publish(this.store.jobs.update(job.id, { progress }));
      },
    };
  }

  private publish(job: Job): void {
    this.bus.emit({ type: 'job', job });
  }

  private settle(job: Job): void {
    const list = this.waiters.get(job.id);
    if (list === undefined) return;
    this.waiters.delete(job.id);
    for (const resolve of list) resolve(job);
  }
}
