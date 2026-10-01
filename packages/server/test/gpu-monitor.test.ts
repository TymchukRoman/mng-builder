import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON, GPU_MANUAL_PAUSE_REASON } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { GPU_MONITOR_INTERVAL_MS, GPU_RESUME_FREE_BYTES, GpuMonitor } from '../src/imaging/gpu-monitor.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { JobQueue } from '../src/jobs/queue.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { makeStore, type TestStore } from './helpers/store.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const graph: ComfyGraph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0], seed: 1, steps: 3, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'm' } },
};

let t: TestStore;
let fake: FakeComfy;
let queue: JobQueue | undefined;
let monitor: GpuMonitor | undefined;
beforeEach(async () => { t = makeStore(); fake = await startFakeComfy(); });
afterEach(async () => {
  monitor?.stop();
  await queue?.stop();
  queue = undefined;
  monitor = undefined;
  await fake.close();
  t.close();
});

const newQueue = (): JobQueue => new JobQueue({ store: t.store, bus: new EventBus(), gpu: new GpuArbiter(), pollMs: 5 });

describe('GpuMonitor (W1 R2)', () => {
  it('resumes at 8 GB available and polls every 30 s by default', () => {
    expect(GPU_RESUME_FREE_BYTES).toBe(8e9);
    expect(GPU_MONITOR_INTERVAL_MS).toBe(30_000);
  });

  it('a low-VRAM job pauses the lane; the monitor resumes it once ComfyUI has room again', async () => {
    fake.vramFree = 1e9;
    // vramWaitMs: the F13 re-read before refusing is kept short here.
    const comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10, vramWaitMs: 50 });
    queue = newQueue();
    queue.register('image.generate', async (ctx) => { await comfy.run(graph, { signal: ctx.signal, onProgress: ctx.progress }); });
    monitor = new GpuMonitor({ queue, probe: comfy, intervalMs: 20 });
    monitor.start();
    const job = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    queue.start();
    await vi.waitFor(() => expect(queue!.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON));
    expect(t.store.jobs.require(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await sleep(100);
    expect(queue.pauseOf('gpu')).not.toBeNull(); // still 1 GB free: stays paused
    expect(fake.calls.some((c) => c.path === '/prompt')).toBe(false);
    fake.vramFree = GPU_RESUME_FREE_BYTES + 1e9;
    expect(await queue.waitFor(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(queue.pauseOf('gpu')).toBeNull();
  });

  it('never lifts a manual pause', async () => {
    queue = newQueue();
    queue.pauseLane('gpu', null, GPU_MANUAL_PAUSE_REASON);
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => 16e9 }, intervalMs: 10 });
    monitor.start();
    expect(await monitor.check()).toBe('idle');
    await sleep(50);
    expect(queue.pauseOf('gpu')?.reason).toBe(GPU_MANUAL_PAUSE_REASON);
  });

  it('resumes when ComfyUI comes back after being unreachable (a restart), even with little VRAM', async () => {
    queue = newQueue();
    const answers: Array<number | null> = [null, 1e9];
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => (answers.length > 0 ? answers.shift() as number | null : 1e9) }, intervalMs: 60_000 });
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    expect(await monitor.check()).toBe('waiting');
    expect(await monitor.check()).toBe('resumed');
    expect(queue.pauseOf('gpu')).toBeNull();
  });

  it('resumes after two polls in a row find ComfyUI down: it holds no VRAM, and the next job relaunches it (F12)', async () => {
    queue = newQueue();
    const answers: Array<number | null> = [1e9, null, 1e9, null, null];
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => (answers.length > 0 ? answers.shift() as number | null : null) }, intervalMs: 60_000 });
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    expect(await monitor.check()).toBe('waiting'); // up, 1 GB
    expect(await monitor.check()).toBe('waiting'); // down once
    // Up again with 1 GB after a poll that found it down: a restart, so it resumes (the job's own check decides).
    expect(await monitor.check()).toBe('resumed');
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    expect(await monitor.check()).toBe('waiting'); // down once
    expect(await monitor.check()).toBe('resumed'); // down twice in a row
    expect(queue.pauseOf('gpu')).toBeNull();
  });

  it('a probe in flight when the monitor stops never resumes the lane (Task 3 M5)', async () => {
    queue = newQueue();
    let answer!: (free: number) => void;
    monitor = new GpuMonitor({ queue, probe: { availableVram: () => new Promise<number>((resolve) => { answer = resolve; }) }, intervalMs: 60_000 });
    monitor.start();
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    const check = monitor.check();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    monitor.stop(); // shutdown while ComfyUI is still answering
    answer(16e9);
    expect(await check).toBe('idle');
    expect(queue.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON);
  });

  it('polls only while the lane is paused as busy', async () => {
    queue = newQueue();
    let polls = 0;
    monitor = new GpuMonitor({ queue, probe: { availableVram: async () => { polls++; return 1e9; } }, intervalMs: 10 });
    monitor.start();
    await sleep(50);
    expect(polls).toBe(0);
    queue.pauseLane('gpu', null, GPU_BUSY_REASON);
    await vi.waitFor(() => expect(polls).toBeGreaterThan(1));
    queue.resumeLane('gpu');
    const after = polls;
    await sleep(50);
    expect(polls).toBeLessThanOrEqual(after + 1); // at most one poll that was already in flight
  });
});
