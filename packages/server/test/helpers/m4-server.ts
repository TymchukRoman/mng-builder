import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@manga/shared';
import { defaultModules } from '../../src/all-modules.js';
import { startServer, type AppModule, type CoreDeps } from '../../src/app.js';
import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import { ComfyClient } from '../../src/imaging/comfy.js';
import { servicesFor } from '../../src/modules/services.js';
import { startFakeComfy, type FakeComfy } from '../fakes/fake-comfy.js';

export interface M4TestServer {
  url: string;
  deps: CoreDeps;
  library: string;
  claude: ScriptedEngine;
  local: ScriptedEngine;
  fake: FakeComfy;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Polls `fn` every 50 ms until it returns something truthy. */
  until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface M4TestServerOptions {
  /** Extra scripted answers, by request name, for both engines (they win over FAKE_RESPONSES). */
  claude?: Record<string, ScriptedResponse>;
  local?: Record<string, ScriptedResponse>;
  /** Serve this built UI (export tests); default: no UI. */
  uiDir?: string | null;
  /** Reuse an existing library folder (restart tests); it is not deleted on close. */
  library?: string;
  config?: Partial<AppConfig>;
  /** Called with the modules `defaultModules` built, before the server starts them (ordering probes wrap their hooks). */
  inspectModules?: (modules: AppModule[], deps: CoreDeps) => void;
}

/** The whole app (defaultModules) on a temp library and a random port, with FakeComfy and scripted engines. */
export async function startM4TestServer(opts: M4TestServerOptions = {}): Promise<M4TestServer> {
  const library = opts.library ?? mkdtempSync(join(tmpdir(), 'manga-m4-server-'));
  const fake = await startFakeComfy();
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.local });
  const cleanLibrary = (): void => {
    if (!opts.library) rmSync(library, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer({
      config: { libraryPath: library, port: 0, ...opts.config },
      uiDir: opts.uiDir ?? null,
      modules: (deps) => {
        // F20: defaultModules picks the shared service set up from the registry, so the fakes go in first.
        servicesFor(deps, { fakes: false, claude, local, comfy: new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 }) });
        const modules = defaultModules(deps);
        opts.inspectModules?.(modules, deps);
        return modules;
      },
    });
  } catch (err) {
    await fake.close();
    cleanLibrary();
    throw err;
  }
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${started.url}${path}`, {
      method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const until = async <T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  let closing: Promise<void> | null = null;
  return {
    url: started.url, deps: started.deps, library, claude, local, fake, api, until,
    /** Idempotent; the fake and the library are released even when stopping the server throws. */
    close: () => (closing ??= (async (): Promise<void> => {
      try {
        await started.stop();
      } finally {
        try {
          await fake.close();
        } finally {
          cleanLibrary();
        }
      }
    })()),
  };
}
