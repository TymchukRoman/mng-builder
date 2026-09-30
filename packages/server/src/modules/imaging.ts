import { join } from 'node:path';
import type { AppModule, CoreDeps } from '../app.js';
import { registerImagingRoutes } from '../api/imaging-routes.js';
import { startFakeComfy } from '../dev/fake-comfy.js';
import { registerImagingJobs } from '../handlers/index.js';
import { ComfyClient } from '../imaging/comfy.js';
import { GpuMonitor } from '../imaging/gpu-monitor.js';
import { ComfyLauncher } from '../imaging/launcher.js';
import { servicesFor, type M2Services } from './services.js';

export function imagingModule(deps: CoreDeps, services: M2Services = servicesFor(deps)): AppModule {
  /** W1 R2: resumes the gpu lane once ComfyUI has room again after a GPU-busy pause. */
  let monitor: GpuMonitor | null = null;
  return {
    name: 'imaging',
    async register(app): Promise<void> {
      if (!services.comfy) {
        if (services.fakes) {
          services.fakeComfy = await startFakeComfy();
          services.comfy = new ComfyClient({ url: services.fakeComfy.url, launcher: null, pollMs: 50, dataDir: null });
        } else {
          services.comfy = new ComfyClient({
            url: deps.config.comfyUrl,
            launcher: new ComfyLauncher({ comfyRoot: deps.config.comfyRoot, comfyUrl: deps.config.comfyUrl }),
            // I3: ComfyClient removes its input/output copies from the shared ComfyUI folder.
            dataDir: join(deps.config.comfyRoot, 'ComfyUI'),
          });
        }
      }
      const comfy = services.comfy;
      // M2: handing the GPU to ollama waits until ComfyUI has actually dropped its VRAM (ollama places layers by the
      // free VRAM it sees at load time).
      deps.gpu.setReleaser('comfy', (signal) => comfy.release(signal));
      deps.statusProviders.comfy = () => comfy.health();
      registerImagingJobs(deps.queue, services);
      registerImagingRoutes(app, deps, services);
      monitor = new GpuMonitor({ queue: deps.queue, probe: comfy });
    },
    start(): void {
      monitor?.start();
    },
    async stop(): Promise<void> {
      monitor?.stop();
      await services.fakeComfy?.close();
    },
  };
}
