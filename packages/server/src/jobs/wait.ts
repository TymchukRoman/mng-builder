import type { Job } from '@manga/shared';
import type { JobQueue } from './queue.js';

/**
 * `queue.waitFor` that gives up when `signal` aborts, rejecting with `signal.reason` (F10). A driver waiting on child
 * jobs must use it: on shutdown the children are re-queued, not settled, so a plain `waitFor` would never return.
 */
export function waitForJob(queue: Pick<JobQueue, 'waitFor'>, id: string, signal: AbortSignal): Promise<Job> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  return new Promise<Job>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason as unknown); };
    signal.addEventListener('abort', onAbort, { once: true });
    queue.waitFor(id).then(
      (job) => { signal.removeEventListener('abort', onAbort); resolve(job); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
