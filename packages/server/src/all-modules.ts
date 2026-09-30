import type { AppModule, CoreDeps } from './app.js';
import { exportModule } from './export/module.js';
import { aiModule } from './modules/ai.js';
import { imagingModule } from './modules/imaging.js';
import { servicesFor, type M2Services } from './modules/services.js';
import { episodeModule } from './workflows/episode/module.js';

/**
 * The full set of AppModules the real server runs: main.ts and `manga serve` both use this (M1 pre-flight F4).
 * Every module shares one M2 service set (`servicesFor` keeps one per server, so tests may create it first with fakes).
 */
export function defaultModules(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule[] {
  return [aiModule(deps, services), imagingModule(deps, services), episodeModule(deps, services), exportModule(deps)];
}
