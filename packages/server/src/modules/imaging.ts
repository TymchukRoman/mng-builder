import type { RecipeInfo } from '@manga/shared';
import type { AppModule, CoreDeps } from '../app.js';
import { startFakeComfy } from '../dev/fake-comfy.js';
import { registerImagingJobs } from '../handlers/index.js';
import { ComfyClient } from '../imaging/comfy.js';
import { ComfyLauncher } from '../imaging/launcher.js';
import { RECIPES, recipeInfo } from '../imaging/recipes/index.js';
import { servicesFor, type M2Services } from './services.js';

export function imagingModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  return {
    name: 'imaging',
    async register(app): Promise<void> {
      if (!services.comfy) {
        if (services.fakes) {
          services.fakeComfy = await startFakeComfy();
          services.comfy = new ComfyClient({ url: services.fakeComfy.url, launcher: null, pollMs: 50 });
        } else {
          services.comfy = new ComfyClient({
            url: deps.config.comfyUrl,
            launcher: new ComfyLauncher({ comfyRoot: deps.config.comfyRoot, comfyUrl: deps.config.comfyUrl }),
          });
        }
      }
      const comfy = services.comfy;
      deps.gpu.setReleaser('comfy', () => comfy.free());
      deps.statusProviders.comfy = () => comfy.health();
      registerImagingJobs(deps.queue, services);
      app.get('/api/recipes', async (): Promise<RecipeInfo[]> => Object.values(RECIPES).map(recipeInfo));
    },
    async stop(): Promise<void> {
      await services.fakeComfy?.close();
    },
  };
}
