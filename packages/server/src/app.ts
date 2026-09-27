import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '@manga/shared';
import { installErrorHandling } from './api/errors.js';
import { registerCoreRoutes } from './api/routes.js';
import { defaultUiDir, registerStaticUi } from './api/static.js';
import { loadConfig, removeServerInfo, writeServerInfo } from './config.js';
import { defaultStatusProviders, type AppModule, type CoreDeps } from './deps.js';
import { EventBus } from './events/bus.js';
import { GpuArbiter } from './jobs/gpu.js';
import { JobQueue } from './jobs/queue.js';
import { openStore } from './store/index.js';

export type { AppModule, CoreDeps, StatusProviders } from './deps.js';
export { defaultStatusProviders, NOT_CONFIGURED } from './deps.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface BuildOptions { uiDir?: string | null }

export async function buildApp(deps: CoreDeps, modules: AppModule[], options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  installErrorHandling(app);
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  for (const mod of modules) await mod.register(app, deps);
  await app.after();
  registerCoreRoutes(app, deps);
  await registerStaticUi(app, options.uiDir === undefined ? defaultUiDir() : options.uiDir);
  return app;
}

export interface StartOptions { config?: Partial<AppConfig>; modules?: (deps: CoreDeps) => AppModule[]; uiDir?: string | null }
export interface RunningServer { app: FastifyInstance; deps: CoreDeps; url: string; stop(): Promise<void> }

/**
 * Listen first; only then start modules and the queue and claim server.json. A second server that fails with
 * EADDRINUSE therefore never resets the running server's jobs.
 */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadConfig(opts.config ?? {});
  mkdirSync(config.libraryPath, { recursive: true });
  const store = openStore(config.libraryPath);
  const bus = new EventBus();
  const gpu = new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const deps: CoreDeps = { config, store, bus, queue, gpu, statusProviders: defaultStatusProviders() };
  const modules = opts.modules ? opts.modules(deps) : [];

  let app: FastifyInstance | null = null;
  try {
    app = await buildApp(deps, modules, opts.uiDir === undefined ? {} : { uiDir: opts.uiDir });
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    if (app) await app.close();
    store.close();
    throw err;
  }
  const running = app;
  for (const mod of modules) await mod.start?.(deps);
  queue.start();

  const port = (running.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  writeServerInfo(config.libraryPath, { pid: process.pid, port, startedAt: new Date().toISOString() });

  let stopped = false;
  return {
    app: running,
    deps,
    url,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const mod of [...modules].reverse()) await mod.stop?.();
      await queue.stop();
      await running.close();
      store.close();
      removeServerInfo(config.libraryPath, process.pid);
    },
  };
}
