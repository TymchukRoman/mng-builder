import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** GET /api/health. `build` is null for servers built before the stamp existed. */
export interface ServerHealth { ok: true; pid: number; version: string; build: string | null }

function newestJsMtime(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return 0; // no such folder (e.g. shared not built)
  }
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    try {
      newest = Math.max(newest, statSync(join(dir, entry)).mtimeMs);
    } catch {
      /* removed while scanning */
    }
  }
  return newest;
}

/**
 * Identifies the compiled code a server runs: the newest mtime of the .js files beside `mainJs` (the server's dist/)
 * and in the shared package's dist/ it loads. Every rebuild that changes either moves it forward. The server fixes it
 * at start; the CLI computes it for the main.js it would spawn and restarts a server whose stamp differs.
 */
export function buildStamp(mainJs: string): string {
  const serverDist = dirname(mainJs);
  const newest = Math.max(newestJsMtime(serverDist), newestJsMtime(join(serverDist, '..', '..', 'shared', 'dist')));
  return newest === 0 ? 'unknown' : String(Math.trunc(newest));
}

/** The stamp of the code this process runs (src/ and dist/ both sit one level below the package folder). */
export function ownBuildStamp(): string {
  return buildStamp(fileURLToPath(new URL('./main.js', import.meta.url)));
}

/** The health of the manga server at `url`, or null when nothing (or something else) answers. */
export async function fetchHealth(url: string, timeoutMs = 1_500): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown> | null;
    if (body?.['ok'] !== true || typeof body['pid'] !== 'number') return null;
    return {
      ok: true,
      pid: body['pid'],
      version: typeof body['version'] === 'string' ? body['version'] : '',
      build: typeof body['build'] === 'string' ? body['build'] : null,
    };
  } catch {
    return null;
  }
}
