import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import {
  EngineNameSchema, TaskSchema, type EngineName, type ServiceState, type ServiceStatus, type Settings, type SettingsPatch, type Task,
} from '@manga/shared';
import { liveServer, loadConfig } from '@manga/server/config';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { onInterrupt, processIo, type CliIo } from '../io.js';
import { serverAt, stopServer } from '../stop.js';

function browserCommand(url: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [url] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  const { cmd, args } = browserCommand(url);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    /* no browser: the URL is printed anyway */
  });
  child.unref();
}

const pad = (label: string): string => label.padEnd(8);

function serviceLine(name: string, state: ServiceState): string {
  return `${pad(name)}${state.ok ? 'ok  ' : 'down'}  ${state.detail}`;
}

export function formatStatus(status: ServiceStatus, baseUrl: string): string {
  const { queue } = status;
  return [
    `${pad('server')}${baseUrl}`,
    serviceLine('claude', status.claude),
    serviceLine('ollama', status.ollama),
    serviceLine('comfy', status.comfy),
    `${pad('queue')}${queue.queued} queued, ${queue.running} running`,
    ...queue.pausedLanes.map((p) => `${pad('paused')}${p.lane} ${p.until === null ? 'until resumed' : `until ${p.until}`} (${p.reason})`),
  ].join('\n');
}

export function formatEngine(settings: Settings): string {
  const { mode, tasks } = settings.engine;
  return [
    `${'mode'.padEnd(9)}${mode}`,
    ...TaskSchema.options.map((task) => {
      const override = tasks[task];
      return `${task.padEnd(9)}${override ?? mode}${override === undefined ? '' : ' (override)'}`;
    }),
  ].join('\n');
}

function parseEngine(value: string): EngineName {
  const parsed = EngineNameSchema.safeParse(value);
  if (!parsed.success) throw new CliError(`engine must be claude or local, got "${value}"`, 2);
  return parsed.data;
}

function parseTaskSpec(spec: string): [Task, EngineName | 'default'] {
  const [task = '', engine = ''] = spec.split('=', 2);
  const parsedTask = TaskSchema.safeParse(task);
  if (!parsedTask.success) throw new CliError(`unknown task "${task}" in "${spec}"; tasks are ${TaskSchema.options.join(', ')}`, 2);
  return [parsedTask.data, engine === 'default' ? 'default' : parseEngine(engine)];
}

export function registerServerCommands(program: Command, ctx: () => Promise<CliContext>, io: CliIo = processIo): void {
  program
    .command('serve')
    .description('run the server in this terminal until Ctrl+C')
    .option('--open', 'open the UI in the browser')
    .action(async (opts: { open?: boolean }) => {
      const { startServer } = await import('@manga/server');
      let end = (): void => {};
      const ended = new Promise<void>((resolve) => {
        end = resolve;
      });
      const server = await startServer({ onShutdown: () => end() }); // `manga stop` ends this command too
      io.stdout(`manga server listening on ${server.url} (library: ${server.deps.config.libraryPath})\n`);
      if (opts.open === true) openBrowser(server.url);
      const dispose = onInterrupt(io.signal, end);
      await ended;
      dispose();
      await server.stop();
    });

  program
    .command('stop')
    .description("stop this library's server (the one in <library>/server.json, or the one at --url)")
    .action(async () => {
      const url = program.opts<{ url?: string }>().url?.replace(/\/+$/, '');
      const running = url === undefined ? await liveServer(loadConfig().libraryPath) : await serverAt(url);
      if (running === null) {
        io.stdout('no server running\n');
        return;
      }
      await stopServer(running.url, running.pid);
      io.stdout(`stopped ${running.pid}\n`);
    });

  program
    .command('status')
    .description('server, engine, ComfyUI and queue status')
    .action(async () => {
      const c = await ctx();
      const status = await c.api.get<ServiceStatus>('/api/status');
      c.out(status, () => formatStatus(status, c.baseUrl));
    });

  program
    .command('engine')
    .description('show or set the AI engine, globally and per task')
    .argument('[mode]', 'claude or local')
    .option('--task <task=engine...>', 'per-task override, e.g. story=local; story=default clears it')
    .action(async (mode: string | undefined, opts: { task?: string[] }) => {
      const engineMode = mode === undefined ? undefined : parseEngine(mode);
      const specs = (opts.task ?? []).map(parseTaskSpec);
      const c = await ctx();
      const patch: SettingsPatch = {};
      if (engineMode !== undefined) patch.engine = { mode: engineMode };
      if (specs.length > 0) {
        const current = await c.api.get<Settings>('/api/settings');
        const tasks: Settings['engine']['tasks'] = { ...current.engine.tasks };
        for (const [task, engine] of specs) {
          if (engine === 'default') delete tasks[task];
          else tasks[task] = engine;
        }
        patch.engine = { ...patch.engine, tasks };
      }
      const settings = patch.engine === undefined
        ? await c.api.get<Settings>('/api/settings')
        : await c.api.patch<Settings>('/api/settings', patch);
      c.out(settings.engine, () => formatEngine(settings));
    });
}
