import { fetchHealth, type ServerHealth } from '@manga/server/config';
import { CliError } from './errors.js';

export const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

export interface StopDeps {
  health(url: string): Promise<ServerHealth | null>;
  /** POST /api/shutdown: the HTTP status, 0 when nothing answered. */
  requestShutdown(url: string): Promise<number>;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const realStopDeps: StopDeps = {
  health: (url) => fetchHealth(url),
  async requestShutdown(url) {
    try {
      return (await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5_000) })).status;
    } catch {
      return 0;
    }
  },
  kill(pid) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** The manga server answering at `url`, or null. */
export async function serverAt(url: string, health: StopDeps['health'] = realStopDeps.health): Promise<{ url: string; pid: number } | null> {
  const found = await health(url);
  return found === null ? null : { url, pid: found.pid };
}

/**
 * Asks the manga server at `url` (whose /api/health reported `pid`) to shut down, then waits until it no longer
 * answers with that pid. A server built before POST /api/shutdown existed answers 404; its own health check named the
 * pid, so that process is ended with process.kill (never this process: an in-process server cannot be killed).
 */
export async function stopServer(url: string, pid: number, deps: StopDeps = realStopDeps, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  const status = await deps.requestShutdown(url);
  if (status === 404 && pid !== process.pid) deps.kill(pid);
  else if (status !== 200 && status !== 0) throw new CliError(`the server at ${url} refused to shut down (HTTP ${status})`);
  const deadline = deps.now() + timeoutMs;
  while ((await deps.health(url))?.pid === pid) {
    if (deps.now() >= deadline) throw new CliError(`the server (pid ${pid}) did not stop within ${Math.round(timeoutMs / 1000)} s`);
    await deps.sleep(POLL_MS);
  }
}
