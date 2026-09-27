import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { PermanentError, TransientError } from '../src/jobs/errors.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { DEFAULT_BACKOFF_MS, JobQueue, type JobContext, type JobQueueOptions } from '../src/jobs/queue.js';
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
