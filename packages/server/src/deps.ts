import type { FastifyInstance } from 'fastify';
import type { AppConfig, ServiceState } from '@manga/shared';
import type { EventBus } from './events/bus.js';
import type { GpuArbiter } from './jobs/gpu.js';
import type { JobQueue } from './jobs/queue.js';
import type { Store } from './store/index.js';

export interface StatusProviders { claude(): Promise<ServiceState>; ollama(): Promise<ServiceState>; comfy(): Promise<ServiceState> } // M1 defaults: {ok:false, detail:'not configured'}
export interface CoreDeps { config: AppConfig; store: Store; bus: EventBus; queue: JobQueue; gpu: GpuArbiter; statusProviders: StatusProviders }
export interface AppModule { name: string; register(app: FastifyInstance, deps: CoreDeps): Promise<void> | void; start?(deps: CoreDeps): Promise<void> | void; stop?(): Promise<void> | void }

export const NOT_CONFIGURED: ServiceState = { ok: false, detail: 'not configured' };

export function defaultStatusProviders(): StatusProviders {
  const notConfigured = async (): Promise<ServiceState> => ({ ...NOT_CONFIGURED });
  return { claude: notConfigured, ollama: notConfigured, comfy: notConfigured };
}
