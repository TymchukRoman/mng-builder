import type { AppModule, CoreDeps } from '../../app.js';
import { registerLlmStep } from '../../jobs/llm-step.js';
import { servicesFor, type M2Services } from '../../modules/services.js';
import { registerEpisodeRoutes } from './routes.js';
import { EpisodeRunner } from './runner.js';

/** Contract C.5: M4's episode module. Engines come from M2's shared service set. */
export function episodeModule(deps: CoreDeps, services: Pick<M2Services, 'engines'> = servicesFor(deps)): AppModule & { runner: EpisodeRunner } {
  const runner = new EpisodeRunner({ store: deps.store, bus: deps.bus, queue: deps.queue, engines: services.engines });
  return {
    name: 'episode',
    runner,
    register(app): void {
      registerLlmStep('episode', (ctx, payload) => runner.handleStepJob(ctx, payload));
      registerEpisodeRoutes(app, { store: deps.store, bus: deps.bus, runner });
    },
    start(): void {
      runner.resume(); // startServer has run queue.recover(), so interrupted step jobs are already queued
    },
    stop(): void {
      runner.stop();
    },
  };
}
