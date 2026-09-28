import { JobSchema, type Job, type JobKind, type JobStatus, type Lane } from '@manga/shared';
import type { Db } from './db.js';
import { TableRepo } from './table.js';
import type { JobInsert, JobPatch, JobRepo } from './types.js';

type NewJobRow = Omit<Job, 'id' | 'createdAt'> & { id?: string };

export class SqliteJobRepo extends TableRepo<Job, NewJobRow, JobPatch> implements JobRepo {
  constructor(db: Db, now: () => string) {
    super(db, {
      table: 'jobs', entity: 'job', prefix: 'jb', schema: JobSchema, hasUpdatedAt: false, orderBy: 'created_at DESC, rowid DESC',
      columns: {
        id: 'id', kind: 'kind', lane: 'lane', status: 'status', priority: 'priority', payload: ['payload', 'json'],
        result: ['result', 'json'], error: 'error', attempts: 'attempts', maxAttempts: 'max_attempts', nextRunAt: 'next_run_at',
        progress: ['progress', 'json'], episodeRunId: 'episode_run_id', createdAt: 'created_at', startedAt: 'started_at',
        finishedAt: 'finished_at',
      },
    }, now);
  }

  insert(input: JobInsert): Job {
    return this.create({
      ...input, status: 'queued', attempts: 0, result: null, error: null, progress: null, startedAt: null, finishedAt: null,
    });
  }

  list(filter: { status?: JobStatus; limit: number }): Job[] {
    const where = filter.status === undefined ? '1 = 1' : 'status = ?';
    const params = filter.status === undefined ? [] : [filter.status];
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, filter.limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decode(row));
  }

  listQueued(kinds: readonly JobKind[]): Job[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' AND kind IN (${kinds.map(() => '?').join(', ')})
                ORDER BY created_at ASC, rowid ASC`)
      .all(...kinds) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decode(row));
  }

  claimNext(lane: Lane, nowIso: string): Job | null {
    return this.db.transaction((): Job | null => {
      const row = this.db
        .prepare(`SELECT id FROM jobs WHERE lane = ? AND status = 'queued' AND next_run_at <= ?
                  ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1`)
        .get(lane, nowIso) as { id: string } | undefined;
      if (row === undefined) return null;
      this.db
        .prepare(`UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL, attempts = attempts + 1 WHERE id = ?`)
        .run(nowIso, row.id);
      return this.require(row.id);
    })();
  }

  resetRunning(): number {
    return this.db.prepare(`UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`).run().changes;
  }

  counts(): { queued: number; running: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const count = (status: string): number => rows.find((r) => r.status === status)?.n ?? 0;
    return { queued: count('queued'), running: count('running') };
  }
}
