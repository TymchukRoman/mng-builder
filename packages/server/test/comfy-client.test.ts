import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyClient, ComfyRejectedError, stageLabel } from '../src/imaging/comfy.js';
import type { ComfyGraph } from '../src/imaging/comfy-graph.js';
import { ComfyLauncher } from '../src/imaging/launcher.js';
import { pngSize } from '../src/imaging/png-size.js';
import { encodeSolidPng } from '../src/dev/png.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { fakeComfyRoot } from './helpers/comfy-root.js';

const miniGraph = (): ComfyGraph => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 48, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0], seed: 1, steps: 3, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'test' } },
});

let fake: FakeComfy;
let client: ComfyClient;
beforeEach(async () => {
  fake = await startFakeComfy();
  client = new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 });
});
afterEach(async () => { await fake.close(); });

type Step = { label: string; value?: number; max?: number };
const recorder = (): { steps: Step[]; onProgress: (label: string, value?: number, max?: number) => void } => {
  const steps: Step[] = [];
  return {
    steps,
    onProgress: (label, value, max) => { steps.push({ label, ...(value !== undefined ? { value } : {}), ...(max !== undefined ? { max } : {}) }); },
  };
};

describe('stageLabel', () => {
  it.each([
    ['CheckpointLoaderSimple', 'Loading model'], ['UnetLoaderGGUF', 'Loading model'], ['LoraLoaderModelOnly', 'Loading model'],
    ['IPAdapterModelLoader', 'Loading model'], ['KSampler', 'Sampling'], ['SamplerCustomAdvanced', 'Sampling'],
    ['VAEDecode', 'Decoding'], ['SaveImage', 'Saving'], ['ImageUpscaleWithModel', 'Upscaling'], ['CLIPTextEncode', 'Preparing'],
  ])('%s → %s', (classType, label) => expect(stageLabel(classType)).toBe(label));
});

describe('ComfyClient.run', () => {
  it('queues the graph, streams named progress and returns the PNG', async () => {
    const rec = recorder();
    const result = await client.run(miniGraph(), { onProgress: rec.onProgress });
    expect(result.promptId).toBe(fake.promptIds[0]);
    expect(result.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.images).toHaveLength(1);
    expect(pngSize(result.images[0]!)).toEqual({ width: 64, height: 48 });
    expect(rec.steps[0]).toEqual({ label: 'Queued' });
    expect(rec.steps.map((s) => s.label)).toContain('Loading model');
    expect(rec.steps).toContainEqual({ label: 'Sampling', value: 3, max: 3 });
    expect(fake.graphs).toEqual([miniGraph()]);
  });

  it('fails permanently with the node errors when ComfyUI rejects the graph', async () => {
    const body = {
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
      node_errors: { '4': { class_type: 'IPAdapterAdvanced', errors: [{ message: 'Value not in list', details: 'weight_type: bogus' }], dependent_outputs: [] } },
    };
    fake.rejectNext = body;
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyRejectedError);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('ComfyUI rejected the graph: Prompt outputs failed validation\nnode 4 (IPAdapterAdvanced): Value not in list: weight_type: bogus');
    expect((err as ComfyRejectedError).details).toEqual(body);
  });

  it('fails permanently when execution fails', async () => {
    fake.failNext = 'CUDA out of memory';
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('ComfyUI failed in KSampler (node 4): CUDA out of memory');
  });

  it('turns a vanished server mid-run into a TransientError', async () => {
    fake.completionDelayMs = 3_000;
    const run = client.run(miniGraph());
    setTimeout(() => { void fake.close(); }, 150);
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
  });

  it('cancels only its own prompt', async () => {
    fake.completionDelayMs = 5_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(client.run(miniGraph(), { signal: controller.signal })).rejects.toThrow();
    const id = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: id } });
  });

  it('reports an unreachable server as transient', async () => {
    const dead = new ComfyClient({ url: 'http://127.0.0.1:9', launcher: null, pollMs: 20 });
    await expect(dead.run(miniGraph())).rejects.toBeInstanceOf(TransientError);
  });
});

describe('ComfyClient helpers', () => {
  it('uploads into input/manga-builder and returns the LoadImage name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comfy-up-'));
    try {
      const file = join(dir, 'im_upload0001.png');
      writeFileSync(file, encodeSolidPng(8, 6));
      await expect(client.uploadImage(file)).resolves.toBe('manga-builder/im_upload0001.png');
      expect(pngSize(fake.uploads.get('manga-builder/im_upload0001.png')!)).toEqual({ width: 8, height: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frees VRAM with unload_models and free_memory, and never throws when down', async () => {
    await client.free();
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/free', body: { unload_models: true, free_memory: true } });
    await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).free()).resolves.toBeUndefined();
  });

  it('never throws from free() when ComfyUI answers but is not up (G2)', async () => {
    fake.up = false;
    await expect(client.free()).resolves.toBeUndefined();
  });

  it('health shows the GPU, or why it is not ok', async () => {
    await expect(client.health()).resolves.toEqual({ ok: true, detail: 'FakeGPU · 15.0 GB free' });
    fake.up = false;
    await expect(client.health()).resolves.toEqual({ ok: false, detail: 'ComfyUI answered 503' });
    await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).health()).resolves.toEqual({ ok: false, detail: 'not reachable at http://127.0.0.1:9' });
  });
});

describe('ComfyClient.ensureServer', () => {
  const stubSpawn = (onStart: () => void): typeof spawn =>
    ((): unknown => {
      onStart();
      return { unref() {}, on() { return this; } };
    }) as unknown as typeof spawn;

  it('does nothing when the server is up', async () => {
    const labels: string[] = [];
    await client.ensureServer((l) => labels.push(l));
    expect(labels).toEqual([]);
  });

  it('is transient without a launcher', async () => {
    fake.up = false;
    await expect(client.ensureServer()).rejects.toBeInstanceOf(TransientError);
  });

  it('starts ComfyUI through the launcher and waits for it', async () => {
    fake.up = false;
    const launcher = new ComfyLauncher({ comfyRoot: fakeComfyRoot(), comfyUrl: fake.url, pollMs: 20, spawnImpl: stubSpawn(() => setTimeout(() => { fake.up = true; }, 100)) });
    const labels: string[] = [];
    await new ComfyClient({ url: fake.url, launcher, pollMs: 20 }).ensureServer((l) => labels.push(l));
    expect(labels).toEqual(['Starting image server']);
  });

  it('gives up after the launcher timeout and names the log', async () => {
    fake.up = false;
    const root = fakeComfyRoot();
    const launcher = new ComfyLauncher({ comfyRoot: root, comfyUrl: fake.url, pollMs: 20, timeoutMs: 600, spawnImpl: stubSpawn(() => {}) });
    const err = await new ComfyClient({ url: fake.url, launcher }).ensureServer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe(`ComfyUI did not come up within 1 s. See ${join(root, 'ComfyUI', 'server.log')}`);
  });
});
