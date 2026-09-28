import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, JobRef, ServiceStatus } from '@manga/shared';
import { startServer } from '../src/app.js';
import { OllamaEngine } from '../src/engines/ollama.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { ComfyLauncher } from '../src/imaging/launcher.js';
import { aiModule } from '../src/modules/ai.js';
import { imagingModule } from '../src/modules/imaging.js';
import { servicesFor } from '../src/modules/services.js';
import { startFakeOllama } from './fakes/fake-ollama.js';
import { fakeComfyRoot } from './helpers/comfy-root.js';
import { startM2TestServer, type M2TestServer } from './helpers/m2-server.js';
import { seedImage, seedManga } from './helpers/seed.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url));

let server: M2TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('M2 modules', () => {
  it('report real service status', async () => {
    server = await startM2TestServer();
    const status = await server.api<ServiceStatus>('GET', '/api/status');
    expect(status.body.claude).toEqual({ ok: true, detail: 'scripted claude engine (fakes)' });
    expect(status.body.ollama).toEqual({ ok: true, detail: 'scripted local engine (fakes)' });
    expect(status.body.comfy).toEqual({ ok: true, detail: 'FakeGPU · 15.0 GB free' });
  });

  it('register the imaging job handlers on the queue', async () => {
    server = await startM2TestServer();
    const { panels } = seedManga(server.deps.store);
    const job = server.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: panels[0]!.id } });
    const done = await server.deps.queue.waitFor(job.id);
    expect(done.status).toBe('succeeded');
    expect(server.deps.store.panels.require(panels[0]!.id).activeImageId).toBe((done.result as { imageId: string }).imageId);
  });

  it('free the other side of the GPU when the owner changes', async () => {
    const ollama = await startFakeOllama();
    try {
      server = await startM2TestServer({
        services: (deps) => ({ local: new OllamaEngine({ url: ollama.url, models: () => deps.store.settings.get().ollama, gpu: deps.gpu }) }),
      });
      await server.deps.gpu.acquire('comfy');
      await server.deps.gpu.acquire('ollama');
      expect(server.fake.calls).toContainEqual({ method: 'POST', path: '/free', body: { unload_models: true, free_memory: true } });
      ollama.loaded.add('qwen3:14b');
      await server.deps.gpu.acquire('comfy');
      expect(ollama.requests.filter((r) => r.path === '/api/generate').map((r) => r.body)).toEqual([{ model: 'qwen3:14b', keep_alive: 0 }]);
    } finally {
      await ollama.close();
    }
  });

  it('hand the GPU to ollama only after ComfyUI has actually dropped its VRAM (M2)', async () => {
    server = await startM2TestServer();
    await server.deps.gpu.acquire('comfy');
    server.fake.torchVramTotal = 14e9;
    server.fake.freeDelayMs = 100;
    await server.deps.gpu.acquire('ollama');
    expect(server.fake.calls.filter((c) => c.path === '/free')).toHaveLength(1);
    expect(server.fake.torchVramTotal).toBe(0);
  });

  it('a job cancelled while ComfyUI is starting frees the gpu lane at once (M5)', async () => {
    const dead = 'http://127.0.0.1:9';
    const spawnImpl = ((): unknown => ({ unref() {}, on() { return this; } })) as unknown as typeof spawn;
    server = await startM2TestServer({
      services: () => ({
        comfy: new ComfyClient({
          url: dead, pollMs: 20, launcher: new ComfyLauncher({ comfyRoot: fakeComfyRoot(), comfyUrl: dead, pollMs: 20, timeoutMs: 3_000, spawnImpl }),
        }),
      }),
    });
    const { store, queue } = server.deps;
    store.settings.patch({ engine: { mode: 'local' } }); // the review below then queues in the gpu lane, behind the generate
    const { manga, panels } = seedManga(store);
    const image = seedImage(store, manga.id, { type: 'panel', id: panels[1]!.id }, null);
    const generate = (await server.api<JobRef>('POST', `/api/panels/${panels[0]!.id}/generate`, {})).body.jobId;
    for (let i = 0; i < 200 && store.jobs.require(generate).progress?.label !== 'Starting image server'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.jobs.require(generate).progress?.label).toBe('Starting image server');
    const review = queue.enqueue({ kind: 'image.review', lane: 'gpu', payload: { imageId: image.id, panelId: panels[1]!.id } });
    const started = Date.now();
    expect((await server.api<Job>('POST', `/api/jobs/${generate}/cancel`)).body.status).toBe('cancelled');
    expect((await queue.waitFor(review.id)).status).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('pause the claude lane until the reported reset when Claude is out of quota', async () => {
    const record = join(tmpdir(), `claude-record-${process.pid}-${Date.now()}.json`);
    server = await startM2TestServer({
      realClaude: true,
      config: { claudeBin: process.execPath },
      services: () => ({ claudeBinArgs: [FAKE_CLAUDE, fixture('rate-limited'), record] }),
    });
    const { panels } = seedManga(server.deps.store);
    server.deps.queue.enqueue({ kind: 'llm.step', lane: 'claude', payload: { type: 'panel-prompt', panelId: panels[0]!.id } });
    let paused = server.deps.queue.pausedLanes();
    for (let i = 0; i < 200 && paused.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      paused = server.deps.queue.pausedLanes();
    }
    expect(paused).toEqual([{ lane: 'claude', until: '2100-01-01T00:00:00.000Z', reason: 'Claude quota exhausted (five_hour window)' }]);
  });

  it('an engine switch re-lanes queued text jobs, and a moved job runs on the local engine in the gpu lane (I1)', async () => {
    const lanesAtLocalCall: string[][] = [];
    server = await startM2TestServer({
      local: {
        'panel-prompt': () => {
          lanesAtLocalCall.push(server!.deps.store.jobs.list({ status: 'running', limit: 10 }).map((j) => j.lane));
          return { scene: 'solo, standing, rooftop' };
        },
      },
    });
    const { store, queue, bus } = server.deps;
    const { manga, panels } = seedManga(store);
    const image = seedImage(store, manga.id, { type: 'panel', id: panels[1]!.id }, null);
    store.panels.update(panels[1]!.id, { activeImageId: image.id });
    // The quota banner case: Claude is paused for hours, and the user flips the engine to Local.
    queue.pauseLane('claude', new Date('2100-01-01T00:00:00.000Z'), 'Claude quota exhausted');
    const prompt = (await server.api<JobRef>('POST', `/api/panels/${panels[0]!.id}/prompt`)).body.jobId;
    const review = (await server.api<JobRef>('POST', `/api/panels/${panels[1]!.id}/review`)).body.jobId;
    expect([store.jobs.require(prompt).lane, store.jobs.require(review).lane]).toEqual(['claude', 'claude']);

    const events: Job[] = [];
    bus.on((e) => { if (e.type === 'job') events.push(e.job); });
    // Prompts go local; review stays on Claude by a per-task override.
    expect((await server.api('PATCH', '/api/settings', { engine: { mode: 'local', tasks: { review: 'claude' } } })).status).toBe(200);
    expect(events.filter((j) => j.id === prompt).map((j) => [j.lane, j.status])[0]).toEqual(['gpu', 'queued']);
    expect(events.some((j) => j.id === review)).toBe(false);

    expect(await queue.waitFor(prompt)).toMatchObject({ lane: 'gpu', status: 'succeeded' });
    expect(server.local.calls.map((c) => c.name)).toEqual(['panel-prompt']);
    expect(lanesAtLocalCall).toEqual([['gpu']]);
    expect(server.claude.calls).toEqual([]);
    expect(store.jobs.require(review)).toMatchObject({ lane: 'claude', status: 'queued' });
  });

  it('MANGA_FAKES=1 wires FakeComfy and scripted engines with no options at all', async () => {
    const library = mkdtempSync(join(tmpdir(), 'manga-fakes-'));
    process.env['MANGA_FAKES'] = '1';
    const started = await startServer({ config: { libraryPath: library, port: 0 }, modules: (d) => [aiModule(d), imagingModule(d)] });
    try {
      const status = (await (await fetch(`${started.url}/api/status`)).json()) as ServiceStatus;
      expect(status.comfy.detail).toContain('FakeGPU');
      expect(status.claude.detail).toBe('scripted claude engine (fakes)');
      const { panels } = seedManga(started.deps.store);
      const job = started.deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: panels[0]!.id } });
      expect((await started.deps.queue.waitFor(job.id)).status).toBe('succeeded');
      expect(servicesFor(started.deps).fakeComfy).not.toBeNull();
    } finally {
      delete process.env['MANGA_FAKES'];
      await started.stop();
      rmSync(library, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
