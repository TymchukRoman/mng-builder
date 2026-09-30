import type { EpisodeRun } from '@manga/shared';
import type { ApiClient } from './client.js';

const SETTLED: ReadonlySet<EpisodeRun['status']> = new Set(['awaiting-review', 'done', 'failed', 'cancelled']);

/** True when the run has stopped: waiting for review or ended. */
export function isSettled(run: EpisodeRun): boolean {
  return SETTLED.has(run.status);
}

/** Resolves after `ms`, or at once (clearing its timer) when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface FollowOptions {
  intervalMs?: number;
  onChange?(run: EpisodeRun): void;
  signal?: AbortSignal;
  sleep?(ms: number): Promise<void>;
}

/**
 * `--wait` for episodes: poll the chapter's latest run until it waits for review or ends. An abort (`signal`) ends the
 * wait at once and returns the run as last seen, still unsettled: the caller decides what that means.
 */
export async function followRun(api: Pick<ApiClient, 'get'>, chapterId: string, opts: FollowOptions = {}): Promise<EpisodeRun> {
  const sleep = opts.sleep ?? ((ms: number) => pause(ms, opts.signal));
  let last = '';
  for (;;) {
    const run = await api.get<EpisodeRun | null>(`/api/chapters/${encodeURIComponent(chapterId)}/episode`);
    if (!run) throw new Error(`chapter ${chapterId} has no episode run`);
    const key = `${run.status}:${run.currentStep}:${run.steps[run.currentStep]?.status ?? ''}`;
    if (key !== last) {
      last = key;
      opts.onChange?.(run);
    }
    if (isSettled(run) || opts.signal?.aborted) return run;
    await sleep(opts.intervalMs ?? 1000);
    if (opts.signal?.aborted) return run;
  }
}
