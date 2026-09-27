import { Command, CommanderError } from 'commander';
import { registerMangaCommands } from './commands/mangas.js';
import { registerServerCommands } from './commands/server.js';
import { createContext, type CliContext } from './context.js';
import { CliError } from './errors.js';
import { processIo, type CliIo } from './io.js';
import { VERSION } from './version.js';

export interface GlobalOptions { json?: boolean; wait?: boolean; url?: string }
export type ContextFactory = (opts: GlobalOptions, io: CliIo) => Promise<CliContext>;

export const defaultContextFactory: ContextFactory = (opts, io) =>
  createContext({ json: opts.json === true, wait: opts.wait === true, url: opts.url, io });

export function buildProgram(io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Command {
  const program = new Command('manga')
    .description('Manga Builder from the command line')
    .version(VERSION)
    .option('--json', 'print raw API data as JSON')
    .option('--wait', 'wait for started jobs to finish, streaming progress to stderr')
    .option('--url <baseUrl>', 'server URL (default: <library>/server.json, else http://127.0.0.1:4317); never auto-starts')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });
  let context: Promise<CliContext> | null = null;
  const ctx = (): Promise<CliContext> => (context ??= factory(program.opts<GlobalOptions>(), io));
  registerServerCommands(program, ctx, io);
  registerMangaCommands(program, ctx);
  return program;
}

/** 0 for help/version; 2 for usage errors; the CliError's code; 1 for everything else (message on stderr). */
export function exitCodeFor(err: unknown, io: CliIo): number {
  if (err instanceof CommanderError) {
    return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2;
  }
  if (err instanceof CliError) {
    if (!err.silent) io.stderr(`error: ${err.message}\n`);
    return err.exitCode;
  }
  io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

export async function runCli(argv: readonly string[], io: CliIo = processIo, factory: ContextFactory = defaultContextFactory): Promise<number> {
  try {
    await buildProgram(io, factory).parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    return exitCodeFor(err, io);
  }
}
