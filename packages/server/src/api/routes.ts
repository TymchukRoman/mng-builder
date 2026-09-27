import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerCharacterRoutes } from './characters.js';
import { registerEventRoutes } from './events.js';
import { registerImageRoutes } from './images.js';
import { registerMangaRoutes } from './mangas.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMangaRoutes(app, deps);
  registerCharacterRoutes(app, deps);
  registerImageRoutes(app, deps);
}
