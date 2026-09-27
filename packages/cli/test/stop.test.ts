import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth } from '@manga/server/config';
import { runCli } from '../src/program.js';
import { stopServer, type StopDeps } from '../src/stop.js';
import { startHarness, type RunResult } from './helpers.js';

let savedLibrary: string | undefined;
beforeEach(() => {
  savedLibrary = process.env['MANGA_LIBRARY'];
});
afterEach(() => {
  if (savedLibrary === undefined) delete process.env['MANGA_LIBRARY'];
  else process.env['MANGA_LIBRARY'] = savedLibrary;
});

/** `manga …args` without --url, so the library comes from MANGA_LIBRARY. */
async function run(...args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

describe('manga stop', () => {
  it("stops the library's server named in server.json, then reports that none is running", async () => {
    const h = await startHarness();
    try {
      process.env['MANGA_LIBRARY'] = h.lib;
      expect(await run('stop')).toEqual({ code: 0, stdout: `stopped ${process.pid}\n`, stderr: '' });
      expect(await fetchHealth(h.url)).toBeNull();
      expect(existsSync(join(h.lib, 'server.json'))).toBe(false);
      expect(await run('stop')).toEqual({ code: 0, stdout: 'no server running\n', stderr: '' });
    } finally {
      await h.close();
    }
  });

  it('stops the server at --url', async () => {
    const h = await startHarness();
    try {
      expect(await h.run('stop')).toEqual({ code: 0, stdout: `stopped ${process.pid}\n`, stderr: '' });
      expect(await fetchHealth(h.url)).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('ends a running `manga serve`', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'manga-stop-serve-'));
    const savedPort = process.env['MANGA_PORT'];
    process.env['MANGA_LIBRARY'] = lib;
    process.env['MANGA_PORT'] = '0';
    try {
      let out = '';
      const serving = runCli(['serve'], {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      });
      await vi.waitFor(() => expect(out).toMatch(/listening on/), { timeout: 10_000 });
      expect((await run('stop')).stdout).toBe(`stopped ${process.pid}\n`);
      expect(await serving).toBe(0);
      expect(existsSync(join(lib, 'server.json'))).toBe(false);
    } finally {
      if (savedPort === undefined) delete process.env['MANGA_PORT'];
      else process.env['MANGA_PORT'] = savedPort;
      rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('prints "no server running" (exit 0) for a library without a live server', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'manga-stop-'));
    try {
      process.env['MANGA_LIBRARY'] = lib;
      expect(await run('stop')).toEqual({ code: 0, stdout: 'no server running\n', stderr: '' });
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});

describe('stopServer', () => {
  /** A server that answers `status` to POST /api/shutdown and stops answering health after `polls` checks. */
  function fake(status: number, polls: number) {
    let clock = 0;
    let checks = 0;
    const killed: number[] = [];
    const deps: StopDeps = {
      health: async () => (checks++ < polls ? { ok: true, pid: 999_999, version: '0.1.0', build: 'b' } : null),
      requestShutdown: async () => status,
      kill: (pid) => {
        killed.push(pid);
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    return { deps, killed };
  }

  it('waits until the server no longer answers', async () => {
    const f = fake(200, 3);
    await stopServer('http://127.0.0.1:1', 999_999, f.deps);
    expect(f.killed).toEqual([]);
  });

  it('ends a server built before POST /api/shutdown existed (404) by its pid, but never this process', async () => {
    const f = fake(404, 1);
    await stopServer('http://127.0.0.1:1', 999_999, f.deps);
    expect(f.killed).toEqual([999_999]);
    const self = fake(404, 0);
    await expect(stopServer('http://127.0.0.1:1', process.pid, self.deps)).rejects.toThrow('refused to shut down (HTTP 404)');
    expect(self.killed).toEqual([]);
  });

  it('fails after 10 s when the server keeps answering, and on a refused shutdown', async () => {
    await expect(stopServer('http://127.0.0.1:1', 999_999, fake(200, Number.POSITIVE_INFINITY).deps)).rejects.toThrow('the server (pid 999999) did not stop within 10 s');
    await expect(stopServer('http://127.0.0.1:1', 999_999, fake(403, 1).deps)).rejects.toThrow('refused to shut down (HTTP 403)');
  });
});
