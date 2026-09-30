import type { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyClient, ComfyRejectedError, FIRST_PROGRESS_TIMEOUT_MS, STALL_TIMEOUT_MS, stageLabel } from '../src/imaging/comfy.js';
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
    fake.failNext = 'mat1 and mat2 shapes cannot be multiplied';
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('ComfyUI failed in KSampler (node 4): mat1 and mat2 shapes cannot be multiplied');
  });

  it('frees VRAM and retries (transient) when a run runs out of GPU memory (M4)', async () => {
    fake.failNext = 'Allocation on device 0 would exceed allowed memory. (out of memory)';
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toContain('out of memory');
    const promptAt = fake.calls.findIndex((c) => c.path === '/prompt');
    expect(fake.calls.findIndex((c, i) => i > promptAt && c.path === '/free')).toBeGreaterThan(promptAt);
  });

  it('treats a run interrupted by another client as transient (M4)', async () => {
    fake.interruptNext = true;
    const err = await client.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe('ComfyUI run was interrupted');
  });

  it('gives up on a prompt ComfyUI lost (in neither the queue nor the history) as transient (M4)', async () => {
    fake.dropNext = true;
    const lossy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 5 });
    const err = await lossy.run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe('ComfyUI lost the prompt');
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path === '/queue')).toHaveLength(1); // every 10 polls
  });

  it('keeps waiting while the prompt is still in the queue (M4)', async () => {
    // Deterministic: the fake only completes once 3 liveness GET /queue calls have happened, instead of racing a
    // fixed real-time delay against the poll loop (pollMs 5, a liveness check every 10 polls) — that raced two
    // independent real timers and flaked under full-suite CPU load, where a single poll's real HTTP round trip can
    // take far longer than pollMs, so too few polls (and liveness checks) fit before a wall-clock delay elapsed.
    fake.completeAfterQueuePolls = 3;
    const patient = new ComfyClient({ url: fake.url, launcher: null, pollMs: 5 });
    const result = await patient.run(miniGraph());
    expect(result.images).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path === '/queue').length).toBeGreaterThanOrEqual(3);
  });

  it('turns a vanished server mid-run into a TransientError', async () => {
    fake.completionDelayMs = 3_000;
    const run = client.run(miniGraph());
    setTimeout(() => { void fake.close(); }, 150);
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
  });

  it('cancels its prompt on any failure after ComfyUI accepted it, so a retry never double-queues (M6)', async () => {
    fake.completionDelayMs = 3_000;
    const run = client.run(miniGraph());
    setTimeout(() => { fake.up = false; }, 150); // every route now answers 503: a transient failure mid-poll
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    const id = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: id } });

    fake.up = true;
    fake.rejectNext = { error: { type: 'x', message: 'bad graph' }, node_errors: {} };
    const before = fake.calls.filter((c) => c.method === 'POST' && c.path === '/queue').length;
    await expect(client.run(miniGraph())).rejects.toBeInstanceOf(ComfyRejectedError);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/queue')).toHaveLength(before); // never queued
  });

  it('does not cancel or interrupt a prompt whose history already reached a terminal state (R3)', async () => {
    fake.failNext = 'boom'; // the run errors on its own, before anything asks to cancel it
    await expect(client.run(miniGraph())).rejects.toThrow('boom');
    const id = fake.promptIds[0]!;
    expect(fake.calls).not.toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    expect(fake.calls).not.toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: id } });
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

  it('aborts before the prompt is submitted when the signal fires immediately, never reporting it as transient', async () => {
    const controller = new AbortController();
    const run = client.run(miniGraph(), { signal: controller.signal });
    // Synchronous, right after starting run(): its first await is openSocket(), so this always lands
    // while the socket is still connecting — before the /prompt POST is ever sent.
    controller.abort();
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    // request() must never turn a caller abort into a TransientError: it must always be the abort error.
    expect(err).not.toBeInstanceOf(TransientError);
    if (fake.promptIds.length > 0) {
      // If the POST still slipped out (timing-dependent), the cancel path must still run for that id.
      const id = fake.promptIds[0]!;
      expect(fake.calls).toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    } else {
      expect(fake.calls.some((c) => c.path === '/prompt')).toBe(false);
    }
  });
});

describe('ComfyClient.run stall watchdog', () => {
  const watched = (over: { firstProgressTimeoutMs?: number; stallTimeoutMs?: number } = {}): ComfyClient =>
    new ComfyClient({ url: fake.url, launcher: null, pollMs: 10, firstProgressTimeoutMs: 5_000, stallTimeoutMs: 250, ...over });

  it('defaults to 10 min before the first step and 3 min between later signals', () => {
    expect(FIRST_PROGRESS_TIMEOUT_MS).toBe(10 * 60_000);
    expect(STALL_TIMEOUT_MS).toBe(3 * 60_000);
  });

  it('interrupts a prompt that goes silent mid-sampling, frees the models and fails transiently', async () => {
    fake.stallNext = 1; // one sampling step, then nothing (VRAM spilled to system RAM)
    const rec = recorder();
    const err = await watched().run(miniGraph(), { onProgress: rec.onProgress }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/^GPU stalled: no progress for 250 ms \(GPU memory is probably full; close games or other GPU apps\)$/);
    const id = fake.promptIds[0]!;
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: id } });
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/queue', body: { delete: [id] } });
    const interruptAt = fake.calls.findIndex((c) => c.path === '/interrupt');
    const freeAt = fake.calls.findIndex((c) => c.path === '/free');
    expect(freeAt).toBeGreaterThan(interruptAt);
    expect(fake.calls[freeAt]!.body).toEqual({ unload_models: true, free_memory: true });
    expect(rec.steps.map((s) => s.label)).toContain((err as Error).message);
  });

  it('gives up on a prompt that never reaches its first step within the first-progress limit', async () => {
    fake.stallNext = 0; // loads, then never samples
    const err = await watched({ firstProgressTimeoutMs: 300, stallTimeoutMs: 60_000 }).run(miniGraph()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/^GPU stalled: no progress for 300 ms after queueing/);
    expect(fake.calls.some((c) => c.path === '/free')).toBe(true);
  });

  it('does not kill a run with a long model load and steady progress afterwards', async () => {
    fake.loadDelayMs = 700; // longer than the stall limit, well inside the first-progress limit
    fake.steps = 8;
    fake.stepDelayMs = 60; // 8 steps take ~480 ms in all, each gap well inside the 250 ms stall limit
    const result = await watched().run(miniGraph());
    expect(result.images).toHaveLength(1);
    expect(fake.calls.some((c) => c.path === '/interrupt' || c.path === '/free')).toBe(false);
  });

  it('warns in the progress label when little VRAM is left for ComfyUI, and still runs', async () => {
    fake.vramFree = 1.2e9;
    const rec = recorder();
    const result = await client.run(miniGraph(), { onProgress: rec.onProgress });
    expect(result.images).toHaveLength(1);
    expect(rec.steps[0]).toEqual({ label: 'GPU memory low (1.2 GB free) — another app may be using the GPU' });
    expect(rec.steps).toContainEqual({ label: 'Sampling · GPU memory low', value: 3, max: 3 });
  });

  it('does not count VRAM that ComfyUI itself holds (its own resident model) as taken', async () => {
    fake.vramFree = 1e9;
    fake.torchVramTotal = 12e9;
    const rec = recorder();
    await client.run(miniGraph(), { onProgress: rec.onProgress });
    expect(rec.steps.some((s) => s.label.includes('GPU memory low'))).toBe(false);
    expect(rec.steps[0]).toEqual({ label: 'Queued' });
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

  it('frees VRAM with unload_models and free_memory, and never throws when unreachable (G2), but logs it', async () => {
    await client.free();
    expect(fake.calls).toContainEqual({ method: 'POST', path: '/free', body: { unload_models: true, free_memory: true } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).free()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not reachable at http://127.0.0.1:9'), expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws from free() when ComfyUI answers but is not up (G2), but logs it', async () => {
    fake.up = false;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(client.free()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(`${fake.url} answered 503`));
    } finally {
      spy.mockRestore();
    }
  });

  it('health shows the GPU, or why it is not ok', async () => {
    await expect(client.health()).resolves.toEqual({ ok: true, detail: 'FakeGPU · 15.0 GB free' });
    fake.up = false;
    await expect(client.health()).resolves.toEqual({ ok: false, detail: 'ComfyUI answered 503' });
    await expect(new ComfyClient({ url: 'http://127.0.0.1:9' }).health()).resolves.toEqual({ ok: false, detail: 'not reachable at http://127.0.0.1:9' });
  });
});

describe('ComfyClient.prepareFor', () => {
  it('does not free on the first call, nor on repeat calls with the same family', async () => {
    await client.prepareFor('sdxl');
    await client.prepareFor('sdxl');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(0);
  });

  it('frees once and waits for the reported VRAM to drop when the family changes', async () => {
    await client.prepareFor('sdxl');
    fake.torchVramTotal = 14e9;
    fake.freeDelayMs = 60;
    const before = Date.now();
    await client.prepareFor('qwen');
    const elapsed = Date.now() - before;
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
    // pollMs is 20 here; the fake only drops torchVramTotal after 60ms, so prepareFor must have polled at
    // least a couple of times before returning.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(fake.torchVramTotal).toBe(0);
    const statsCalls = fake.calls.filter((c) => c.path === '/system_stats');
    expect(statsCalls.length).toBeGreaterThan(0);
  });

  it('does not free again on a third call with the same (new) family', async () => {
    await client.prepareFor('sdxl');
    await client.prepareFor('qwen');
    await client.prepareFor('qwen');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
  });

  it('after a restart, the first call frees (and waits) when ComfyUI still holds VRAM (M1)', async () => {
    fake.torchVramTotal = 14e9;
    fake.freeDelayMs = 40;
    await client.prepareFor('qwen');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
    expect(fake.torchVramTotal).toBe(0);
    await client.prepareFor('qwen');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
  });

  it('treats upscale as family-neutral: no free, and the last family stays (M3a)', async () => {
    fake.torchVramTotal = 14e9;
    await client.prepareFor('upscale'); // unknown family, VRAM full: still nothing to free for a tiny upscale model
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(0);
    fake.torchVramTotal = 0;
    await client.prepareFor('sdxl');
    await client.prepareFor('upscale');
    await client.prepareFor('sdxl');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(0);
    await client.prepareFor('upscale');
    await client.prepareFor('qwen');
    expect(fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
  });

  it('release() frees and waits for the drop; an aborted signal ends the wait at once (M2, M5)', async () => {
    fake.torchVramTotal = 14e9;
    fake.freeDelayMs = 60;
    await client.release();
    expect(fake.torchVramTotal).toBe(0);

    fake.torchVramTotal = 14e9;
    fake.freeDelayMs = 10_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const err = await client.release(controller.signal).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1_000);
    const prepare = new AbortController();
    prepare.abort();
    await expect(client.prepareFor('anima', prepare.signal)).rejects.toThrow();
  });

  it('never throws when ComfyUI becomes unreachable during the wait (G2)', async () => {
    await client.prepareFor('sdxl');
    await fake.close();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // free() logs the unreachable server (G2)
    try {
      await expect(client.prepareFor('qwen')).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('comfy free: not reachable'), expect.anything());
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ComfyClient VRAM wait bound (M3b)', () => {
  it('is a hard bound even when every /system_stats answer is slow', async () => {
    const slow = createServer((req, res) => {
      if (req.url === '/free') {
        res.writeHead(200);
        res.end();
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ devices: [{ torch_vram_total: 14e9 }] }));
      }, 400);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = slow.address() as AddressInfo;
      const slowClient = new ComfyClient({ url: `http://127.0.0.1:${port}`, launcher: null, pollMs: 20, vramWaitMs: 500 });
      const started = Date.now();
      await slowClient.release();
      const elapsed = Date.now() - started;
      // Without the bound the second poll starts at ~420 ms and answers at ~820 ms.
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(700);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

describe('ComfyClient history polling', () => {
  // FakeComfy's /history/<id> route always answers 200 (with {} for an unknown id), so an unexpected
  // status can't be produced through it. This uses a bare HTTP stand-in to exercise the guard directly.
  it('treats a non-OK, non-5xx /history response as permanent, never parsing it as a history entry', async () => {
    const odd = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = odd.address() as AddressInfo;
      const oddClient = new ComfyClient({ url: `http://127.0.0.1:${port}`, launcher: null, pollMs: 20 });
      const internals = oddClient as unknown as { waitForHistory(promptId: string, signal?: AbortSignal): Promise<unknown> };
      const err = await internals.waitForHistory('any-id').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect((err as Error).message).toBe('ComfyUI /history/any-id answered 404');
    } finally {
      await new Promise<void>((resolve) => odd.close(() => resolve()));
    }
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

  it('an aborted signal ends the wait for a starting ComfyUI at once (M5)', async () => {
    fake.up = false;
    const launcher = new ComfyLauncher({ comfyRoot: fakeComfyRoot(), comfyUrl: fake.url, pollMs: 20, timeoutMs: 3_000, spawnImpl: stubSpawn(() => {}) });
    const starting = new ComfyClient({ url: fake.url, launcher, pollMs: 20 });
    const controller = new AbortController();
    const labels: string[] = [];
    const started = Date.now();
    const run = starting.ensureServer((l) => { labels.push(l); setTimeout(() => controller.abort(), 50); }, controller.signal);
    const err = await run.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1_000);
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

describe('ComfyClient cleans its copies out of the ComfyUI folder (I3)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'comfy-data-'));
    fake.dataDir = dataDir;
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const prefixed = (): ComfyGraph => ({ ...miniGraph(), '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'manga-builder/mg_a/pn_b' } } });
  const cleaning = (): ComfyClient => new ComfyClient({ url: fake.url, launcher: null, pollMs: 20, dataDir });

  it('removes the output file once the run has downloaded it', async () => {
    const result = await cleaning().run(prefixed());
    expect(pngSize(result.images[0]!)).toEqual({ width: 64, height: 48 });
    const outDir = join(dataDir, 'output', 'manga-builder', 'mg_a');
    expect(existsSync(outDir)).toBe(true); // ComfyUI (the fake) did save it there
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('leaves the ComfyUI folder alone without a dataDir (fakes, tests)', async () => {
    await client.run(prefixed());
    expect(readdirSync(join(dataDir, 'output', 'manga-builder', 'mg_a'))).toEqual(['pn_b_00001_.png']);
    await expect(client.removeInputs(['manga-builder/pn_b_00001_.png'])).resolves.toBeUndefined();
  });

  it('removeInputs removes uploads inside input/, refuses traversal, and ignores missing files', async () => {
    const source = join(dataDir, 'im_upload0002.png');
    writeFileSync(source, encodeSolidPng(4, 4));
    const comfy = cleaning();
    const name = await comfy.uploadImage(source);
    const uploaded = join(dataDir, 'input', 'manga-builder', 'im_upload0002.png');
    expect(existsSync(uploaded)).toBe(true);
    const outside = join(dataDir, 'x.png');
    writeFileSync(outside, 'not ours');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(comfy.removeInputs([name, '../x.png', 'manga-builder/missing.png'])).resolves.toBeUndefined();
      expect(existsSync(uploaded)).toBe(false);
      expect(existsSync(outside)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain('../x.png');
    } finally {
      spy.mockRestore();
    }
  });

  it('never deletes outside output/ whatever the history entry says, and never fails the run over it', async () => {
    const outside = join(dataDir, 'x.png');
    writeFileSync(outside, 'not ours');
    mkdirSync(join(dataDir, 'output'), { recursive: true });
    const internals = cleaning() as unknown as { removeOutputs(entry: unknown): Promise<void> };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(internals.removeOutputs({ outputs: { '9': { images: [{ filename: 'x.png', subfolder: '..', type: 'output' }] } } })).resolves.toBeUndefined();
      expect(existsSync(outside)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
