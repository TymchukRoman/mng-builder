import type { AppModule, CoreDeps } from '../app.js';
import { registerAiRoutes } from '../api/ai-routes.js';
import { OllamaEngine } from '../engines/ollama.js';
import { appearanceStep } from '../handlers/appearance.js';
import { panelPromptStep } from '../handlers/panel-prompt.js';
import { llmStepJobHandler, registerLlmStep } from '../jobs/llm-step.js';
import { servicesFor, type M2Services } from './services.js';

export function aiModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
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
    },
  };
}
