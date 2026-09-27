import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir { path: string; cleanup(): void }

/** A fresh directory under the OS temp folder. Close SQLite before cleanup on Windows. */
export function tempDir(prefix = 'manga-test-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
