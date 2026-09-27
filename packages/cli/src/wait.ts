import WebSocket from 'ws';
import type { Job, ServerEvent } from '@manga/shared';
import type { ApiClient } from './client.js';
import { onInterrupt, type CliIo } from './io.js';

const TERMINAL: ReadonlySet<Job['status']> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminalJob(job: Job): boolean {
  return TERMINAL.has(job.status);
}

/**
 * "label value/max", "label value", "label", the error of a failed job, "retrying: <error>" for a job back in the
 * queue after a transient failure (its old progress is stale), or ''.
 */
export function progressText(job: Job): string {
  if (job.status === 'failed' && job.error !== null) return `error: ${job.error}`;
  if (job.status === 'queued' && job.error !== null) return `retrying: ${job.error}`;
  if (job.progress === null) return '';
  const { label, value, max } = job.progress;
  if (value === undefined) return label;
  return max === undefined ? `${label} ${value}` : `${label} ${value}/${max}`;
}

export function openEvents(baseUrl: string): WebSocket {
  return new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/events`);
}

function parseEvent(raw: WebSocket.RawData): ServerEvent | null {
  try {
    return JSON.parse(String(raw)) as ServerEvent;
  } catch {
    return null;
  }
}

export interface WaitOptions { baseUrl: string; api: ApiClient; ids: readonly string[]; io: CliIo; json: boolean }

/** Resolves with the jobs (in `ids` order) once all are terminal. Progress lines go to stderr unless json. */
export function waitForJobs(opts: WaitOptions): Promise<Job[]> {
  if (opts.ids.length === 0) return Promise.resolve([]);
  const wanted = new Set(opts.ids);
  const done = new Map<string, Job>();
  const lastLine = new Map<string, string>();
  const ws = openEvents(opts.baseUrl);
  return new Promise<Job[]>((resolve, reject) => {
    let settled = false;
    const finish = (result: Job[] | Error): void => {
      if (settled) return;
      settled = true;
      ws.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const take = (job: Job): void => {
      if (!wanted.has(job.id) || done.has(job.id)) return;
      if (!opts.json) {
        const line = progressText(job);
        if (line !== '' && lastLine.get(job.id) !== line) {
          lastLine.set(job.id, line);
          opts.io.stderr(`${job.id} ${line}\n`);
        }
      }
      if (isTerminalJob(job)) {
        done.set(job.id, job);
        if (done.size === wanted.size) finish(opts.ids.map((id) => done.get(id) as Job));
      }
    };
    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (event?.type === 'hello') {
        // Subscribed: catch up on jobs that moved (or finished) before the stream opened.
        Promise.all(opts.ids.map((id) => opts.api.get<Job>(`/api/jobs/${encodeURIComponent(id)}`))).then(
          (jobs) => jobs.forEach(take),
          (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
        );
      } else if (event?.type === 'job') {
        take(event.job);
      }
    });
    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error('the event stream closed before the jobs finished')));
  });
}

export interface StreamOptions { baseUrl: string; io: CliIo; onReady(): Promise<void>; onJob(job: Job): void }

/** Streams job events until Ctrl+C or io.signal; `onReady` runs once the stream is subscribed. */
export function streamJobs(opts: StreamOptions): Promise<void> {
  const ws = openEvents(opts.baseUrl);
  return new Promise<void>((resolve, reject) => {
    const dispose = onInterrupt(opts.io.signal, () => ws.close());
    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (event?.type === 'hello') {
        opts.onReady().catch((err: unknown) => {
          dispose();
          reject(err);
          ws.close();
        });
      } else if (event?.type === 'job') {
        opts.onJob(event.job);
      }
    });
    ws.on('error', (err) => {
      dispose();
      reject(err);
    });
    ws.on('close', () => {
      dispose();
      resolve();
    });
  });
}
