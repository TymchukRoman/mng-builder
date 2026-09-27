import type { Job } from '@manga/shared';
import { ensureServer } from './autostart.js';
import { ApiClient } from './client.js';
import type { CliIo } from './io.js';
import { createResolver, type Resolver } from './resolver.js';
import { waitForJobs } from './wait.js';

export type { Resolver } from './resolver.js';

export interface CliContext {
  api: ApiClient; json: boolean; wait: boolean; baseUrl: string; io: CliIo;
  out(data: unknown, human: () => string): void;              // --json → JSON.stringify(data, null, 2); else human()
  waitJobs(jobIds: string[]): Promise<Job[]>;                   // WS /api/events; prints "label value/max" lines to stderr unless --json
  resolve: Resolver;
}

export interface ContextOptions { json: boolean; wait: boolean; url: string | undefined; io: CliIo }

/** Finds (or auto-starts) the server and builds the context every command uses. */
export async function createContext(opts: ContextOptions): Promise<CliContext> {
  const baseUrl = await ensureServer({ url: opts.url, log: (line) => opts.io.stderr(`${line}\n`) });
  const api = new ApiClient(baseUrl);
  return {
    api,
    json: opts.json,
    wait: opts.wait,
    baseUrl,
    io: opts.io,
    out(data, human) {
      opts.io.stdout(`${opts.json ? JSON.stringify(data, null, 2) : human()}\n`);
    },
    waitJobs: (jobIds) => waitForJobs({ baseUrl, api, ids: jobIds, io: opts.io, json: opts.json }),
    resolve: createResolver(api),
  };
}
