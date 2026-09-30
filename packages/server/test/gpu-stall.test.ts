import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_BUSY_REASON } from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { GpuArbiter } from '../src/jobs/gpu.js';
import { JobQueue } from '../src/jobs/queue.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { makeStore, type TestStore } from './helpers/store.js';

const graph = (prefix: string): ComfyGraph => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0], seed: 1, steps: 3, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: prefix } },
});

const BACKOFF_MS = 400;

let t: TestStore;
let fake: FakeComfy;
let queue: JobQueue | undefined;
beforeEach(async () => {
  t = makeStore();
  fake = await startFakeComfy();
});
afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  await fake.close();
  t.close();
});

describe('a stalled ComfyUI run in the gpu lane', () => {
  const stallQueue = (): { comfy: ComfyClient; queue: JobQueue; runs: string[] } => {
    const comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10, firstProgressTimeoutMs: 5_000, stallTimeoutMs: 250 });
    const q = new JobQueue({ store: t.store, bus: new EventBus(), gpu: new GpuArbiter(), pollMs: 5, backoffMs: [BACKOFF_MS] });
    queue = q;
    return { comfy, queue: q, runs: [] };
  };

  it('pauses the gpu lane as busy and puts the stalled job back without spending an attempt; a resume runs both jobs', async () => {
    const { comfy, queue: q, runs } = stallQueue();
    let gameStarted = false;
    q.register('image.generate', async (ctx) => {
      const name = (ctx.job.payload as { name: string }).name;
      const onProgress = (label: string, value?: number, max?: number): void => {
        // A game grabs the GPU memory while the first prompt samples; the prompt then stalls.
        if (label === 'Sampling' && name === 'stalled' && !gameStarted) {
          gameStarted = true;
          fake.vramFree = 1e9;
        }
        ctx.progress(label, value, max);
      };
      try {
        await comfy.run(graph(name), { signal: ctx.signal, onProgress });
        runs.push(`${name}:ok`);
      } catch (err) {
        runs.push(`${name}:failed`);
        throw err;
      }
    });
    fake.stallNext = 1;
    const stalled = q.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'stalled' } });
    const next = q.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'next' } });
    q.start();

    await vi.waitFor(() => expect(q.pauseOf('gpu')?.reason).toBe(GPU_BUSY_REASON), { timeout: 5_000 });
    await vi.waitFor(() => expect(t.store.jobs.require(stalled.id)).toMatchObject({ status: 'queued', attempts: 0, error: null }));
    expect(t.store.jobs.require(stalled.id).progress?.label).toMatch(/^GPU stalled: no progress for 250 ms/);
    expect(t.store.jobs.require(next.id).status).toBe('queued'); // the lane waits instead of stalling job after job
    const first = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: first } });
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);

    fake.vramFree = 15e9; // the game quit
    q.resumeLane('gpu');
    const [a, b] = await Promise.all([q.waitFor(stalled.id), q.waitFor(next.id)]);
    expect(a).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(b).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(runs).toEqual(['stalled:failed', 'stalled:ok', 'next:ok']);
  });

  it('a stall with 15 GB free spends attempts and ends failed (W1 F1)', async () => {
    const { comfy, queue: q, runs } = stallQueue();
    const lanes: string[] = [];
    q.onLanesChanged(() => lanes.push(q.pauseOf('gpu')?.reason ?? 'running'));
    q.register('image.generate', async (ctx) => {
      fake.stallNext = 1; // every attempt stalls, with nothing else on the GPU (e.g. a hung custom node)
      try {
        await comfy.run(graph('hung'), { signal: ctx.signal, onProgress: ctx.progress });
        runs.push('ok');
      } catch (err) {
        runs.push('failed');
        throw err;
      }
    });
    const job = q.enqueue({ kind: 'image.generate', lane: 'gpu', payload: null });
    q.start();

    const done = await q.waitFor(job.id);
    expect(done).toMatchObject({ status: 'failed', attempts: 3 });
    expect(done.error).toMatch(/^GPU stalled: no progress for 250 ms/);
    expect(runs).toEqual(['failed', 'failed', 'failed']);
    expect(lanes).toEqual([]); // never paused: the lane moves on
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(3);
  }, 10_000);
});
