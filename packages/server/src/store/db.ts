import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/** Opens (creating if needed) the library database in WAL mode with foreign keys enforced, then migrates it. */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** One transaction per migration: a half-applied schema is worse than none. */
export function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
