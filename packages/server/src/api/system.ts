import type { FastifyInstance } from 'fastify';
import {
  PRESET_NAMES, presetPanelCount, SettingsPatchSchema, STYLE_PRESETS,
  type AppConfig, type PresetInfo, type ServiceState, type ServiceStatus, type Settings, type StylePreset,
} from '@manga/shared';
import type { CoreDeps } from '../deps.js';
import { ownBuildStamp, type ServerHealth } from '../health.js';
import { VERSION } from '../version.js';
import { emitEntity } from './util.js';

async function probe(check: () => Promise<ServiceState>): Promise<ServiceState> {
  try {
    return await check();
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function registerSystemRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const build = ownBuildStamp(); // fixed at start: the CLI restarts a server whose build differs from the code on disk
  app.get('/api/health', async (): Promise<ServerHealth> => ({ ok: true, pid: process.pid, version: VERSION, build }));

  app.get('/api/status', async (): Promise<ServiceStatus> => {
    const providers = deps.statusProviders;
    const [claude, ollama, comfy] = await Promise.all([
      probe(() => providers.claude()), probe(() => providers.ollama()), probe(() => providers.comfy()),
    ]);
    return { claude, ollama, comfy, queue: { ...deps.store.jobs.counts(), pausedLanes: deps.queue.pausedLanes() } };
  });

  app.get('/api/settings', async (): Promise<Settings> => deps.store.settings.get());

  app.patch('/api/settings', async (req): Promise<Settings> => {
    const settings = deps.store.settings.patch(SettingsPatchSchema.parse(req.body ?? {}));
    emitEntity(deps.bus, 'settings', 'settings', 'updated', null);
    return settings;
  });

  app.get('/api/layouts', async (): Promise<PresetInfo[]> => PRESET_NAMES.map((name) => ({ name, panelCount: presetPanelCount(name) })));

  app.get('/api/style-presets', async (): Promise<StylePreset[]> => Object.values(STYLE_PRESETS));

  /** Read-only: the Settings page shows where the library and ComfyUI live. Changed only via config.json. */
  app.get('/api/config', async (): Promise<AppConfig> => ({ ...deps.config }));
}
