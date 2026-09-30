import type { AppModule, CoreDeps } from '../../app.js';
import { emitEntity } from '../../events/bus.js';
import { registerLlmStep } from '../../jobs/llm-step.js';
import { servicesFor, type M2Services } from '../../modules/services.js';
import { registerEpisodeRoutes } from './routes.js';
import { EpisodeRunner } from './runner.js';

/** Contract C.5: M4's episode module. Engines come from M2's shared service set. */
export function episodeModule(deps: CoreDeps, services: Pick<M2Services, 'engines'> = servicesFor(deps)): AppModule & { runner: EpisodeRunner } {
  const runner = new EpisodeRunner({ store: deps.store, bus: deps.bus, queue: deps.queue, engines: services.engines });
  // M4 final I1: a chapter (or manga) delete first stops the chapter's runs, then announces the runs the cascade removed.
  deps.chapterDeleteHooks.push((chapterIds) => {
    const removed = chapterIds.map((chapterId) => ({ mangaId: deps.store.chapters.get(chapterId)?.mangaId ?? null, runIds: runner.cancelForChapter(chapterId) }));
    return () => {
      for (const { mangaId, runIds } of removed) for (const id of runIds) emitEntity(deps.bus, 'episodeRun', id, 'deleted', mangaId);
    };
  });
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
