// packages/server/src/export/module.ts
import type { FastifyInstance } from 'fastify';
import type { AppModule, CoreDeps } from '../app.js';
import { exportJobHandler, type ExportJobDeps } from './job.js';
import { registerExportRoutes } from './routes.js';

/** Contract C.5: M4's export module. Chromium talks to this very server, on the port it is actually bound to. */
export function exportModule(deps: CoreDeps, opts: Omit<ExportJobDeps, 'baseUrl'> = {}): AppModule {
  let app: FastifyInstance | null = null;
  const baseUrl = (): string => {
    const address = app?.server.address();
    const port = address && typeof address === 'object' ? address.port : deps.config.port;
    return `http://127.0.0.1:${port}`;
  };
  return {
    name: 'export',
    register(instance): void {
      app = instance;
      deps.queue.register('export.render', exportJobHandler({ ...opts, baseUrl }));
      registerExportRoutes(instance, { store: deps.store, queue: deps.queue });
    },
  };
}
