import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerEventRoutes } from './events.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
}
