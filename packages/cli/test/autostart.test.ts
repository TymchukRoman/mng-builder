import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigSchema, type AppConfig } from '@manga/shared';
import { writeServerInfo } from '@manga/server/config';
import { ensureServer, probeHealth, type EnsureDeps } from '../src/autostart.js';
import { CliError } from '../src/errors.js';
import { startHarness } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function library(): string {
  const d = mkdtempSync(join(tmpdir(), 'manga-auto-'));
  dirs.push(d);
  return d;
}
const config = (libraryPath: string, port = 4317): AppConfig => AppConfigSchema.parse({ libraryPath, port });
const CURRENT = 'build-2';

/**
 * A fake world: a clock advanced by sleep, a health check answering per URL with a build stamp (a spawned server runs
 * the CURRENT build), a spawn that may bring the server up, and a stop that takes a server down.
 */
function fakeDeps(opts: { healthy?: (url: string) => boolean; upAfterSpawn?: boolean; build?: string | null } = {}) {
  let clock = 0;
  let up = false;
  const down = new Set<string>();
  const probes: string[] = [];
  const spawned: string[] = [];
  const stopped: Array<[string, number]> = [];
  const deps: EnsureDeps = {
    health: async (url) => {
      probes.push(url);
      if (up) return { ok: true, pid: 5151, version: '0.1.0', build: CURRENT };
      const alive = !down.has(url) && (opts.healthy?.(url) ?? false);
      return alive ? { ok: true, pid: 4242, version: '0.1.0', build: opts.build === undefined ? CURRENT : opts.build } : null;
    },
    build: () => CURRENT,
    spawnServer: (lib) => {
      spawned.push(lib);
      if (opts.upAfterSpawn) up = true;
    },
    stopServer: async (url, pid) => {
      stopped.push([url, pid]);
      down.add(url);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, probes, spawned, stopped };
}

describe('ensureServer', () => {
  it('uses the server recorded in server.json without spawning', async () => {
    const lib = library();
    writeServerInfo(lib, { pid: 1, port: 5555, startedAt: 'x' });
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:5555' });
    expect(await ensureServer({ config: config(lib), deps: f.deps })).toBe('http://127.0.0.1:5555');
    expect(f.spawned).toEqual([]);
  });

  it('uses the configured port when server.json is missing', async () => {
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:4317' });
    expect(await ensureServer({ config: config(library()), deps: f.deps })).toBe('http://127.0.0.1:4317');
    expect(f.spawned).toEqual([]);
  });

  it('spawns the server when nothing answers, then uses the configured port rather than a stale server.json', async () => {
    const lib = library();
    writeServerInfo(lib, { pid: 1, port: 5555, startedAt: 'x' });
    const f = fakeDeps({ upAfterSpawn: true });
    expect(await ensureServer({ config: config(lib, 4999), deps: f.deps })).toBe('http://127.0.0.1:4999');
    expect(f.spawned).toEqual([lib]);
    expect(f.probes.slice(0, 2)).toEqual(['http://127.0.0.1:5555', 'http://127.0.0.1:4999']);
  });

  it('gives up after 30 s and points at the server log', async () => {
    const f = fakeDeps();
    const err = await ensureServer({ config: config(library()), deps: f.deps }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/did not answer at http:\/\/127\.0\.0\.1:4317 within 30 s; see .*server\.log$/);
    expect(f.spawned).toHaveLength(1);
  });

  it('never spawns for an explicit --url', async () => {
    const f = fakeDeps();
    await expect(ensureServer({ url: 'http://127.0.0.1:7777/', deps: f.deps })).rejects.toThrow('server not reachable at http://127.0.0.1:7777');
    expect(f.spawned).toEqual([]);
  });

  it('stops a server that runs an outdated build and starts the current one, with one line for the user (F2)', async () => {
    const lib = library();
    writeServerInfo(lib, { pid: 4242, port: 5555, startedAt: 'x' });
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:5555', build: 'build-1', upAfterSpawn: true });
    const lines: string[] = [];
    expect(await ensureServer({ config: config(lib), deps: f.deps, log: (line) => lines.push(line) })).toBe('http://127.0.0.1:4317');
    expect(f.stopped).toEqual([['http://127.0.0.1:5555', 4242]]);
    expect(f.spawned).toEqual([lib]);
    expect(lines).toEqual(['restarting the manga server (pid 4242): it runs an outdated build']);
  });

  it('also restarts a server too old to report a build at all', async () => {
    const f = fakeDeps({ healthy: (url) => url === 'http://127.0.0.1:4317', build: null, upAfterSpawn: true });
    expect(await ensureServer({ config: config(library()), deps: f.deps })).toBe('http://127.0.0.1:4317');
    expect(f.stopped).toEqual([['http://127.0.0.1:4317', 4242]]);
    expect(f.spawned).toHaveLength(1);
  });

  it('keeps a server of the current build, and never restarts the server of an explicit --url', async () => {
    const same = fakeDeps({ healthy: () => true });
    expect(await ensureServer({ config: config(library()), deps: same.deps })).toBe('http://127.0.0.1:4317');
    expect([same.stopped, same.spawned]).toEqual([[], []]);
    const old = fakeDeps({ healthy: () => true, build: 'build-1' });
    expect(await ensureServer({ url: 'http://127.0.0.1:7777', deps: old.deps })).toBe('http://127.0.0.1:7777');
    expect([old.stopped, old.spawned]).toEqual([[], []]);
  });
});

describe('probeHealth', () => {
  it('is true only for a live manga server', async () => {
    const h = await startHarness();
    try {
      expect(await probeHealth(h.url)).toBe(true);
      expect(await probeHealth('http://127.0.0.1:9')).toBe(false);
    } finally {
      await h.close();
    }
  });
});
