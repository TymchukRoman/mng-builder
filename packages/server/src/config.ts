import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema, type AppConfig } from '@manga/shared';

export * from './health.js';
export * from './server-info.js';

export function configPath(): string {
  return join(homedir(), '.manga-builder', 'config.json');
}

/** Not under Documents: OneDrive syncs Documents and would corrupt SQLite. */
export function defaultLibraryPath(): string {
  return join(homedir(), 'MangaBuilder');
}

export interface LoadConfigOptions { env?: NodeJS.ProcessEnv; file?: string }

function readConfigFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid config file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** defaults < config.json < MANGA_LIBRARY / MANGA_PORT < explicit overrides. */
export function loadConfig(overrides: Partial<AppConfig> = {}, opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const merged: Record<string, unknown> = { libraryPath: defaultLibraryPath(), ...readConfigFile(opts.file ?? configPath()) };
  const library = env['MANGA_LIBRARY'];
  if (library) merged['libraryPath'] = library;
  const port = env['MANGA_PORT'];
  if (port) merged['port'] = Number(port);
  const result = AppConfigSchema.safeParse({ ...merged, ...overrides });
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  return result.data;
}
