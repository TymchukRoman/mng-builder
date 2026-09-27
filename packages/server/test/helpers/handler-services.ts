import { FAKE_RESPONSES } from '../../src/dev/fake-responses.js';
import { Engines } from '../../src/engines/resolve.js';
import { ScriptedEngine, type ScriptedResponse } from '../../src/engines/scripted.js';
import type { HandlerServices } from '../../src/handlers/types.js';
import type { ComfyClient } from '../../src/imaging/comfy.js';
import type { Store } from '../../src/store/index.js';

export interface TestServices extends HandlerServices { claude: ScriptedEngine; local: ScriptedEngine }

export function handlerServices(
  store: Store, comfy: ComfyClient,
  scripts: { claude?: Record<string, ScriptedResponse>; local?: Record<string, ScriptedResponse> } = {},
): TestServices {
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...scripts.claude });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...scripts.local });
  return { claude, local, engines: new Engines({ settings: () => store.settings.get(), claude, local }), requireComfy: () => comfy };
}
