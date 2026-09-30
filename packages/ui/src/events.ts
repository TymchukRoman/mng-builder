import { useEffect } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { Job, Page, ServerEvent } from '@manga/shared';
import { api, seg } from './api';
import { createStore, useStore } from './lib/store';
import { cacheLookup, keysForEntity, qk, type EntityEvent } from './queryKeys';
import { TERMINAL, kindLabel } from './jobs/jobView';
import { pushToast } from './ui/toasts';

export function eventsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/events`;
}

export function nextBackoff(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

const EVENT_TYPES = new Set(['job', 'entity', 'status', 'hello']);

export function parseEvent(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as unknown;
    if (typeof v === 'object' && v !== null && EVENT_TYPES.has(String((v as { type?: unknown }).type))) return v as ServerEvent;
    return null;
  } catch {
    return null;
  }
}

export function upsertJob(jobs: readonly Job[] | undefined, job: Job, limit = 50): Job[] {
  const list = jobs ?? [];
  if (list.some((j) => j.id === job.id)) return list.map((j) => (j.id === job.id ? job : j));
  return [job, ...list].slice(0, limit);
}

type FetchJob = (id: string) => Promise<Job>;
interface Waiter { resolve(job: Job): void; reject(err: unknown): void }

/** Promises for "tell me when job X finishes", fed by socket events and by explicit re-fetches. */
export class JobWaiters {
  private readonly waiters = new Map<string, Waiter[]>();

  wait(id: string, fetchJob: FetchJob): Promise<Job> {
    const p = new Promise<Job>((resolve, reject) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(id, list);
    });
    // The job may already have finished before we subscribed.
    fetchJob(id).then((job) => this.notify(job), (err: unknown) => this.fail(id, err));
    return p;
  }

  notify(job: Job): void {
    if (!TERMINAL.has(job.status)) return;
    const list = this.waiters.get(job.id);
    if (!list) return;
    this.waiters.delete(job.id);
    for (const w of list) w.resolve(job);
  }

  fail(id: string, err: unknown): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const w of list) w.reject(err);
  }

  recheck(fetchJob: FetchJob): void {
    for (const id of [...this.waiters.keys()]) fetchJob(id).then((job) => this.notify(job), () => undefined);
  }

  pending(): string[] {
    return [...this.waiters.keys()];
  }
}

export const jobWaiters = new JobWaiters();
const fetchJob: FetchJob = (id) => api.get<Job>(`/api/jobs/${seg(id)}`);

export function waitForJob(id: string): Promise<Job> {
  return jobWaiters.wait(id, fetchJob);
}

export interface EventDeps {
  waiters: JobWaiters;
  fetchJob: FetchJob;
  onJobFailed(job: Job): void;
  /** Ids of failed jobs already reported, so a repeated event does not toast twice. */
  reported: Set<string>;
  /**
   * Controller ruling F5: `hello` is sent on every connect AND reconnect. A full invalidation on
   * the very first `hello` of a session is wasted work (everything was just fetched fresh), so we
   * only do it starting on the second `hello` onward (i.e. reconnects, which may have missed events).
   * A mutable box (not a plain boolean) so the same deps instance can be threaded through repeated
   * `applyServerEvent` calls across the socket's lifetime.
   */
  helloSeen: { value: boolean };
}

const defaultDeps: EventDeps = {
  waiters: jobWaiters,
  fetchJob,
  onJobFailed: (job) => pushToast('error', `${kindLabel(job.kind)} failed${job.error ? `: ${job.error}` : ''}`),
  reported: new Set<string>(),
  helloSeen: { value: false },
};

/** Query keys with an own "detail" query keyed by the entity's id (preflight F5b). */
const DETAIL_KEY: Partial<Record<EntityEvent['entity'], (id: string) => QueryKey>> = {
  manga: qk.manga,
  character: qk.character,
  chapter: qk.chapter,
  page: qk.page,
  panel: qk.panelImages,
};

function sameKey(a: QueryKey, b: QueryKey): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function applyServerEvent(qc: QueryClient, e: ServerEvent, deps: EventDeps = defaultDeps): void {
  switch (e.type) {
    case 'hello':
      // F5: skip the full resync on the first hello of a session; only reconnects need it. M6: but a query that failed
      // before the socket connected (the UI loaded before the server, say under `npm run dev`) is refetched now.
      if (deps.helloSeen.value) void qc.invalidateQueries();
      else {
        deps.helloSeen.value = true;
        void qc.invalidateQueries({ predicate: (q) => q.state.status === 'error' });
      }
      deps.waiters.recheck(deps.fetchJob);
      return;
    case 'job': {
      qc.setQueryData<Job[]>(qk.jobs(), (old) => upsertJob(old, e.job));
      deps.waiters.notify(e.job);
      if (e.job.status === 'failed' && !deps.reported.has(e.job.id)) {
        deps.reported.add(e.job.id);
        deps.onJobFailed(e.job);
      }
      return;
    }
    case 'status':
      // F10: the server does not emit this yet (status only reaches the UI via the 30 s poll in
      // queries.ts), but the branch is kept ready for when it does.
      qc.setQueryData(qk.status(), e.status);
      return;
    case 'entity': {
      // A panel is never deleted alone: the server pairs it with its page's own event (`page updated` after a layout op,
      // `page deleted` in a page, chapter or episode cascade), which refreshes or removes the page detail. Invalidating the
      // page here would refetch, once per panel, a page that the cascade is deleting (404s). Task 18 review finding 10.
      const keys = e.entity === 'panel' && e.op === 'deleted' ? [qk.panelImages(e.id)] : keysForEntity(e, cacheLookup(qc));
      if (e.op === 'deleted') {
        // F5: drop the deleted entity's own detail query outright (invalidating it would just
        // trigger a 404 refetch for whatever still has it mounted), then invalidate its lists.
        const ownKey = DETAIL_KEY[e.entity]?.(e.id) ?? null;
        // A deleted page leaves the cached page lists at once (they are still refetched below), so an editor or page list that
        // shows it moves on in the same render instead of re-creating its removed detail query and fetching a 404.
        if (e.entity === 'page') qc.setQueriesData<Page[]>({ queryKey: ['pages'] }, (prev) => prev?.filter((p) => p.id !== e.id));
        if (ownKey) qc.removeQueries({ queryKey: ownKey, exact: true });
        for (const queryKey of keys) {
          if (ownKey && sameKey(queryKey, ownKey)) continue;
          void qc.invalidateQueries({ queryKey });
        }
        return;
      }
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
      return;
    }
  }
}

export type Connection = 'connecting' | 'open' | 'closed';
export const connectionStore = createStore<Connection>('connecting');
export function useConnection(): Connection {
  return useStore(connectionStore);
}

/** Opens /api/events, reconnects with backoff, and applies every event to the query cache. Mount once in the shell. */
export function useServerEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = (): void => {
      connectionStore.set('connecting');
      ws = new WebSocket(eventsUrl(window.location));
      ws.onopen = () => { attempt = 0; connectionStore.set('open'); };
      ws.onmessage = (m: MessageEvent) => {
        const e = parseEvent(m.data);
        if (e) applyServerEvent(qc, e);
      };
      ws.onclose = () => {
        // F11: a stopped socket (cleanup already ran, e.g. StrictMode's double mount or unmount)
        // must not touch the connection store or schedule a reconnect — under double mounting the
        // old socket's belated close can otherwise land after the new socket's open and leave
        // "Reconnecting to server" on screen forever.
        if (stopped) return;
        connectionStore.set('closed');
        timer = setTimeout(connect, nextBackoff(attempt++));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);
}
