import type { Engines } from '../engines/resolve.js';
import type { ComfyClient } from '../imaging/comfy.js';

/** What job handlers need from the M2 services (M2Services satisfies it; tests build it directly). */
export interface HandlerServices {
  engines: Engines;
  requireComfy(): ComfyClient;
}
