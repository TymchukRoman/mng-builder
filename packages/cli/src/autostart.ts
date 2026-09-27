import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@manga/shared';
import { loadConfig, readServerInfo } from '@manga/server/config';
import { CliError } from './errors.js';

export const START_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export interface EnsureDeps {
  probe(url: string): Promise<boolean>;
  spawnServer(libraryPath: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface EnsureOptions { url?: string | undefined; config?: AppConfig; deps?: EnsureDeps; timeoutMs?: number }

/** True only when a manga server answers GET /api/health with {ok:true}. */
export async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
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
  probe: probeHealth,
  spawnServer: spawnServerDetached,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Returns the base URL of a healthy server. An explicit --url is only probed. Otherwise the server.json port and
 * the configured port are probed; if neither answers, the server is spawned and the configured port is polled.
 */
export async function ensureServer(opts: EnsureOptions = {}): Promise<string> {
  const deps = opts.deps ?? realEnsureDeps;
  if (opts.url !== undefined) {
    const url = opts.url.replace(/\/+$/, '');
    if (await deps.probe(url)) return url;
    throw new CliError(`server not reachable at ${url}`);
  }
  const config = opts.config ?? loadConfig();
  const target = `http://127.0.0.1:${config.port}`;
  const recorded = readServerInfo(config.libraryPath);
  const candidates = [...new Set([recorded === null ? target : `http://127.0.0.1:${recorded.port}`, target])];
  for (const url of candidates) {
    if (await deps.probe(url)) return url;
  }
  deps.spawnServer(config.libraryPath);
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    if (await deps.probe(target)) return target;
  }
  throw new CliError(
    `started the server but it did not answer at ${target} within ${Math.round(timeoutMs / 1000)} s; see ${serverLogPath(config.libraryPath)}`,
  );
}
