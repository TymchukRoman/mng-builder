import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@manga/shared';
import { buildStamp, fetchHealth, loadConfig, readServerInfo, type ServerHealth } from '@manga/server/config';
import { CliError } from './errors.js';
import { stopServer } from './stop.js';

export const START_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export interface EnsureDeps {
  /** GET /api/health of a manga server, or null when none answers. */
  health(url: string): Promise<ServerHealth | null>;
  /** The build stamp of the server main.js this CLI would spawn. */
  build(): string;
  spawnServer(libraryPath: string): void;
  /** Shuts the server down (as `manga stop` does) and waits until it is gone. */
  stopServer(url: string, pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** `log` receives the one-line notice when an outdated server is restarted (the CLI sends it to stderr). */
export interface EnsureOptions { url?: string | undefined; config?: AppConfig; deps?: EnsureDeps; timeoutMs?: number; log?: (line: string) => void }

/** True only when a manga server answers GET /api/health with {ok:true}. */
export async function probeHealth(url: string): Promise<boolean> {
  return (await fetchHealth(url)) !== null;
}

/** packages/server/dist/main.js, resolved through the @manga/server package exports. */
export function serverEntry(): string {
  return fileURLToPath(import.meta.resolve('@manga/server/main'));
}

export function serverLogPath(libraryPath: string): string {
  return join(libraryPath, 'logs', 'server.log');
}

/** Starts the server detached and hidden (no console window), its output appended to <library>/logs/server.log. */
export function spawnServerDetached(libraryPath: string): void {
  mkdirSync(join(libraryPath, 'logs'), { recursive: true });
  const log = openSync(serverLogPath(libraryPath), 'a');
  try {
    const child = spawn(process.execPath, [serverEntry()], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.on('error', () => {
      /* the health poll that follows reports it */
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export const realEnsureDeps: EnsureDeps = {
  health: (url) => fetchHealth(url),
  build: () => buildStamp(serverEntry()),
  spawnServer: spawnServerDetached,
  stopServer: (url, pid) => stopServer(url, pid),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Returns the base URL of a healthy server. An explicit --url is only probed. Otherwise the server.json port and
 * the configured port are probed. A server that runs another build than the one on disk (a rebuild happened since it
 * started) is stopped and restarted. If none answers, the server is spawned and the configured port is polled.
 */
export async function ensureServer(opts: EnsureOptions = {}): Promise<string> {
  const deps = opts.deps ?? realEnsureDeps;
  if (opts.url !== undefined) {
    const url = opts.url.replace(/\/+$/, '');
    if ((await deps.health(url)) !== null) return url;
    throw new CliError(`server not reachable at ${url}`);
  }
  const config = opts.config ?? loadConfig();
  const target = `http://127.0.0.1:${config.port}`;
  const recorded = readServerInfo(config.libraryPath);
  const candidates = [...new Set([recorded === null ? target : `http://127.0.0.1:${recorded.port}`, target])];
  for (const url of candidates) {
    const health = await deps.health(url);
    if (health === null) continue;
    if (health.build === deps.build()) return url;
    opts.log?.(`restarting the manga server (pid ${health.pid}): it runs an outdated build`);
    await deps.stopServer(url, health.pid);
    break;
  }
  deps.spawnServer(config.libraryPath);
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    if ((await deps.health(target)) !== null) return target;
  }
  throw new CliError(
    `started the server but it did not answer at ${target} within ${Math.round(timeoutMs / 1000)} s; see ${serverLogPath(config.libraryPath)}`,
  );
}
