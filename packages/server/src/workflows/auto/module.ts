import type { AppModule, CoreDeps } from '../../app.js';
import { registerLlmStep } from '../../jobs/llm-step.js';
import { servicesFor, type M2Services } from '../../modules/services.js';
import type { EpisodeRunner } from '../episode/runner.js';
import { registerAutoRoutes } from './routes.js';
import { AutoRunner } from './runner.js';

/**
 * The auto-created manga module. It drives episodes, so it takes the episode module's runner and must come after that
 * module: on boot the episode runner resumes its runs first, and this one then finds them and waits for them.
 */
export function autoModule(
  deps: CoreDeps, episodes: EpisodeRunner, services: Pick<M2Services, 'engines'> = servicesFor(deps),
): AppModule & { runner: AutoRunner } {
  const runner = new AutoRunner({ store: deps.store, bus: deps.bus, queue: deps.queue, episodes, engines: services.engines });
  return {
    name: 'auto',
    runner,
    register(app): void {
      registerLlmStep('manga-plan', (ctx, payload) => runner.handlePlan(ctx, payload));
      registerAutoRoutes(app, { runner });
    },
    start(): void {
      runner.resume();
    },
    stop(): void {
      runner.stop();
    },
  };
}
