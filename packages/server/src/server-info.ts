import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `<library>/server.json`: how the CLI finds a running server. */
export interface ServerInfo { pid: number; port: number; startedAt: string }

export function serverInfoPath(libraryPath: string): string {
  return join(libraryPath, 'server.json');
}

export function writeServerInfo(libraryPath: string, info: ServerInfo): void {
  writeFileSync(serverInfoPath(libraryPath), `${JSON.stringify(info, null, 2)}\n`);
}

/** The recorded server, or null when the file is missing or unreadable. It may be stale: always probe health. */
export function readServerInfo(libraryPath: string): ServerInfo | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(serverInfoPath(libraryPath), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const { pid, port, startedAt } = raw as Record<string, unknown>;
    if (typeof pid === 'number' && typeof port === 'number' && typeof startedAt === 'string') return { pid, port, startedAt };
    return null;
  } catch {
    return null;
  }
}

/** Removes server.json only if it still describes `pid`; a newer server may have replaced it. */
export function removeServerInfo(libraryPath: string, pid: number): void {
  if (readServerInfo(libraryPath)?.pid === pid) rmSync(serverInfoPath(libraryPath), { force: true });
}
