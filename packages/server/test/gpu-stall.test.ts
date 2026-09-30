import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@manga/shared';
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
  it('fails transiently, lets the next job run during the backoff, then retries and succeeds', async () => {
    const bus = new EventBus();
    const events: Job[] = [];
    bus.on((event) => { if (event.type === 'job') events.push(event.job); });
    const comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10, firstProgressTimeoutMs: 5_000, stallTimeoutMs: 250 });
    queue = new JobQueue({ store: t.store, bus, gpu: new GpuArbiter(), pollMs: 5, backoffMs: [BACKOFF_MS] });
    const runs: Array<{ name: string; at: number; ok: boolean }> = [];
    queue.register('image.generate', async (ctx) => {
      const name = (ctx.job.payload as { name: string }).name;
      try {
        await comfy.run(graph(name), { signal: ctx.signal, onProgress: ctx.progress });
        runs.push({ name, at: Date.now(), ok: true });
      } catch (err) {
        runs.push({ name, at: Date.now(), ok: false });
        throw err;
      }
    });

    fake.stallNext = 1; // the first prompt samples one step, then goes silent
    const stalled = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'stalled' } });
    const next = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { name: 'next' } });
    queue.start();

    const [a, b] = await Promise.all([queue.waitFor(stalled.id), queue.waitFor(next.id)]);
    expect(a).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(b).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(runs.map((r) => `${r.name}:${r.ok ? 'ok' : 'failed'}`)).toEqual(['stalled:failed', 'next:ok', 'stalled:ok']);
    // The retry waited out the queue's backoff instead of looping straight back onto the GPU.
    expect(runs[2]!.at - runs[0]!.at).toBeGreaterThanOrEqual(BACKOFF_MS - 20);

    const retrying = events.find((job) => job.id === stalled.id && job.status === 'queued' && job.error !== null);
    expect(retrying?.error).toMatch(/^GPU stalled: no progress for 250 ms/);
    const first = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: first } });
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
  });
});
