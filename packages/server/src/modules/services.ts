import { join } from 'node:path';
import type { Settings } from '@manga/shared';
import type { CoreDeps } from '../app.js';
import type { FakeComfy } from '../dev/fake-comfy.js';
import { FAKE_RESPONSES } from '../dev/fake-responses.js';
import { ClaudeEngine } from '../engines/claude.js';
import { OllamaEngine } from '../engines/ollama.js';
import { Engines } from '../engines/resolve.js';
import { ScriptedEngine } from '../engines/scripted.js';
import type { TextEngine } from '../engines/types.js';
import type { HandlerServices } from '../handlers/types.js';
import type { ComfyClient } from '../imaging/comfy.js';
import { PermanentError } from '../jobs/index.js';

/** When Claude reports exhaustion without a reset time, the claude lane pauses this long. */
export const QUOTA_FALLBACK_MS = 15 * 60_000;

export interface M2Options {
  /** Default: process.env.MANGA_FAKES === '1'. */
  fakes?: boolean;
  claude?: TextEngine;
  local?: TextEngine;
  comfy?: ComfyClient;
  /** Arguments placed before the claude arguments (tests point claudeBin at node + a fake script). */
  claudeBinArgs?: string[];
}

export interface M2Services extends HandlerServices {
  readonly fakes: boolean;
  readonly claude: TextEngine;
  readonly local: TextEngine;
  readonly engines: HandlerServices['engines'];
  /** Set by imagingModule.register (FakeComfy needs an async start). */
  comfy: ComfyClient | null;
  fakeComfy: FakeComfy | null;
}

const registry = new WeakMap<CoreDeps, M2Services>();

/** One set of M2 services per server, shared by aiModule and imagingModule. */
export function servicesFor(deps: CoreDeps, opts: M2Options = {}): M2Services {
  const existing = registry.get(deps);
  if (existing) return existing;
  const fakes = opts.fakes ?? process.env['MANGA_FAKES'] === '1';
  const settings = (): Settings => deps.store.settings.get();
  const claude = opts.claude ?? (fakes
    ? new ScriptedEngine('claude', FAKE_RESPONSES)
    : new ClaudeEngine({
      bin: deps.config.claudeBin,
      ...(opts.claudeBinArgs ? { binArgs: opts.claudeBinArgs } : {}),
      cwd: deps.store.files.claudeCwd(),
      mangasDir: join(deps.store.files.root, 'mangas'),
      models: () => settings().claude.models,
      onRateLimit: (resetsAt, reason) => {
        deps.queue.pauseLane('claude', resetsAt ? new Date(resetsAt) : new Date(Date.now() + QUOTA_FALLBACK_MS), reason);
      },
    }));
  const local = opts.local ?? (fakes
    ? new ScriptedEngine('local', FAKE_RESPONSES)
    : new OllamaEngine({ url: deps.config.ollamaUrl, models: () => settings().ollama, gpu: deps.gpu }));
  const services: M2Services = {
    fakes, claude, local,
    engines: new Engines({ settings, claude, local }),
    comfy: opts.comfy ?? null,
    fakeComfy: null,
    requireComfy(): ComfyClient {
      if (!services.comfy) throw new PermanentError('The imaging module is not initialised (no ComfyUI client)');
      return services.comfy;
    },
  };
  registry.set(deps, services);
  return services;
}
