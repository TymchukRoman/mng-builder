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

/** The job counts and the lane pauses, read now. */
function queueStatus(deps: Pick<CoreDeps, 'store' | 'queue'>): ServiceStatus['queue'] {
  return { ...deps.store.jobs.counts(), pausedLanes: deps.queue.pausedLanes() };
}

/** GET /api/status: probes the three services, then reads the queue (W1 R2). */
export async function serviceStatus(deps: Pick<CoreDeps, 'statusProviders' | 'store' | 'queue'>): Promise<ServiceStatus> {
  const providers = deps.statusProviders;
  const [claude, ollama, comfy] = await Promise.all([
    probe(() => providers.claude()), probe(() => providers.ollama()), probe(() => providers.comfy()),
  ]);
  return { claude, ollama, comfy, queue: queueStatus(deps) };
}

export function registerSystemRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const build = ownBuildStamp(); // fixed at start: the CLI restarts a server whose build differs from the code on disk
  app.get('/api/health', async (): Promise<ServerHealth> => ({ ok: true, pid: process.pid, version: VERSION, build }));

  /** The last probed status: a lane change reuses its service states (W1 F11). */
  let last: ServiceStatus | null = null;
  app.get('/api/status', async (): Promise<ServiceStatus> => {
    const status = await serviceStatus(deps);
    last = status;
    return status;
  });

  // W1 R2: a lane pause, resume or expiry reaches the UI at once (the 30 s poll stays as the fallback). F11: the queue is
  // read at the change and the service states come from the last probe, so the events leave in the order of the
  // changes. Before the first GET /api/status nobody holds a status to update (that GET reads the queue after its
  // probes), and a lane change never starts a probe of its own (it would spawn the Claude CLI on every pause).
  deps.queue.onLanesChanged(() => {
    if (last !== null) deps.bus.emit({ type: 'status', status: { ...last, queue: queueStatus(deps) } });
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
