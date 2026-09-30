import type { FastifyInstance } from 'fastify';
import type { AppConfig, ServiceState } from '@manga/shared';
import type { EventBus } from './events/bus.js';
import type { GpuArbiter } from './jobs/gpu.js';
import type { JobQueue } from './jobs/queue.js';
import type { Store } from './store/index.js';

export interface StatusProviders { claude(): Promise<ServiceState>; ollama(): Promise<ServiceState>; comfy(): Promise<ServiceState> } // M1 defaults: {ok:false, detail:'not configured'}
/**
 * M4 final I1: work a module must stop before chapters go. The core delete routes (DELETE /api/chapters/:id and
 * /api/mangas/:id) call every hook with the chapters about to be deleted, before anything is deleted; a hook may
 * return a function that the route calls once the rows are gone (e.g. to emit events for rows the cascade removed).
 * Modules add their hook in their factory; with no module (M1 test servers) the list is empty.
 */
export type ChapterDeleteHook = (chapterIds: readonly string[]) => (() => void) | void;
export interface CoreDeps {
  config: AppConfig; store: Store; bus: EventBus; queue: JobQueue; gpu: GpuArbiter; statusProviders: StatusProviders;
  chapterDeleteHooks: ChapterDeleteHook[];
}
export interface AppModule { name: string; register(app: FastifyInstance, deps: CoreDeps): Promise<void> | void; start?(deps: CoreDeps): Promise<void> | void; stop?(): Promise<void> | void }

export const NOT_CONFIGURED: ServiceState = { ok: false, detail: 'not configured' };

/** Runs every hook before the delete; the returned function runs what the hooks left for after it. */
export function beforeChapterDelete(deps: Pick<CoreDeps, 'chapterDeleteHooks'>, chapterIds: readonly string[]): () => void {
  const after = deps.chapterDeleteHooks.map((hook) => hook(chapterIds)).filter((f): f is () => void => typeof f === 'function');
  return () => { for (const f of after) f(); };
}

export function defaultStatusProviders(): StatusProviders {
  const notConfigured = async (): Promise<ServiceState> => ({ ...NOT_CONFIGURED });
  return { claude: notConfigured, ollama: notConfigured, comfy: notConfigured };
}
