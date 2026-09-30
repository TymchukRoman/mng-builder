import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { SEED_MODULUS } from '../src/domain/seed.js';
import { enqueuePortraits } from '../src/imaging/portraits.js';
import { GpuArbiter, JobQueue, waitForJob } from '../src/jobs/index.js';
import { seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
let queue: JobQueue;
beforeEach(() => {
  lib = openTestLibrary();
  queue = new JobQueue({ store: lib.store, bus: new EventBus(), gpu: new GpuArbiter() }); // never started: jobs stay queued
});
afterEach(() => { lib.close(); });

const enqueue = () => queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: 'pn_x' } });

describe('waitForJob', () => {
  it('resolves with the finished job', async () => {
    const job = enqueue();
    const { signal } = new AbortController();
    const waiting = waitForJob(queue, job.id, signal);
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    queue.cancel(job.id);
    expect(await waiting).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(getEventListeners(signal, 'abort')).toEqual([]);
  });

  it('rejects with the abort reason while the job is still queued', async () => {
    const job = enqueue();
    const controller = new AbortController();
    const waiting = waitForJob(queue, job.id, controller.signal);
    const reason = new Error('server stopping');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(lib.store.jobs.require(job.id).status).toBe('queued');
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(waitForJob(queue, enqueue().id, controller.signal)).rejects.toThrow('gone');
  });
});

describe('enqueuePortraits', () => {
  it('queues n portrait jobs on the gpu lane with consecutive seeds that wrap at SEED_MODULUS', () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store);
    const aiko = lib.store.characters.update(seedCharacter(lib.store, manga.id, 'Aiko').id, { seed: SEED_MODULUS - 1 });
    const run = seedRun(lib.store, chapter.id);
    const jobs = enqueuePortraits(queue, aiko, 2, run.id);
    expect(jobs.map((j) => [j.kind, j.lane, j.episodeRunId, j.payload])).toEqual([
      ['image.generate', 'gpu', run.id, { target: 'character-portrait', characterId: aiko.id, seed: SEED_MODULUS - 1 }],
      ['image.generate', 'gpu', run.id, { target: 'character-portrait', characterId: aiko.id, seed: 0 }],
    ]);
    expect(enqueuePortraits(queue, aiko, 1)[0]!.episodeRunId).toBeNull();
  });
});
