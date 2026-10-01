import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stepIndex, type ImageGeneratePayload } from '@manga/shared';
import { ConflictError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import { materializeScripts } from '../src/workflows/episode/effects.js';
import { missingPanelIds, renderMissing } from '../src/workflows/episode/missing.js';
import { patchStep } from '../src/workflows/episode/steps.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let queue: FakeQueue;
beforeEach(() => { lib = openTestLibrary(); queue = new FakeQueue(lib.store); });
afterEach(() => { lib.close(); });

/** Two story pages of two panels plus the cover; the first story panel has an image. */
function world() {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  seedCharacter(lib.store, manga.id, 'Aiko');
  const bd = breakdown(2);
  materializeScripts({ store: lib.store, bus: new EventBus() }, chapter.id, { breakdown: bd, scripts: scripts(bd, 'Aiko'), premise: PREMISE });
  const ids = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  lib.store.panels.update(ids[0]!, { activeImageId: seedImage(lib.store, manga.id, { type: 'panel', id: ids[0]! }, null).id });
  return { manga, chapter, ids, bd };
}

describe('render-missing (W1 R1)', () => {
  it('lists the story and cover panels without an image, cover last', () => {
    const { chapter, ids } = world();
    expect(missingPanelIds(lib.store, chapter.id)).toEqual(ids.slice(1));
  });

  it('queues one gpu generate job per missing panel, tagged with the latest run', () => {
    const { chapter, ids, bd } = world();
    const run = seedRun(lib.store, chapter.id, { outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd }, status: 'failed' });
    const refs = renderMissing(lib.store, queue.asQueue(), chapter.id);
    expect(refs).toHaveLength(4);
    const jobs = queue.jobs('image.generate');
    expect(jobs.map((j) => (j.payload as ImageGeneratePayload & { panelId: string }).panelId)).toEqual(ids.slice(1));
    expect(jobs.every((j) => j.lane === 'gpu' && j.episodeRunId === run.id)).toBe(true);
  });

  it('works without a run (untagged) and skips a panel that already has an unfinished generate job, tagged or not', () => {
    const { chapter, ids } = world();
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4); // no run: untagged
    expect(queue.jobs('image.generate').every((j) => j.episodeRunId === null)).toBe(true);
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toEqual([]); // a second click queues no duplicates
    for (const j of queue.jobs('image.generate')) queue.fail(j.id, 'ComfyUI down');
    const run = seedRun(lib.store, chapter.id, { status: 'failed' });
    queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: ids[1]! }, episodeRunId: run.id });
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(3);
  });

  it('sees an old queued generate behind many newer queued jobs: no duplicate (Task 5 M3)', () => {
    const { chapter, ids } = world();
    lib.store.jobs.insert({
      kind: 'image.generate', lane: 'gpu', priority: 0, payload: { target: 'panel', panelId: ids[1]! }, maxAttempts: 3,
      nextRunAt: new Date().toISOString(), episodeRunId: null,
    });
    for (let i = 0; i < 600; i++) {
      lib.store.jobs.insert({ kind: 'llm.step', lane: 'claude', priority: 0, payload: null, maxAttempts: 3, nextRunAt: new Date().toISOString(), episodeRunId: null });
    }
    const refs = renderMissing(lib.store, queue.asQueue(), chapter.id);
    expect(refs).toHaveLength(3);
    expect(queue.jobs('image.generate').map((j) => (j.payload as { panelId: string }).panelId)).toEqual(ids.slice(2));
  });

  it('refuses while the episode render step is running or paused; allowed at its preview stop', () => {
    const { chapter } = world();
    const run = seedRun(lib.store, chapter.id, { currentStep: 'render' });
    const at = (status: 'running' | 'paused' | 'awaiting-review') =>
      lib.store.episodes.update(run.id, { status: status === 'awaiting-review' ? 'awaiting-review' : status, steps: patchStep(run.steps, stepIndex('render'), { status }) });
    at('running');
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    at('paused');
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    at('awaiting-review');
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4);
  });

  it('refuses while an active run has not reached its render step: those panels get their prompts first (F8)', () => {
    const { chapter } = world();
    const run = seedRun(lib.store, chapter.id, { currentStep: 'prompts' });
    lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('prompts'), { status: 'running' }) });
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    lib.store.episodes.update(run.id, { status: 'awaiting-review', currentStep: stepIndex('scripts') });
    expect(() => renderMissing(lib.store, queue.asQueue(), chapter.id)).toThrow(ConflictError);
    expect(queue.jobs()).toEqual([]);
    lib.store.episodes.update(run.id, { status: 'failed', currentStep: stepIndex('prompts') }); // an ended run leaves the panels to the user
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4);
  });

  it('allows a run that is past its render step (lettering)', () => {
    const { chapter } = world();
    const run = seedRun(lib.store, chapter.id, { currentStep: 'lettering' });
    lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('lettering'), { status: 'running' }) });
    expect(renderMissing(lib.store, queue.asQueue(), chapter.id)).toHaveLength(4);
  });
});
