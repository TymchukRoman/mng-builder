import { GPU_BUSY_REASON, type Job, type JobKind, type JobProgress, type JobStatus, type Lane, type ServiceStatus } from '@manga/shared';
import type { EventBus } from '../events/bus.js';
import type { Store } from '../store/index.js';
import { GpuBusyError, PermanentError, TransientError } from './errors.js';
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

/**
 * cpu runs two jobs (M4 final M5): the episode render/lettering drivers only await other lanes, so a long render never
 * holds the lane alone; exports run one at a time behind their own lock (export/job.ts).
 */
export const DEFAULT_LANE_LIMITS: Readonly<Record<Lane, number>> = { gpu: 1, claude: 2, cpu: 2 };
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];
/** W1 F1: how often one job may be put back after a stall caused by a busy GPU; the next stall spends an attempt. */
export const MAX_STALL_REQUEUES = 2;
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
  private readonly laneListeners = new Set<() => void>();
  /** W1 F1: busy requeues after a stall, per job id (in memory: a restart starts the count again). */
  private readonly stallRequeues = new Map<string, number>();
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

  /** Default lane limits: gpu 1, claude 2, cpu 2; maxAttempts default 3. */
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
    this.stallRequeues.delete(id);
    const cancelled = this.store.jobs.update(id, { status: 'cancelled', finishedAt: this.now().toISOString() });
    run?.controller.abort(new Error('cancelled'));
    this.publish(cancelled);
    this.settle(cancelled);
    return cancelled;
  }

  /**
   * Moves a queued job to another lane and publishes it (I1: an engine switch re-lanes queued text jobs). A job moved
   * out of a paused lane can run right away: the lane it waited in no longer applies, and neither does a retry
   * backoff earned there (e.g. a Claude quota error). Returns the moved job, or null when nothing changed: the job
   * is running or finished (it stays where it ran), or already in `lane`.
   */
  relane(id: string, lane: Lane): Job | null {
    const job = this.store.jobs.require(id);
    if (job.status !== 'queued' || job.lane === lane) return null;
    const nowIso = this.now().toISOString();
    const moved = this.store.jobs.update(id, { lane, nextRunAt: job.nextRunAt > nowIso ? nowIso : job.nextRunAt });
    this.publish(moved);
    this.kick();
    return moved;
  }

  /** until null = until resumeLane. Notifies the lane listeners (the `status` event, the GPU monitor). */
  pauseLane(lane: Lane, until: Date | null, reason: string): void {
    this.paused.set(lane, { until, reason });
    this.lanesChanged();
  }

  resumeLane(lane: Lane): void {
    const had = this.paused.delete(lane);
    this.kick();
    if (had) this.lanesChanged();
  }

  /** The lane's pause, or null (an expired timed pause is dropped first). */
  pauseOf(lane: Lane): { until: Date | null; reason: string } | null {
    this.expirePauses();
    return this.paused.get(lane) ?? null;
  }

  /** Called after every pause, resume or expiry of a lane. Returns the unsubscribe function. */
  onLanesChanged(listener: () => void): () => void {
    this.laneListeners.add(listener);
    return () => { this.laneListeners.delete(listener); };
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

  /**
   * Puts the jobs a crashed process left 'running' back in line. startServer calls it before the modules' start(), so a
   * module that resumes work there sees those jobs as queued. Idempotent, and start() calls it too. Does nothing
   * while the queue is running: a job that is really running must not be reset.
   */
  recover(): void {
    if (this.started) return;
    this.store.jobs.resetRunning();
  }

  /** recover() then poll loop. */
  start(): void {
    if (this.started) return;
    this.recover();
    this.started = true;
    this.stopping = false;
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
    let changed = false;
    for (const [lane, pause] of this.paused) {
      if (pause.until !== null && pause.until.getTime() <= now) {
        this.paused.delete(lane);
        changed = true;
      }
    }
    if (changed) this.lanesChanged();
  }

  private lanesChanged(): void {
    for (const listener of [...this.laneListeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[manga] job queue: lane listener failed:', error);
      }
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
      try {
        while (this.runningIn(lane) < this.limits[lane]) {
          const job = this.store.jobs.claimNext(lane, this.now().toISOString());
          if (job === null) break;
          this.launch(job);
        }
      } catch (error) {
        // A bad row (e.g. corrupt stored JSON) must not kill the poll loop or stop() start() from booting.
        console.error(`[manga] job queue: failed to claim from lane ${lane}:`, error);
      }
    }
  }

  private launch(job: Job): void {
    this.publish(job);
    const run: Running = { lane: job.lane, controller: new AbortController(), cancelled: false, done: Promise.resolve() };
    this.running.set(job.id, run);
    run.done = this.execute(job, run).finally(() => {
      if (this.running.get(job.id) === run) this.running.delete(job.id);
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
    try {
      this.finish(job.id, run, outcome);
    } catch (error) {
      this.recordOutcomeFailure(job, run, error);
    }
  }

  /**
   * finish() itself failed to persist the outcome (e.g. a result that can't be JSON-encoded). A job must never be
   * left stuck 'running' with nothing watching it: mark it failed, or — if even that write fails — settle waiters
   * from the in-memory job so callers don't hang, and log loudly since the store disagrees with reality.
   */
  private recordOutcomeFailure(job: Job, run: Running, error: unknown): void {
    if (run.cancelled) return; // cancel() already recorded, published and settled it
    const message = `could not record outcome: ${messageOf(error)}`;
    try {
      this.complete(this.store.jobs.update(job.id, { status: 'failed', error: message, finishedAt: this.now().toISOString() }));
    } catch (writeError) {
      console.error('[manga] job queue: failed to persist job outcome:', writeError);
      this.settle({ ...job, status: 'failed', error: message, finishedAt: this.now().toISOString() });
    }
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
    if (outcome.error instanceof GpuBusyError && this.mayRequeueBusy(id, outcome.error)) {
      // W1 R2: another app holds the GPU. Put the job back at once without spending an attempt (it waits for the lane,
      // not for a backoff), then pause the lane; a pause already there (e.g. the user's) stays as it is. F23: the error
      // is cleared, since nothing is retried: the lane chip tells why the job waits. The job is written first, so the
      // `status` event of the pause counts it as queued.
      const requeued = this.store.jobs.update(id, {
        status: 'queued', error: null, startedAt: null, nextRunAt: nowIso, attempts: Math.max(0, current.attempts - 1),
      });
      if (!this.paused.has(current.lane)) this.pauseLane(current.lane, null, GPU_BUSY_REASON);
      this.publish(requeued);
      return;
    }
    if (outcome.error instanceof TransientError && current.attempts < current.maxAttempts) {
      const delay = this.backoffMs[Math.min(current.attempts - 1, this.backoffMs.length - 1)] ?? 0;
      this.publish(this.store.jobs.update(id, {
        status: 'queued', error: message, startedAt: null, nextRunAt: new Date(this.now().getTime() + delay).toISOString(),
      }));
      return;
    }
    this.complete(this.store.jobs.update(id, { status: 'failed', error: message, finishedAt: nowIso }));
  }

  /**
   * W1 F1: a refusal before submitting always requeues (it put nothing on the GPU). A stall requeues at most
   * MAX_STALL_REQUEUES times per job; after that it is handled as the plain TransientError it extends.
   */
  private mayRequeueBusy(id: string, error: GpuBusyError): boolean {
    if (!error.stalled) return true;
    const count = this.stallRequeues.get(id) ?? 0;
    if (count >= MAX_STALL_REQUEUES) return false;
    this.stallRequeues.set(id, count + 1);
    return true;
  }

  private complete(job: Job): void {
    this.stallRequeues.delete(job.id);
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
        // A callback left behind by an earlier, already-finished attempt (e.g. a stray timer after a
        // TransientError) must not touch the row a newer attempt of the same job id now owns.
        if (this.running.get(job.id) !== run) return;
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
