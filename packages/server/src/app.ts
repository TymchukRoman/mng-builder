import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '@manga/shared';
import { installErrorHandling } from './api/errors.js';
import { installRequestGuards } from './api/guards.js';
import { registerCoreRoutes } from './api/routes.js';
import { registerShutdownRoute } from './api/shutdown.js';
import { defaultUiDir, registerStaticUi } from './api/static.js';
import { liveServer, loadConfig, removeServerInfo, writeServerInfo } from './config.js';
import { defaultStatusProviders, type AppModule, type CoreDeps } from './deps.js';
import { EventBus } from './events/bus.js';
import { GpuArbiter } from './jobs/gpu.js';
import { JobQueue } from './jobs/queue.js';
import { openStore } from './store/index.js';

export type { AppModule, CoreDeps, StatusProviders } from './deps.js';
export { defaultStatusProviders, NOT_CONFIGURED } from './deps.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** How long stop() waits for modules and job handlers before closing anyway. */
export const STOP_TIMEOUT_MS = 10_000;

/** `onShutdown`: registers POST /api/shutdown, which calls it once the response is sent (see api/shutdown.ts). */
export interface BuildOptions { uiDir?: string | null; onShutdown?: () => void }

export async function buildApp(deps: CoreDeps, modules: AppModule[], options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  installErrorHandling(app);
  await app.register(fastifyWebsocket);
  // After the WebSocket plugin: its onRequest hook marks upgrades first, so a refused upgrade's socket is destroyed.
  installRequestGuards(app);
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  for (const mod of modules) await mod.register(app, deps);
  await app.after();
  registerCoreRoutes(app, deps);
  if (options.onShutdown) registerShutdownRoute(app, options.onShutdown);
  await registerStaticUi(app, options.uiDir === undefined ? defaultUiDir() : options.uiDir);
  return app;
}

/**
 * `onShutdown`: what POST /api/shutdown does once it has answered. Default: `stop()` this server. main.ts stops and
 * exits the process; `manga serve` ends its command. `stopTimeoutMs` (default STOP_TIMEOUT_MS) bounds stop().
 */
export interface StartOptions {
  config?: Partial<AppConfig>; modules?: (deps: CoreDeps) => AppModule[]; uiDir?: string | null; onShutdown?: () => void; stopTimeoutMs?: number;
}
/**
 * `stop()` is idempotent: every call returns the same promise. Modules and job handlers get `stopTimeoutMs` to finish
 * (a handler that ignores its abort signal cannot hang shutdown); then the server and the store close regardless.
 */
export interface RunningServer { app: FastifyInstance; deps: CoreDeps; url: string; stop(): Promise<void> }

/** True when `work` settles within `ms`, false when time runs out first (`work` keeps going). Rejections pass through. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One server per library: refuses to start while `<library>/server.json` names a live server on another port (on the
 * same port, listen fails with EADDRINUSE). Listen first; only then start modules and the queue and claim
 * server.json. A second server that fails therefore never resets the running server's jobs.
 */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadConfig(opts.config ?? {});
  mkdirSync(config.libraryPath, { recursive: true });
  const live = await liveServer(config.libraryPath);
  if (live !== null && live.port !== config.port) {
    throw new Error(`library ${config.libraryPath} is already served by pid ${live.pid} at ${live.url}; stop it first (manga stop)`);
  }
  const store = openStore(config.libraryPath);
  const bus = new EventBus();
  const gpu = new GpuArbiter();
  const queue = new JobQueue({ store, bus, gpu });
  const deps: CoreDeps = { config, store, bus, queue, gpu, statusProviders: defaultStatusProviders() };
  const modules = opts.modules ? opts.modules(deps) : [];

  // Defined before the app so POST /api/shutdown can reach it; it only runs once listening, when `running` is set.
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopping ??= (async () => {
    const drained = (async () => {
      for (const mod of [...modules].reverse()) await mod.stop?.();
      await queue.stop();
    })();
    const timeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    if (!(await settlesWithin(drained, timeoutMs))) {
      console.error(`[manga] modules or job handlers did not stop within ${timeoutMs} ms; closing anyway`);
    }
    await running.close();
    store.close();
    removeServerInfo(config.libraryPath, process.pid);
  })());
  const onShutdown = opts.onShutdown ?? ((): void => {
    stop().catch((err: unknown) => console.error('[manga] shutdown failed:', err));
  });

  let app: FastifyInstance | null = null;
  try {
    app = await buildApp(deps, modules, { ...(opts.uiDir === undefined ? {} : { uiDir: opts.uiDir }), onShutdown });
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    if (app) await app.close();
    store.close();
    throw err;
  }
  const running = app;
  queue.recover(); // before the modules' start(): what they resume must see interrupted jobs as queued
  for (const mod of modules) await mod.start?.(deps);
  queue.start();

  const port = (running.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  writeServerInfo(config.libraryPath, { pid: process.pid, port, startedAt: new Date().toISOString() });
  return { app: running, deps, url, stop };
}
