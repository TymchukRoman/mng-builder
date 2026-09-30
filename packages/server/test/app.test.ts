import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, type ServerEvent, type Settings } from '@manga/shared';
import { startServer, type AppModule } from '../src/app.js';
import { exitControl } from '../src/exit-control.js';
import { fetchHealth, ownBuildStamp, readServerInfo, writeServerInfo } from '../src/config.js';
import { StoreCorruptError } from '../src/errors.js';
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

  it('GET /api/health reports ok, pid, version and the build stamp fixed at start', async () => {
    expect(await call(t.app, 'GET', '/api/health')).toEqual({ status: 200, body: { ok: true, pid: process.pid, version: '0.1.0', build: ownBuildStamp() } });
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

  it('hides a 500 HttpError (e.g. StoreCorruptError) behind 500 internal, but still logs the raw detail', async () => {
    const mod: AppModule = {
      name: 'fake-store',
      register(app) {
        app.get('/api/corrupt', async () => {
          throw new StoreCorruptError('character', 'cr_secret123', 'column tags is not valid JSON');
        });
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await makeTestApp({ modules: [mod] });
    try {
      const res = await call<ErrorReply>(t.app, 'GET', '/api/corrupt');
      expect(res).toEqual({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } });
      const responseText = JSON.stringify(res.body);
      expect(responseText).not.toContain('cr_secret123');
      expect(responseText).not.toContain('not valid JSON');
      expect(logged).toHaveBeenCalled();
      const loggedText = logged.mock.calls.flat().map(String).join('\n');
      expect(loggedText).toContain('cr_secret123');
      expect(loggedText).toContain('not valid JSON');
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

  it('serves files written into the UI folder after the app started, e.g. by a UI rebuild (F12)', async () => {
    const ui = tempDir('manga-ui-');
    writeFileSync(join(ui.path, 'index.html'), '<!doctype html><title>Manga</title>');
    const t = await makeTestApp({ uiDir: ui.path });
    try {
      mkdirSync(join(ui.path, 'assets'));
      writeFileSync(join(ui.path, 'assets', 'index-B4x9.js'), 'console.log(2)');
      writeFileSync(join(ui.path, 'index.html'), '<!doctype html><title>Manga 2</title>');
      const js = await t.app.inject({ method: 'GET', url: '/assets/index-B4x9.js' });
      expect([js.statusCode, js.body]).toEqual([200, 'console.log(2)']);
      expect((await t.app.inject({ method: 'HEAD', url: '/assets/index-B4x9.js' })).statusCode).toBe(200);
      for (const url of ['/', '/m/mg_abc']) expect((await t.app.inject({ method: 'GET', url })).body, url).toContain('<title>Manga 2</title>');
      expect((await t.app.inject({ method: 'GET', url: '/assets/index-old.js' })).json()).toMatchObject({ error: { code: 'not_found' } });
      expect((await t.app.inject({ method: 'POST', url: '/assets/index-B4x9.js' })).statusCode).toBe(404);
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

describe('POST /api/shutdown', () => {
  it('does not exist on an app built without onShutdown (the test app)', async () => {
    const t = await makeTestApp();
    try {
      expect((await call(t.app, 'POST', '/api/shutdown')).status).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('answers {ok:true} and then calls onShutdown once; refuses callers that are not on this machine', async () => {
    const onShutdown = vi.fn();
    const t = await makeTestApp({ onShutdown });
    try {
      const remote = await t.app.inject({ method: 'POST', url: '/api/shutdown', remoteAddress: '10.0.0.7' });
      expect([remote.statusCode, remote.json()]).toEqual([403, { error: { code: 'forbidden', message: 'shutdown is only accepted from this machine' } }]);
      expect(await call(t.app, 'POST', '/api/shutdown')).toEqual({ status: 200, body: { ok: true } });
      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
      expect((await call(t.app, 'POST', '/api/shutdown')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await t.close();
    }
  });

  it('stops a server started with startServer: health stops answering and server.json goes', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      const res = await fetch(`${server.url}/api/shutdown`, { method: 'POST' });
      expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
      await vi.waitFor(() => expect(readServerInfo(dir.path)).toBeNull());
      expect(await fetchHealth(server.url)).toBeNull();
    } finally {
      await server.stop();
      dir.cleanup();
    }
  });

  it("runs startServer's onShutdown instead when one is given (main.ts exits the process from there)", async () => {
    const dir = tempDir();
    const onShutdown = vi.fn();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null, onShutdown });
    try {
      expect((await fetch(`${server.url}/api/shutdown`, { method: 'POST' })).status).toBe(200);
      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
      expect((await fetchHealth(server.url))?.pid).toBe(process.pid);
    } finally {
      await server.stop();
      dir.cleanup();
    }
  });
});

describe('one server per library (F10)', () => {
  it('refuses to start while server.json names a live server of the library on another port', async () => {
    const dir = tempDir();
    const first = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      await expect(startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null })).rejects.toThrow(
        `library ${dir.path} is already served by pid ${process.pid} at ${first.url}; stop it first (manga stop)`,
      );
      expect((await fetchHealth(first.url))?.pid).toBe(process.pid);
      expect(readServerInfo(dir.path)?.port).toBe(Number(new URL(first.url).port));
    } finally {
      await first.stop();
      dir.cleanup();
    }
  });

  it('starts over a stale server.json whose server is gone', async () => {
    const dir = tempDir();
    writeServerInfo(dir.path, { pid: process.pid, port: 9, startedAt: '2026-09-27T00:00:00.000Z' });
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    try {
      expect(readServerInfo(dir.path)?.port).toBe(Number(new URL(server.url).port));
    } finally {
      await server.stop();
      dir.cleanup();
    }
  });
});

describe('forced shutdown (F11)', () => {
  it('bounds stop(): a job handler that ignores its abort signal cannot hang it', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null, stopTimeoutMs: 200 });
    server.deps.queue.register('export.render', () => new Promise(() => {})); // never settles, ignores ctx.signal
    const job = server.deps.queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    await vi.waitFor(() => expect(server.deps.store.jobs.require(job.id).status).toBe('running'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const started = Date.now();
      await server.stop();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logged).toHaveBeenCalledWith('[manga] modules or job handlers did not stop within 200 ms; closing anyway');
      expect(readServerInfo(dir.path)).toBeNull();
      expect(await fetchHealth(server.url)).toBeNull();
    } finally {
      logged.mockRestore();
      dir.cleanup();
    }
  });
});

describe('exitControl (main.ts)', () => {
  it('stops then exits 0 on the first request; a second signal exits at once with 130', async () => {
    const exits: number[] = [];
    let stops = 0;
    const control = exitControl(() => {
      stops += 1;
      return new Promise(() => {}); // stuck
    }, (code) => exits.push(code), () => {});
    control.request();
    control.signal(); // the first signal only joins the stop in progress
    expect([stops, exits]).toEqual([1, []]);
    control.signal();
    expect([stops, exits]).toEqual([1, [130]]);
  });

  it('exits 0 once stop() resolves, and 1 when it fails', async () => {
    const exits: number[] = [];
    exitControl(async () => {}, (code) => exits.push(code), () => {}).signal();
    const failing = exitControl(async () => {
      throw new Error('boom');
    }, (code) => exits.push(code), () => {});
    failing.request();
    await vi.waitFor(() => expect(exits).toEqual([0, 1]));
  });
});

describe('Host and Origin guard (F13)', () => {
  /** A GET with a hand-picked Host header (fetch always sends the URL's). */
  function getWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { headers: { host } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** 101 when the socket opens (and gets its hello), else the HTTP status the upgrade was refused with. */
  function upgradeStatus(url: string, origin?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, origin === undefined ? {} : { origin });
      ws.on('message', () => {
        ws.close();
        resolve(101);
      });
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      ws.on('error', (err) => {
        if (ws.readyState !== WebSocket.CLOSED) reject(err);
      });
    });
  }

  it('answers only Host 127.0.0.1:<port> or localhost:<port>, and WebSocket upgrades only from those origins', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    const port = new URL(server.url).port;
    try {
      expect((await getWithHost(`${server.url}/api/health`, `localhost:${port}`)).status).toBe(200);
      expect((await getWithHost(`${server.url}/api/health`, `127.0.0.1:${port}`)).status).toBe(200);
      for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `localhost.evil.example:${port}`]) {
        const res = await getWithHost(`${server.url}/api/health`, host);
        expect([res.status, JSON.parse(res.body)], host).toEqual([403, { error: { code: 'forbidden', message: `host ${host} is not allowed` } }]);
      }
      expect(await upgradeStatus(server.url)).toBe(101);
      expect(await upgradeStatus(server.url, `http://localhost:${port}`)).toBe(101);
      expect(await upgradeStatus(server.url, `http://127.0.0.1:${port}`)).toBe(101);
      expect(await upgradeStatus(server.url, 'http://evil.example')).toBe(403);
      expect(await upgradeStatus(server.url, `https://127.0.0.1:${port}`)).toBe(403);
      expect((await fetch(`${server.url}/api/settings`, { headers: { origin: 'http://evil.example' } })).status).toBe(200); // plain HTTP: Origin not checked
    } finally {
      await server.stop();
      dir.cleanup();
    }
  });

  it('applies the Host guard to the static UI files and the SPA fallback, and serves no file outside the UI folder (@fastify/static 10)', async () => {
    const dir = tempDir();
    const outer = tempDir('manga-ui-');
    const uiPath = join(outer.path, 'dist');
    mkdirSync(join(uiPath, 'assets'), { recursive: true });
    writeFileSync(join(uiPath, 'index.html'), '<!doctype html><title>Manga</title>');
    writeFileSync(join(uiPath, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(outer.path, 'manga-outside-secret.txt'), 'SECRET');
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: uiPath });
    const port = new URL(server.url).port;
    try {
      for (const url of ['/', '/assets/app.js', '/m/mg_abc']) {
        const ok = await getWithHost(`${server.url}${url}`, `localhost:${port}`);
        expect(ok.status, url).toBe(200);
        const bad = await getWithHost(`${server.url}${url}`, 'evil.example');
        expect([bad.status, JSON.parse(bad.body)], url).toEqual([403, { error: { code: 'forbidden', message: 'host evil.example is not allowed' } }]);
      }
      // Encoded traversal and a differently cased alias of a real file must never serve it (403 or 404 by platform).
      for (const url of ['/%2e%2e/manga-outside-secret.txt', '/assets/%2e%2e/%2e%2e/manga-outside-secret.txt', '/assets/..%2f..%2fmanga-outside-secret.txt', '/ASSETS/APP.JS']) {
        const res = await getWithHost(`${server.url}${url}`, `localhost:${port}`);
        expect(res.status, url).not.toBe(200);
        expect(res.body, url).not.toContain('SECRET');
        expect(res.body, url).not.toContain('console.log(1)');
      }
    } finally {
      await server.stop();
      outer.cleanup();
      dir.cleanup();
    }
  });

  it('rejects a non-GET/HEAD request whose Origin is foreign, and passes same-origin or Origin-less requests (G4)', async () => {
    const dir = tempDir();
    const server = await startServer({ config: { libraryPath: dir.path, port: 0 }, uiDir: null });
    const port = new URL(server.url).port;
    const post = (origin?: string): Promise<Response> =>
      fetch(`${server.url}/api/mangas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) },
        body: JSON.stringify({ title: 'Cross-site' }),
      });
    try {
      const foreign = await post('http://evil.example');
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toEqual({ error: { code: 'forbidden', message: 'origin http://evil.example is not allowed' } });

      expect((await post(`http://localhost:${port}`)).status).toBe(200);
      expect((await post(`http://127.0.0.1:${port}`)).status).toBe(200);
      expect((await post(undefined)).status).toBe(200); // Origin-less, e.g. the CLI
    } finally {
      await server.stop();
      dir.cleanup();
    }
  });
});
