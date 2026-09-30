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
      // Task 9: resume() must see the jobs an interrupted process left behind as queued, and JobQueue.start() is what
      // re-queues them (resetRunning). startServer calls module start() before queue.start(), so start the queue here
      // first (it is idempotent: startServer's own call is then a no-op).
      deps.queue.start();
      runner.resume();
    },
    stop(): void {
      runner.stop();
    },
  };
}
