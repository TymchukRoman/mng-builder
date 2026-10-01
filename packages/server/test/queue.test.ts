import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON, type Job } from '@manga/shared';
import { QuotaExceededError } from '../src/engines/errors.js';
import { EventBus } from '../src/events/bus.js';
import { GpuBusyError, PermanentError, TransientError } from '../src/jobs/errors.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { DEFAULT_BACKOFF_MS, JobQueue, MAX_STALL_REQUEUES, type JobContext, type JobQueueOptions } from '../src/jobs/queue.js';
import { makeStore, type TestStore } from './helpers/store.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let t: TestStore;
let bus: EventBus;
let queue: JobQueue | undefined;

function makeQueue(opts: Partial<JobQueueOptions> = {}): JobQueue {
  queue = new JobQueue({ store: t.store, bus, gpu: new GpuArbiter(), pollMs: 5, backoffMs: [10, 10, 10], ...opts });
  return queue;
}

const gpuJob = (q: JobQueue, payload: unknown = null, priority?: number): Job =>
  q.enqueue({ kind: 'image.generate', lane: 'gpu', payload, ...(priority === undefined ? {} : { priority }) });

beforeEach(() => {
  t = makeStore();
  bus = new EventBus();
});
afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  t.close();
});

describe('JobQueue', () => {
  it('runs a job and resolves waitFor with the stored result', async () => {
    const q = makeQueue();
    q.register('image.generate', async (ctx) => ({ got: ctx.job.payload }));
    q.start();
    const job = gpuJob(q, { panelId: 'pn_x' });
    expect(job.status).toBe('queued');
    const done = await q.waitFor(job.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1, result: { got: { panelId: 'pn_x' } }, error: null });
    expect(done.finishedAt).not.toBeNull();
  });

  it('runs higher priority first within a lane', async () => {
    const q = makeQueue();
    const order: string[] = [];
    q.register('image.generate', async (ctx) => {
      order.push((ctx.job.payload as { name: string }).name);
    });
    const low = gpuJob(q, { name: 'low' });
    const high = gpuJob(q, { name: 'high' }, 10);
    q.start();
    await Promise.all([q.waitFor(low.id), q.waitFor(high.id)]);
    expect(order).toEqual(['high', 'low']);
  });

  it('respects the default lane limits (gpu 1, claude 2) and runs lanes independently', async () => {
    const q = makeQueue();
    const gate = deferred();
    const active = { gpu: 0, claude: 0 };
    const peak = { gpu: 0, claude: 0 };
    const handler = async (ctx: JobContext): Promise<void> => {
      const lane = ctx.job.lane as 'gpu' | 'claude';
      active[lane] += 1;
      peak[lane] = Math.max(peak[lane], active[lane]);
      await gate.promise;
      active[lane] -= 1;
    };
    q.register('image.generate', handler);
    q.register('llm.step', handler);
    const jobs = [
      gpuJob(q), gpuJob(q), gpuJob(q),
      ...[1, 2, 3].map(() => q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null })),
    ];
    q.start();
    await vi.waitFor(() => expect(t.store.jobs.counts().running).toBe(3));
    await sleep(30);
    expect(t.store.jobs.counts()).toEqual({ queued: 3, running: 3 });
    gate.resolve();
    await Promise.all(jobs.map((j) => q.waitFor(j.id)));
    expect(peak).toEqual({ gpu: 1, claude: 2 });
  });

  it('retries a TransientError with backoff and then succeeds', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls += 1;
      if (calls < 3) throw new TransientError('comfy restarting');
      return 'ok';
    });
    q.start();
    const done = await q.waitFor(gpuJob(q).id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 3, result: 'ok' });
  });

  it('fails after maxAttempts transient errors, keeping the last message', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls += 1;
      throw new TransientError(`attempt ${calls}`);
    });
    q.start();
    const done = await q.waitFor(gpuJob(q).id);
    expect(done).toMatchObject({ status: 'failed', attempts: 3, error: 'attempt 3' });
  });

  it('schedules a retry after the backoff for that attempt (defaults 5 s, 30 s, 120 s)', async () => {
    expect(DEFAULT_BACKOFF_MS).toEqual([5_000, 30_000, 120_000]);
    const q = makeQueue({ backoffMs: [60_000, 60_000, 60_000] });
    q.register('image.generate', async () => {
      throw new TransientError('503 from comfy');
    });
    q.start();
    const before = Date.now();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).error).toBe('503 from comfy'));
    const retry = t.store.jobs.require(job.id);
    expect(retry).toMatchObject({ status: 'queued', attempts: 1, startedAt: null });
    const delay = Date.parse(retry.nextRunAt) - before;
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThan(62_000);
  });

  it('fails immediately on PermanentError and on any other error', async () => {
    const q = makeQueue();
    q.register('image.generate', async () => {
      throw new PermanentError('graph rejected');
    });
    q.register('llm.step', async () => {
      throw new Error('bad json');
    });
    q.start();
    const a = await q.waitFor(gpuJob(q).id);
    const b = await q.waitFor(q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null }).id);
    expect([a.status, a.attempts, a.error]).toEqual(['failed', 1, 'graph rejected']);
    expect([b.status, b.attempts, b.error]).toEqual(['failed', 1, 'bad json']);
  });

  it('fails a job whose kind has no handler', async () => {
    const q = makeQueue();
    q.start();
    const done = await q.waitFor(q.enqueue({ kind: 'export.render', lane: 'cpu', payload: null }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/no handler registered for job kind export\.render/);
  });

  it('cancels a queued job immediately without running it', async () => {
    const q = makeQueue();
    const ran = vi.fn();
    q.register('image.generate', async () => {
      ran();
    });
    const job = gpuJob(q);
    expect(q.cancel(job.id).status).toBe('cancelled');
    q.start();
    await sleep(30);
    expect(ran).not.toHaveBeenCalled();
    expect((await q.waitFor(job.id)).status).toBe('cancelled');
  });

  it('cancels a running job through its AbortSignal and ignores its late outcome', async () => {
    const q = makeQueue();
    let aborted = false;
    q.register('image.generate', (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
        setTimeout(() => resolve('late result'), 10);
      });
    }));
    q.start();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('running'));
    const waiting = q.waitFor(job.id);
    expect(q.cancel(job.id).status).toBe('cancelled');
    expect((await waiting).status).toBe('cancelled');
    await sleep(30);
    expect(aborted).toBe(true);
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'cancelled', result: null });
    expect(q.cancel(job.id).status).toBe('cancelled');
  });

  it('pauses and resumes a lane; a timed pause lifts itself', async () => {
    const q = makeQueue();
    q.register('llm.step', async () => 'done');
    q.pauseLane('claude', null, 'quota exhausted');
    q.start();
    const first = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    await sleep(40);
    expect(t.store.jobs.require(first.id).status).toBe('queued');
    expect(q.pausedLanes()).toEqual([{ lane: 'claude', until: null, reason: 'quota exhausted' }]);
    q.resumeLane('claude');
    expect((await q.waitFor(first.id)).status).toBe('succeeded');

    const until = new Date(Date.now() + 50);
    q.pauseLane('claude', until, 'quota');
    expect(q.pausedLanes()).toEqual([{ lane: 'claude', until: until.toISOString(), reason: 'quota' }]);
    const second = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    expect((await q.waitFor(second.id)).status).toBe('succeeded');
    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    expect(q.pausedLanes()).toEqual([]);
  });

  it('relane moves a queued job to another lane, publishes it, and it runs at once out of a paused lane (I1)', async () => {
    const q = makeQueue();
    const events: Job[] = [];
    bus.on((e) => {
      if (e.type === 'job') events.push(e.job);
    });
    const ranIn: string[] = [];
    q.register('llm.step', async (ctx) => {
      ranIn.push(ctx.job.lane);
    });
    q.pauseLane('claude', null, 'quota exhausted');
    q.start();
    const job = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    await sleep(30);
    expect(ranIn).toEqual([]);
    const moved = q.relane(job.id, 'gpu');
    expect(moved).toMatchObject({ id: job.id, lane: 'gpu', status: 'queued' });
    expect(events.map((j) => [j.status, j.lane])).toContainEqual(['queued', 'gpu']);
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', lane: 'gpu' });
    expect(ranIn).toEqual(['gpu']);
    expect(q.relane(job.id, 'claude')).toBeNull(); // finished jobs stay where they ran
  });

  it('relane leaves a running job, and a job already in that lane, alone', async () => {
    const q = makeQueue();
    const gate = deferred();
    q.register('llm.step', async () => {
      await gate.promise;
    });
    q.start();
    const running = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    try {
      await vi.waitFor(() => expect(t.store.jobs.require(running.id).status).toBe('running'));
      expect(q.relane(running.id, 'gpu')).toBeNull();
      expect(t.store.jobs.require(running.id).lane).toBe('claude');
      q.pauseLane('gpu', null, 'test');
      const queued = q.enqueue({ kind: 'llm.step', lane: 'gpu', payload: null });
      const events: Job[] = [];
      bus.on((e) => {
        if (e.type === 'job') events.push(e.job);
      });
      expect(q.relane(queued.id, 'gpu')).toBeNull();
      expect(events).toEqual([]);
    } finally {
      gate.resolve();
    }
    await q.waitFor(running.id);
  });

  it('re-queues a job that ran out of Claude quota and runs it once the lane resumes (M11)', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('llm.step', async (ctx) => {
      calls += 1;
      if (calls === 1) {
        // What ClaudeEngine's onRateLimit does (modules/services.ts), then the error it throws.
        ctx.queue.pauseLane('claude', null, 'Claude quota exhausted');
        throw new QuotaExceededError(null);
      }
      return 'after reset';
    });
    q.start();
    const job = q.enqueue({ kind: 'llm.step', lane: 'claude', payload: null });
    await vi.waitFor(() => expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 1 }));
    expect(t.store.jobs.require(job.id).error).toBe('Claude quota exhausted');
    await sleep(60); // well past the 10 ms test backoff: only the pause holds it now
    expect(calls).toBe(1);
    expect(t.store.jobs.require(job.id).status).toBe('queued');
    q.resumeLane('claude');
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 2, result: 'after reset' });
    expect(calls).toBe(2);
  });

  it('re-queues jobs left running by a crash when it starts', async () => {
    const stale = t.store.jobs.insert({
      kind: 'image.generate', lane: 'gpu', priority: 0, payload: null, maxAttempts: 3, nextRunAt: new Date().toISOString(), episodeRunId: null,
    });
    t.store.jobs.claimNext('gpu', new Date().toISOString());
    expect(t.store.jobs.require(stale.id).status).toBe('running');
    const q = makeQueue();
    q.register('image.generate', async () => 'recovered');
    q.start();
    expect(await q.waitFor(stale.id)).toMatchObject({ status: 'succeeded', result: 'recovered' });
  });

  it('recover() re-queues crashed jobs before start(), is idempotent, and never resets a job that is really running', async () => {
    const stale = t.store.jobs.insert({
      kind: 'image.generate', lane: 'gpu', priority: 0, payload: null, maxAttempts: 3, nextRunAt: new Date().toISOString(), episodeRunId: null,
    });
    t.store.jobs.claimNext('gpu', new Date().toISOString());
    const q = makeQueue();
    q.recover();
    q.recover();
    expect(t.store.jobs.require(stale.id).status).toBe('queued');
    const release = deferred();
    q.register('image.generate', async () => { await release.promise; return 'ok'; });
    q.start();
    await vi.waitFor(() => expect(t.store.jobs.require(stale.id).status).toBe('running'));
    q.recover(); // the queue is running: this job is really running and stays so
    expect(t.store.jobs.require(stale.id).status).toBe('running');
    release.resolve();
    expect(await q.waitFor(stale.id)).toMatchObject({ status: 'succeeded', attempts: 2 }); // the crashed claim spent one
  });

  it('puts an aborted running job back in the queue on stop without spending the attempt', async () => {
    const q = makeQueue();
    q.register('image.generate', (ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    q.start();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('running'));
    await q.stop();
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0, startedAt: null });
  });

  it('persists progress and publishes every change as a job event', async () => {
    const q = makeQueue();
    const events: Job[] = [];
    bus.on((e) => {
      if (e.type === 'job') events.push(e.job);
    });
    q.register('image.generate', async (ctx) => {
      ctx.progress('Loading model');
      ctx.progress('Sampling', 3, 8);
      return null;
    });
    q.start();
    const job = gpuJob(q);
    await q.waitFor(job.id);
    expect(events.map((j) => [j.status, j.progress?.label ?? null])).toEqual([
      ['queued', null],
      ['running', null],
      ['running', 'Loading model'],
      ['running', 'Sampling'],
      ['succeeded', 'Sampling'],
    ]);
    expect(events[2]?.progress).toEqual({ label: 'Loading model' });
    expect(t.store.jobs.require(job.id).progress).toEqual({ label: 'Sampling', value: 3, max: 8 });
  });

  it('fails the job (instead of hanging waitFor forever) when its outcome cannot be persisted', async () => {
    const q = makeQueue();
    q.register('image.generate', async () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      return circular;
    });
    q.start();
    const done = await q.waitFor(gpuJob(q).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/could not record outcome/i);
  });

  it('drops a stale progress call left over from an earlier, already-retried attempt', async () => {
    const q = makeQueue();
    let call = 0;
    const gate = deferred();
    q.register('image.generate', async (ctx) => {
      call += 1;
      if (call === 1) {
        // Simulate a callback the first attempt scheduled before failing, which only fires once a retry is under way.
        setTimeout(() => ctx.progress('STALE from attempt 1'), 40);
        throw new TransientError('retry me');
      }
      ctx.progress('fresh from attempt 2');
      await gate.promise;
      return 'ok';
    });
    q.start();
    const job = gpuJob(q);
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).progress?.label).toBe('fresh from attempt 2'));
    await sleep(60); // let attempt 1's stale timer fire while attempt 2 is still running
    expect(t.store.jobs.require(job.id).progress?.label).toBe('fresh from attempt 2');
    gate.resolve();
    expect((await q.waitFor(job.id)).status).toBe('succeeded');
  });
});

describe('JobQueue — GPU busy (W1 R2)', () => {
  it('pauses the lane and puts the job back without spending an attempt; a resume runs it', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls++;
      if (calls === 1) throw new GpuBusyError('GPU busy: only 1.0 GB of GPU memory free');
      return { ok: true };
    });
    const seen: string[] = [];
    q.onLanesChanged(() => seen.push(q.pauseOf('gpu')?.reason ?? 'running'));
    const job = gpuJob(q);
    q.start();
    await vi.waitFor(() => expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    await sleep(30); // the paused lane claims nothing
    // F23: the error is cleared (nothing is retried; the job waits for the lane, which the lane chip shows).
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect(calls).toBe(1);
    q.resumeLane('gpu');
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(seen).toEqual([GPU_BUSY_REASON, 'running']);
  });

  it('never replaces a manual pause with the busy reason', async () => {
    const q = makeQueue();
    q.register('image.generate', async () => {
      q.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON); // the user paused while the job ran
      throw new GpuBusyError('GPU stalled');
    });
    const job = gpuJob(q);
    q.start();
    await vi.waitFor(() => expect(t.store.jobs.require(job.id).status).toBe('queued'));
    expect(q.pauseOf('gpu')?.reason).toBe(GPU_MANUAL_PAUSE_REASON);
  });

  it('a resume of a lane that is not paused notifies nobody', () => {
    const q = makeQueue();
    const seen: number[] = [];
    const off = q.onLanesChanged(() => seen.push(1));
    q.resumeLane('gpu');
    q.pauseLane('claude', null, 'quota');
    off();
    q.resumeLane('claude');
    expect(seen).toEqual([1]);
    expect(q.pauseOf('claude')).toBeNull();
  });

  it('a timed pause that expires notifies the listeners', async () => {
    const q = makeQueue();
    const seen: string[] = [];
    q.onLanesChanged(() => seen.push(q.pausedLanes().map((p) => p.lane).join(',') || 'none'));
    q.pauseLane('claude', new Date(Date.now() + 20), 'quota');
    q.start();
    await vi.waitFor(() => expect(seen).toEqual(['claude', 'none']));
  });

  it('caps the busy requeues of a stalled job at 2; the next stall spends attempts and the job ends failed (F1)', async () => {
    expect(MAX_STALL_REQUEUES).toBe(2);
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls++;
      throw new GpuBusyError('GPU stalled: no progress for 3 min', { stalled: true });
    });
    let pauses = 0;
    q.onLanesChanged(() => {
      if (q.pauseOf('gpu')?.reason !== GPU_BUSY_REASON) return;
      pauses++;
      setImmediate(() => q.resumeLane('gpu')); // what the GPU monitor does once ComfyUI has room again
    });
    const job = gpuJob(q);
    q.start();
    const done = await q.waitFor(job.id);
    expect(done).toMatchObject({ status: 'failed', attempts: 3, error: 'GPU stalled: no progress for 3 min' });
    expect(pauses).toBe(2);
    expect(calls).toBe(5); // 2 busy requeues, then 3 spent attempts
    expect(q.pauseOf('gpu')).toBeNull();
  });

  it('a GpuBusyError from a job outside the gpu lane pauses gpu, and the job spends an attempt (W1 final M6)', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('llm.step', async () => {
      calls++;
      if (calls === 1) throw new GpuBusyError('GPU busy: only 1.0 GB of GPU memory free');
      return 'ran';
    });
    const job = q.enqueue({ kind: 'llm.step', lane: 'cpu', payload: null });
    q.start();
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 2, result: 'ran' });
    expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON);
    expect(q.pauseOf('cpu')).toBeNull(); // never a lane without a monitor or a UI control
  });

  it('forgets the busy requeues of a stalled job when the job ends outside finish (Task 3 M4)', async () => {
    const q = makeQueue();
    const counts = (): Map<string, number> => (q as unknown as { stallRequeues: Map<string, number> }).stallRequeues;
    let calls = 0;
    const release = deferred();
    q.register('image.generate', async (ctx) => {
      calls++;
      if (calls === 1) throw new GpuBusyError('GPU stalled', { stalled: true });
      t.store.jobs.update(ctx.job.id, { status: 'failed', error: 'ended elsewhere', finishedAt: new Date().toISOString() });
      await release.promise;
      throw new Error('late');
    });
    q.onLanesChanged(() => { if (q.pauseOf('gpu')) setImmediate(() => q.resumeLane('gpu')); });
    const job = gpuJob(q);
    q.start();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(counts().get(job.id)).toBe(1);
    release.resolve();
    await vi.waitFor(() => expect(counts().has(job.id)).toBe(false));
  });

  it('never caps a refusal before submitting: it put nothing on the GPU', async () => {
    const q = makeQueue();
    let calls = 0;
    q.register('image.generate', async () => {
      calls++;
      if (calls <= 4) throw new GpuBusyError('GPU busy: only 1.0 GB of GPU memory free');
      return 'ran';
    });
    q.onLanesChanged(() => { if (q.pauseOf('gpu')) setImmediate(() => q.resumeLane('gpu')); });
    const job = gpuJob(q);
    q.start();
    expect(await q.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1, result: 'ran' });
    expect(calls).toBe(5);
  });
});
