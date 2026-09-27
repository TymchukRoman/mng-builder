import type { FastifyInstance } from 'fastify';
import type { CoreDeps } from '../deps.js';
import { registerChapterRoutes } from './chapters.js';
import { registerCharacterRoutes } from './characters.js';
import { registerEventRoutes } from './events.js';
import { registerFrameRoutes } from './frames.js';
import { registerImageRoutes } from './images.js';
import { registerJobRoutes } from './jobs.js';
import { registerMangaRoutes } from './mangas.js';
import { registerPageRoutes } from './pages.js';
import { registerPanelRoutes } from './panels.js';
import { registerSystemRoutes } from './system.js';

export function registerCoreRoutes(app: FastifyInstance, deps: CoreDeps): void {
  registerSystemRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerMangaRoutes(app, deps);
  registerCharacterRoutes(app, deps);
  registerImageRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerPanelRoutes(app, deps);
  registerFrameRoutes(app, deps);
  registerJobRoutes(app, deps);
}
