import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceStatus } from '@manga/shared';
import { startServer } from '../src/app.js';
import { OllamaEngine } from '../src/engines/ollama.js';
import { aiModule } from '../src/modules/ai.js';
import { imagingModule } from '../src/modules/imaging.js';
import { servicesFor } from '../src/modules/services.js';
import { startFakeOllama } from './fakes/fake-ollama.js';
import { startM2TestServer, type M2TestServer } from './helpers/m2-server.js';
import { seedManga } from './helpers/seed.js';

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
