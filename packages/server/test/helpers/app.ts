import type { FastifyInstance } from 'fastify';
import { AppConfigSchema } from '@manga/shared';
import { buildApp, defaultStatusProviders, type AppModule, type CoreDeps } from '../../src/app.js';
import { EventBus } from '../../src/events/bus.js';
import { GpuArbiter } from '../../src/jobs/gpu.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { openStore } from '../../src/store/index.js';
import { tempDir } from './tmp.js';

export interface TestApp { app: FastifyInstance; deps: CoreDeps; lib: string; close(): Promise<void> }

/** An app over a temp library, not listening (use app.inject). The job queue is NOT started. POST /api/shutdown exists only with `onShutdown`. */
export async function makeTestApp(opts: { modules?: AppModule[]; uiDir?: string | null; onShutdown?: () => void } = {}): Promise<TestApp> {
  const dir = tempDir('manga-api-');
  const store = openStore(dir.path);
  const bus = new EventBus();
  const gpu = new GpuArbiter();
  const deps: CoreDeps = {
    config: AppConfigSchema.parse({ libraryPath: dir.path, port: 0 }),
    store, bus, gpu,
    queue: new JobQueue({ store, bus, gpu, pollMs: 10 }),
    statusProviders: defaultStatusProviders(),
  };
  const app = await buildApp(deps, opts.modules ?? [], { uiDir: opts.uiDir ?? null, ...(opts.onShutdown ? { onShutdown: opts.onShutdown } : {}) });
  await app.ready();
  return {
    app, deps, lib: dir.path,
    async close() {
      await deps.queue.stop();
      await app.close();
      store.close();
      dir.cleanup();
    },
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** JSON request through app.inject; body is the parsed JSON response (undefined when empty). */
export async function call<T = unknown>(app: FastifyInstance, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { status: res.statusCode, body: (res.body.length > 0 ? JSON.parse(res.body) : undefined) as T };
}
