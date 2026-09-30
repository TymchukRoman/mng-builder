import type { EpisodeRun } from '@manga/shared';
import type { ApiClient } from './client.js';

const SETTLED: ReadonlySet<EpisodeRun['status']> = new Set(['awaiting-review', 'done', 'failed', 'cancelled']);

export interface FollowOptions {
  intervalMs?: number;
  onChange?(run: EpisodeRun): void;
  signal?: AbortSignal;
  sleep?(ms: number): Promise<void>;
}

/** `--wait` for episodes: poll the chapter's latest run until it waits for review or ends. */
export async function followRun(api: Pick<ApiClient, 'get'>, chapterId: string, opts: FollowOptions = {}): Promise<EpisodeRun> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = '';
  for (;;) {
    const run = await api.get<EpisodeRun | null>(`/api/chapters/${encodeURIComponent(chapterId)}/episode`);
    if (!run) throw new Error(`chapter ${chapterId} has no episode run`);
    const key = `${run.status}:${run.currentStep}:${run.steps[run.currentStep]?.status ?? ''}`;
    if (key !== last) {
      last = key;
      opts.onChange?.(run);
    }
    if (SETTLED.has(run.status) || opts.signal?.aborted) return run;
    await sleep(opts.intervalMs ?? 1000);
  }
}
