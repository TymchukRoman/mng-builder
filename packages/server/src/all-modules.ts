import type { AppModule, CoreDeps } from './app.js';
import { aiModule } from './modules/ai.js';
import { imagingModule } from './modules/imaging.js';

/** The full set of AppModules the real server runs: main.ts and `manga serve` both use this (M1 pre-flight F4). */
export function defaultModules(deps: CoreDeps): AppModule[] {
  return [aiModule(deps), imagingModule(deps)];
}
