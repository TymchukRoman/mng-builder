import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@manga/shared';
import { openStore, type JobInsert, type Store } from '../src/store/index.js';
import { seedManga } from './helpers/store.js';
import { tempDir, type TempDir } from './helpers/tmp.js';

let dir: TempDir;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = openStore(dir.path);
});
afterEach(() => {
  store.close();
  dir.cleanup();
});

const insert = (over: Partial<JobInsert> = {}) =>
  store.jobs.insert({
    kind: 'image.generate', lane: 'gpu', priority: 0, payload: { n: 1 }, maxAttempts: 3,
    nextRunAt: '2026-01-01T00:00:00.000Z', episodeRunId: null, ...over,
  });

describe('openStore', () => {
  it('creates library.sqlite inside the library folder', () => {
    expect(existsSync(join(dir.path, 'library.sqlite'))).toBe(true);
    expect(store.files.root).toBe(dir.path);
  });

  it('rolls back a transaction that throws', () => {
    expect(() => store.tx(() => {
      seedManga(store);
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.mangas.list()).toEqual([]);
  });
});

describe('job repo', () => {
  it('inserts queued jobs with zero attempts and a JSON payload', () => {
    const job = insert();
    expect(job.id).toMatch(/^jb_/);
    expect(job).toMatchObject({ status: 'queued', attempts: 0, result: null, error: null, progress: null, startedAt: null, finishedAt: null, payload: { n: 1 } });
    expect(store.jobs.require(job.id)).toEqual(job);
  });

  it('claims the highest priority, then oldest, due job of the lane', () => {
    const low = insert({ priority: 0 });
    const high = insert({ priority: 5 });
    const notDue = insert({ priority: 9, nextRunAt: '2099-01-01T00:00:00.000Z' });
    insert({ lane: 'cpu', priority: 99 });
    const now = '2026-06-01T00:00:00.000Z';
    expect(store.jobs.claimNext('gpu', now)).toMatchObject({ id: high.id, status: 'running', attempts: 1, startedAt: now });
    expect(store.jobs.claimNext('gpu', now)?.id).toBe(low.id);
    expect(store.jobs.claimNext('gpu', now)).toBeNull();
    expect(store.jobs.require(notDue.id).status).toBe('queued');
  });

  it('resets running jobs to queued and counts by status', () => {
    insert();
    insert();
    store.jobs.claimNext('gpu', '2026-06-01T00:00:00.000Z');
    expect(store.jobs.counts()).toEqual({ queued: 1, running: 1 });
    expect(store.jobs.resetRunning()).toBe(1);
    expect(store.jobs.counts()).toEqual({ queued: 2, running: 0 });
  });

  it('lists newest first with an optional status filter and a limit', () => {
    const a = insert();
    const b = insert();
    const c = insert();
    store.jobs.update(b.id, { status: 'failed', error: 'x' });
    expect(store.jobs.list({ limit: 10 }).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect(store.jobs.list({ status: 'failed', limit: 10 }).map((j) => j.id)).toEqual([b.id]);
    expect(store.jobs.list({ limit: 2 })).toHaveLength(2);
  });
});

describe('settings repo', () => {
  it('returns the defaults until patched', () => {
    expect(store.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges patches section by section and replaces engine.tasks whole', () => {
    store.settings.patch({ engine: { tasks: { story: 'local', review: 'local' } } });
    store.settings.patch({ engine: { mode: 'local' }, claude: { models: { story: 'sonnet' } }, review: { rounds: 1 } });
    const s = store.settings.get();
    expect(s.engine).toEqual({ mode: 'local', tasks: { story: 'local', review: 'local' } });
    expect(s.claude.models).toEqual({ ...DEFAULT_SETTINGS.claude.models, story: 'sonnet' });
    expect(s.review).toEqual({ autoInEpisode: true, rounds: 1 });
    expect(store.settings.patch({ engine: { tasks: {} } }).engine.tasks).toEqual({});
    expect(store.settings.patch({ routing: { bwRefine: 'anime-refine' } }).routing.bwRefine).toBe('anime-refine');
    expect(store.settings.patch({ routing: { bwRefine: null } }).routing.bwRefine).toBeNull();
  });

  it('persists across reopen and rejects invalid values', () => {
    store.settings.patch({ ollama: { textModel: 'qwen3:32b' } });
    store.close();
    store = openStore(dir.path);
    expect(store.settings.get().ollama.textModel).toBe('qwen3:32b');
    expect(() => store.settings.patch({ review: { rounds: 9 } })).toThrow();
    expect(store.settings.get().review.rounds).toBe(2);
  });
});
