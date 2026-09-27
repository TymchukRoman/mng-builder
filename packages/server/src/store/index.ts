import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { createEntityRepos } from './entities.js';
import { createLibraryFiles } from './files.js';
import { SqliteJobRepo } from './jobs.js';
import { SqliteSettingsRepo } from './settings.js';
import type { Store } from './types.js';

export { NotFoundError } from '../errors.js';
export type * from './types.js';

/** Opens the library: `<libraryPath>/library.sqlite` plus the image files beside it. */
export function openStore(libraryPath: string): Store {
  mkdirSync(libraryPath, { recursive: true });
  const db = openDatabase(join(libraryPath, 'library.sqlite'));
  const now = (): string => new Date().toISOString();
  return {
    ...createEntityRepos(db, now),
    jobs: new SqliteJobRepo(db, now),
    settings: new SqliteSettingsRepo(db),
    files: createLibraryFiles(libraryPath),
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
    close: () => {
      db.close();
    },
  };
}
