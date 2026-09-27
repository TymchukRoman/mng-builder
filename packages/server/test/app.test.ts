import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, type ServerEvent, type Settings } from '@manga/shared';
import { startServer, type AppModule } from '../src/app.js';
import { readServerInfo } from '../src/config.js';
import { call, makeTestApp, type TestApp } from './helpers/app.js';
import { tempDir } from './helpers/tmp.js';

type ErrorReply = { error: { code: string; message: string } };

describe('system routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('GET /api/health reports ok, pid and version', async () => {
    expect(await call(t.app, 'GET', '/api/health')).toEqual({ status: 200, body: { ok: true, pid: process.pid, version: '0.1.0' } });
  });

  it('GET /api/status reports unconfigured services and the queue', async () => {
    t.deps.queue.pauseLane('claude', null, 'quota exhausted');
    const off = { ok: false, detail: 'not configured' };
    expect((await call(t.app, 'GET', '/api/status')).body).toEqual({
      claude: off, ollama: off, comfy: off,
      queue: { queued: 0, running: 0, pausedLanes: [{ lane: 'claude', until: null, reason: 'quota exhausted' }] },
    });
  });

  it('reports a throwing status provider as down instead of failing the request', async () => {
    t.deps.statusProviders.comfy = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await call<{ comfy: unknown }>(t.app, 'GET', '/api/status')).body.comfy).toEqual({ ok: false, detail: 'ECONNREFUSED' });
  });

  it('GET/PATCH /api/settings validates, persists and emits an entity event', async () => {
    const events: ServerEvent[] = [];
    t.deps.bus.on((e) => events.push(e));
    expect((await call(t.app, 'GET', '/api/settings')).body).toEqual(DEFAULT_SETTINGS);
    expect((await call<Settings>(t.app, 'PATCH', '/api/settings', { engine: { mode: 'local' } })).body.engine.mode).toBe('local');
    expect((await call<Settings>(t.app, 'GET', '/api/settings')).body.engine.mode).toBe('local');
    expect(events).toEqual([{ type: 'entity', entity: 'settings', id: 'settings', op: 'updated', mangaId: null }]);
    const bad = await call<ErrorReply>(t.app, 'PATCH', '/api/settings', { review: { rounds: 99 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toContain('review.rounds');
  });

  it('GET /api/layouts and /api/style-presets', async () => {
    const layouts = await call<Array<{ name: string; panelCount: number }>>(t.app, 'GET', '/api/layouts');
    expect(layouts.body).toHaveLength(16);
    expect(layouts.body.find((l) => l.name === '2x3')).toEqual({ name: '2x3', panelCount: 6 });
    const styles = await call<Array<{ id: string }>>(t.app, 'GET', '/api/style-presets');
    expect(styles.body.map((s) => s.id)).toEqual(['manga-bw', 'manga-hatching', 'anime-color', 'anima-bw']);
  });

  it('GET /api/config returns the read-only AppConfig', async () => {
    const res = await call<{ libraryPath: string; port: number; comfyRoot: string; comfyUrl: string; ollamaUrl: string; claudeBin: string }>(t.app, 'GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(t.deps.config);
    expect(Object.keys(res.body).sort()).toEqual(['claudeBin', 'comfyRoot', 'comfyUrl', 'libraryPath', 'ollamaUrl', 'port']);
  });

  it('does not register GET /api/recipes (M2 owns that route)', async () => {
    expect(await call(t.app, 'GET', '/api/recipes')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('answers unknown routes and malformed JSON with an ApiErrorBody', async () => {
    expect(await call(t.app, 'GET', '/api/nope')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { 'content-type': 'application/json' }, payload: '{ nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });
});

describe('modules', () => {
  it('can register GET /api/recipes without a duplicate-route error, and internal errors are hidden behind 500 internal', async () => {
    const mod: AppModule = {
      name: 'fake-imaging',
      register(app) {
        app.get('/api/recipes', async () => [{ id: 'anime' }]);
        app.get('/api/boom', async () => {
          throw new Error('SQLITE_CORRUPT at C:/secret/path');
        });
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await makeTestApp({ modules: [mod] });
    try {
      expect((await call(t.app, 'GET', '/api/recipes')).body).toEqual([{ id: 'anime' }]);
      expect(await call(t.app, 'GET', '/api/boom')).toEqual({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await t.close();
    }
  });
});

describe('UI static files', () => {
  it('serves packages/ui/dist with an SPA fallback when it exists', async () => {
    const ui = tempDir('manga-ui-');
    mkdirSync(join(ui.path, 'assets'));
    writeFileSync(join(ui.path, 'index.html'), '<!doctype html><title>Manga</title>');
    writeFileSync(join(ui.path, 'assets', 'app.js'), 'console.log(1)');
    const t = await makeTestApp({ uiDir: ui.path });
    try {
      for (const url of ['/', '/m/mg_abc/c/ch_def', '/settings']) {
        const res = await t.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.body).toContain('<title>Manga</title>');
      }
      const js = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
      expect([js.statusCode, js.body]).toEqual([200, 'console.log(1)']);
      for (const url of ['/assets/missing.js', '/api/nope', '/files/nope']) {
        const res = await t.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
      }
    } finally {
      await t.close();
      ui.cleanup();
    }
  });

  it('serves no UI when the folder does not exist', async () => {
    const t = await makeTestApp({ uiDir: join(tmpdir(), 'manga-no-ui-here') });
    try {
      expect((await t.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe('startServer', () => {
  it('listens on 127.0.0.1, writes server.json, streams events with hello first, and cleans up on stop', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(readServerInfo(dir.path)).toMatchObject({ pid: process.pid, port: Number(new URL(server.url).port) });
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
      const messages: ServerEvent[] = [];
      const ws = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/events`);
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (raw) => {
          messages.push(JSON.parse(String(raw)) as ServerEvent);
          if (messages.length === 1) {
            void fetch(`${server.url}/api/settings`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: { mode: 'local' } }),
            });
          }
          if (messages.length === 2) resolve();
        });
        ws.on('error', reject);
      });
      ws.close();
      expect(messages[0]).toMatchObject({ type: 'hello' });
      expect(messages[1]).toEqual({ type: 'entity', entity: 'settings', id: 'settings', op: 'updated', mangaId: null });
    } finally {
      await server.stop();
    }
    expect(readServerInfo(dir.path)).toBeNull();
    dir.cleanup();
  });

  it('runs module register/start/stop hooks and starts the job queue', async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const server = await startServer({
      config: { libraryPath: dir.path, port: 0 },
      uiDir: null,
      modules: (deps) => [{
        name: 'probe',
        register: () => {
          calls.push('register');
        },
        start: () => {
          calls.push('start');
          deps.queue.register('export.render', async () => ({ files: [] }));
        },
        stop: () => {
          calls.push('stop');
        },
      }],
    });
    try {
      const job = server.deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
      expect((await server.deps.queue.waitFor(job.id)).status).toBe('succeeded');
    } finally {
      await server.stop();
      dir.cleanup();
    }
    expect(calls).toEqual(['register', 'start', 'stop']);
  });

  it('fails with EADDRINUSE on a busy port without touching the running server', async () => {
    const dir = tempDir();
    const first = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      first.deps.queue.register('export.render', (ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(null));
      }));
      const job = first.deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
      await vi.waitFor(() => expect(first.deps.store.jobs.require(job.id).status).toBe('running'));
      const port = Number(new URL(first.url).port);
      await expect(startServer({ config: { libraryPath: dir.path, port }, uiDir: null })).rejects.toThrow(/EADDRINUSE/);
      expect(first.deps.store.jobs.require(job.id).status).toBe('running');
      expect(readServerInfo(dir.path)?.port).toBe(port);
    } finally {
      await first.stop();
      dir.cleanup();
    }
  });
});
