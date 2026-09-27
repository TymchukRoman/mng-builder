import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@manga/shared';
import { startServer, type CoreDeps } from '../../src/app.js';
import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import { ComfyClient } from '../../src/imaging/comfy.js';
import { aiModule } from '../../src/modules/ai.js';
import { imagingModule } from '../../src/modules/imaging.js';
import { servicesFor, type M2Options, type M2Services } from '../../src/modules/services.js';
import { startFakeComfy, type FakeComfy } from '../fakes/fake-comfy.js';

export interface M2TestServer {
  url: string;
  deps: CoreDeps;
  services: M2Services;
  fake: FakeComfy;
  claude: ScriptedEngine;
  local: ScriptedEngine;
  library: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export interface M2TestServerOptions {
  claude?: Record<string, ScriptedResponse>;
  local?: Record<string, ScriptedResponse>;
  /** Build the real ClaudeEngine from config.claudeBin (+ services().claudeBinArgs) instead of the scripted one. */
  realClaude?: boolean;
  config?: Partial<AppConfig>;
  services?: (deps: CoreDeps) => Partial<M2Options>;
}

/** A full server on a temp library and a random port, wired to FakeComfy and scripted engines. */
export async function startM2TestServer(opts: M2TestServerOptions = {}): Promise<M2TestServer> {
  const library = mkdtempSync(join(tmpdir(), 'manga-m2-server-'));
  const fake = await startFakeComfy();
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.local });
  const holder: { services?: M2Services } = {};
  const started = await startServer({
    config: { libraryPath: library, port: 0, ...opts.config },
    modules: (deps) => {
      const services = servicesFor(deps, {
        fakes: false, ...(opts.realClaude ? {} : { claude }), local,
        comfy: new ComfyClient({ url: fake.url, launcher: null, pollMs: 20 }), ...opts.services?.(deps),
      });
      holder.services = services;
      return [aiModule(deps, services), imagingModule(deps, services)];
    },
  });
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${started.url}${path}`, {
      method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    url: started.url, deps: started.deps, services: holder.services!, fake, claude, local, library, api,
    async close(): Promise<void> {
      await started.stop();
      await fake.close();
      rmSync(library, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
