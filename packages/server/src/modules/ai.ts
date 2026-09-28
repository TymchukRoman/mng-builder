import type { AppModule, CoreDeps } from '../app.js';
import { registerAiRoutes } from '../api/ai-routes.js';
import { OllamaEngine } from '../engines/ollama.js';
import { relaneTextJobs } from '../engines/resolve.js';
import { appearanceStep } from '../handlers/appearance.js';
import { panelPromptStep } from '../handlers/panel-prompt.js';
import { llmStepJobHandler, registerLlmStep } from '../jobs/llm-step.js';
import { servicesFor, type M2Services } from './services.js';

export function aiModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  let offSettings: (() => void) | null = null;
  return {
    name: 'ai',
    register(app): void {
      const local = services.local;
      deps.gpu.setReleaser('ollama', async () => {
        if (local instanceof OllamaEngine) await local.unload();
      });
      deps.statusProviders.claude = () => services.claude.health();
      deps.statusProviders.ollama = () => services.local.health();
      registerLlmStep('panel-prompt', panelPromptStep(services));
      registerLlmStep('appearance', appearanceStep(services));
      deps.queue.register('llm.step', llmStepJobHandler());
      registerAiRoutes(app, deps, services);
      // I1: a text job runs on the engine of its lane, so an engine switch (PATCH /api/settings emits this event)
      // re-lanes the queued text jobs. Idempotent: a settings change that leaves the engines alone moves nothing.
      offSettings = deps.bus.on((event) => {
        if (event.type === 'entity' && event.entity === 'settings') relaneTextJobs(deps.store, deps.queue, services.engines);
      });
    },
    stop(): void {
      offSettings?.();
      offSettings = null;
    },
  };
}
