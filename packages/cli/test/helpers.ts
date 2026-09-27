import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '@manga/server';
import { runCli } from '../src/program.js';

export { makePng } from '../../server/test/helpers/png.js';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface Started { result: Promise<RunResult>; output(): string }
export interface Harness {
  url: string;
  lib: string;
  server: RunningServer;
  /** `manga --url <server> …args`, capturing stdout/stderr. */
  run(...args: string[]): Promise<RunResult>;
  /** Same with --json; throws unless the exit code is 0; returns the parsed stdout. */
  json<T>(...args: string[]): Promise<T>;
  /** Starts a long-running command (serve, jobs --watch) that ends when `signal` aborts. */
  start(args: string[], signal: AbortSignal): Started;
  close(): Promise<void>;
}

/** An in-process server on a random port over a temp library, and a runner for the real commander program. */
export async function startHarness(): Promise<Harness> {
  const lib = mkdtempSync(join(tmpdir(), 'manga-cli-'));
  const server = await startServer({ config: { libraryPath: lib, port: 0 }, uiDir: null });
  const exec = (args: string[], signal?: AbortSignal): Started => {
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (s: string) => {
        stdout += s;
      },
      stderr: (s: string) => {
        stderr += s;
      },
      ...(signal ? { signal } : {}),
    };
    const result = runCli(['--url', server.url, ...args], io).then((code) => ({ code, stdout, stderr }));
    return { result, output: () => stdout };
  };
  return {
    url: server.url,
    lib,
    server,
    run: (...args) => exec(args).result,
    async json<T>(...args: string[]): Promise<T> {
      const r = await exec(['--json', ...args]).result;
      if (r.code !== 0) throw new Error(`manga ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout) as T;
    },
    start: (args, signal) => exec(args, signal),
    async close() {
      await server.stop();
      rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
