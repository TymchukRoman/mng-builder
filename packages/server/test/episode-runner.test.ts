import { getEventListeners, getMaxListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { EpisodeInput, ImageGeneratePayload, Job, LlmStepPayload, ServerEvent } from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createPage, NeedsConfirmError } from '../src/domain/pages.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { Engines, relaneTextJobs } from '../src/engines/resolve.js';
import { ScriptedEngine, type ScriptedResponse } from '../src/engines/scripted.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { EventBus } from '../src/events/bus.js';
import { GpuArbiter, JobQueue } from '../src/jobs/index.js';
import { storyPages } from '../src/workflows/episode/chapter.js';
import { EpisodeRunner } from '../src/workflows/episode/runner.js';
import { PREMISE, TWO_PANEL_PRESET, outline, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeImaging, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
});
afterEach(() => { vi.restoreAllMocks(); lib.close(); });

interface Rig { runner: EpisodeRunner; queue: FakeQueue; claude: ScriptedEngine; local: ScriptedEngine; engines: Engines }

/**
 * A runner on a FakeQueue. auto: llm.step and imaging jobs run by themselves; manual: jobs stay queued.
 * imaging: false leaves image jobs queued while the llm.step jobs still run.
 */
function rig(opts: { auto?: boolean; imaging?: boolean; responses?: Record<string, ScriptedResponse> } = {}): Rig {
  const claude = new ScriptedEngine('claude', { ...FAKE_RESPONSES, ...opts.responses });
  const local = new ScriptedEngine('local', { ...FAKE_RESPONSES, ...opts.responses });
  const engines = new Engines({ settings: () => lib.store.settings.get(), claude, local });
  const queue = new FakeQueue(lib.store);
  const runner = new EpisodeRunner({ store: lib.store, bus, queue: queue.asQueue(), engines, newSeed: () => 1 });
  if (opts.auto !== false) {
    queue.on('llm.step', (job, signal) => runner.handleStepJob(fakeJobContext(lib.store, bus, queue, job, signal), job.payload as LlmStepPayload));
    if (opts.imaging !== false) fakeImaging(lib.store, queue);
  }
  return { runner, queue, claude, local, engines };
}

function world() {
  const w = seedEpisodeWorld(lib.store);
  const aiko = seedCharacter(lib.store, w.manga.id, 'Aiko');
  const input: EpisodeInput = { prompt: 'Aiko finds a cat in the rain', characterIds: [aiko.id], pages: 2, tone: '' };
  return { ...w, aiko, input };
}

const stepStatuses = (runId: string) => lib.store.episodes.require(runId).steps.map((s) => s.status);
const portraitJobs = (queue: FakeQueue): Job[] =>
  queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait');

/** A rig whose queue refuses image.generate jobs, so accepting an outline with a new character throws (M1). */
function portraitQueueDown(opts: { auto?: boolean } = {}) {
  const engines = new Engines({
    settings: () => lib.store.settings.get(), claude: new ScriptedEngine('claude', FAKE_RESPONSES), local: new ScriptedEngine('local', FAKE_RESPONSES),
  });
  const queue = new FakeQueue(lib.store);
  const flaky = {
    enqueue: (input: Parameters<FakeQueue['enqueue']>[0]) => {
      if (input.kind === 'image.generate') throw new Error('portrait queue down');
      return queue.enqueue(input);
    },
    cancel: (id: string) => queue.cancel(id),
    waitFor: (id: string) => queue.waitFor(id),
  };
  const runner = new EpisodeRunner({ store: lib.store, bus, queue: flaky, engines });
  if (opts.auto) {
    queue.on('llm.step', (job, signal) => runner.handleStepJob(fakeJobContext(lib.store, bus, queue, job, signal), job.payload as LlmStepPayload));
  }
  return { runner, queue };
}

describe('EpisodeRunner — flow', () => {
  it('review mode stops at the outline, with the premise written to the chapter', async () => {
    const { chapter, input } = world();
    const { runner, queue, claude } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    expect(stepStatuses(run.id)).toEqual(['done', 'awaiting-review', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 1 });
    expect(lib.store.chapters.require(chapter.id)).toMatchObject({ title: 'The Cat in the Rain', status: 'generating' });
    expect(claude.calls[0]).toMatchObject({ name: 'episode.premise', task: 'story' });
    expect(claude.calls[0]!.prompt).toContain('<context>');
    expect(claude.calls[0]!.system).toContain('in English');
    expect(queue.jobs('llm.step').map((j) => j.lane)).toEqual(['claude', 'claude']);
  });

  it('approving the outline creates the new characters, queues their portraits and continues to scripts', async () => {
    const { chapter, manga, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.approve(run.id);
    await queue.idle();
    const mika = lib.store.characters.listByManga(manga.id).find((c) => c.name === 'Mika')!;
    const portraits = portraitJobs(queue);
    expect(portraits.map((j) => (j.payload as { characterId: string }).characterId)).toEqual([mika.id, mika.id, mika.id, mika.id]);
    expect(portraits.every((j) => j.episodeRunId === run.id)).toBe(true);
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
    expect(storyPages(lib.store, chapter.id)).toHaveLength(2);
  });

  it('autopilot runs every step to the end and marks the chapter ready', async () => {
    const { chapter, manga, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
    expect(stepStatuses(run.id).every((s) => s === 'done')).toBe(true);
    const ch = lib.store.chapters.require(chapter.id);
    expect(ch.status).toBe('ready');
    const pages = storyPages(lib.store, chapter.id);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(lib.store.panels.listByPage(page.id).every((p) => p.activeImageId !== null && p.prompt.scene !== '')).toBe(true);
      expect(lib.store.frames.listByPage(page.id).length).toBeGreaterThan(0);
    }
    expect(lib.store.frames.listByPage(ch.coverPageId!).map((f) => f.kind)).toEqual(['title']);
    const mika = lib.store.characters.listByManga(manga.id).find((c) => c.name === 'Mika')!;
    expect(mika.refs.portrait).toBeDefined();
    const steps = queue.jobs('llm.step').map((j) => [(j.payload as { step: string }).step, j.lane, j.maxAttempts]);
    expect(steps).toEqual([
      ['premise', 'claude', 3], ['outline', 'claude', 3], ['breakdown', 'claude', 3], ['scripts', 'claude', 3],
      ['prompts', 'claude', 3], ['render', 'cpu', 1], ['lettering', 'cpu', 1],
    ]);
  });

  it('uses the lane of the engine chosen for each task', async () => {
    lib.store.settings.patch({ engine: { tasks: { prompts: 'local' } } });
    const { chapter, input } = world();
    const { runner, queue, local } = rig();
    runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const lanes = Object.fromEntries(queue.jobs('llm.step').map((j) => [(j.payload as { step: string }).step, j.lane]));
    expect(lanes).toMatchObject({ scripts: 'claude', prompts: 'gpu' });
    expect(local.calls.map((c) => c.name).every((n) => n === 'episode.prompts')).toBe(true);
    expect(local.calls.length).toBeGreaterThan(0);
  });

  it('"run to end" from a review point switches to autopilot and finishes', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    expect(runner.autopilot(run.id).mode).toBe('autopilot');
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
  });

  it('get and latest: 404 for an unknown run or chapter, null before the first run', () => {
    const { chapter } = world();
    const { runner } = rig({ auto: false });
    expect(() => runner.get('er_missing')).toThrow(NotFoundError);
    expect(() => runner.latest('ch_missing')).toThrow(NotFoundError);
    expect(runner.latest(chapter.id)).toBeNull();
  });
});

describe('EpisodeRunner — engines (F1, I1)', () => {
  it('an episode step job carries its task, so an engine switch re-lanes it while queued', () => {
    const { chapter, input } = world();
    const engines = new Engines({ settings: () => lib.store.settings.get(), claude: new ScriptedEngine('claude', {}), local: new ScriptedEngine('local', {}) });
    const queue = new JobQueue({ store: lib.store, bus, gpu: new GpuArbiter() }); // never started: jobs stay queued
    const runner = new EpisodeRunner({ store: lib.store, bus, queue, engines });
    const run = runner.start(chapter.id, input, 'review');
    const [job] = lib.store.jobs.listByEpisodeRun(run.id);
    expect(job!.lane).toBe('claude');
    lib.store.settings.patch({ engine: { mode: 'local' } });
    expect(relaneTextJobs(lib.store, queue, engines).map((j) => j.id)).toEqual([job!.id]);
    expect(lib.store.jobs.require(job!.id).lane).toBe('gpu');
    runner.stop();
  });

  it('a claude-lane step runs on claude even when the settings now say local', async () => {
    const { chapter, input } = world();
    const { runner, queue, claude, local } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    lib.store.settings.patch({ engine: { mode: 'local' } });
    const [job] = queue.jobs('llm.step');
    await runner.handleStepJob(fakeJobContext(lib.store, bus, queue, job!), job!.payload as LlmStepPayload);
    expect(claude.calls.map((c) => c.name)).toEqual(['episode.premise']);
    expect(local.calls).toEqual([]);
    expect(runner.get(run.id).steps[0]!.status).toBe('done');
  });
});

describe('EpisodeRunner — guards', () => {
  it('start refuses a chapter that already has pages', () => {
    const { chapter, input } = world();
    createPage(lib.store, chapter.id, TWO_PANEL_PRESET);
    const { runner } = rig({ auto: false });
    expect(() => runner.start(chapter.id, input, 'review')).toThrow(ConflictError);
    expect(lib.store.episodes.latestByChapter(chapter.id)).toBeNull();
  });

  it('start refuses a second active run and characters of another manga', () => {
    const { chapter, input } = world();
    const other = seedEpisodeWorld(lib.store, { mangaTitle: 'Other' });
    const stranger = seedCharacter(lib.store, other.manga.id, 'Stranger');
    const { runner } = rig({ auto: false });
    expect(() => runner.start(chapter.id, { ...input, characterIds: [stranger.id] }, 'review')).toThrow(ValidationError);
    runner.start(chapter.id, input, 'review');
    expect(() => runner.start(chapter.id, input, 'review')).toThrow('an episode run is already active for this chapter; cancel it first');
  });

  it('approve refuses a run that is not waiting for review', () => {
    const { chapter, input } = world();
    const { runner } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    expect(() => runner.approve(run.id)).toThrow('nothing to approve: the run is not waiting for review');
  });
});

describe('EpisodeRunner — failure, retry, edit, rerun, cancel', () => {
  it('a failing step fails the run with the engine message, and retrying it continues', async () => {
    let fail = true;
    const { chapter, input } = world();
    const { runner, queue } = rig({
      responses: {
        'episode.breakdown': (req) => {
          if (fail) throw new Error('model overloaded');
          return EPISODE_FAKE_RESPONSES['episode.breakdown']!(req);
        },
      },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const failed = runner.get(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.steps[2]).toMatchObject({ name: 'breakdown', status: 'failed', error: 'model overloaded' });
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
    const token = failed.steps[2]!.startedAt;
    fail = false;
    const retried = runner.rerun(run.id, 'breakdown', false);
    expect(retried.steps[2]!.startedAt).toBe(token); // a retry keeps the step's token
    await queue.idle();
    expect(runner.get(run.id).status).toBe('done');
  });

  it('edits are validated against the refined schema and premise edits reach the chapter', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.editOutput(run.id, 'premise', { ...PREMISE, title: 'A New Title' });
    expect(lib.store.chapters.require(chapter.id).title).toBe('A New Title');
    expect(runner.get(run.id).steps[0]!.output).toMatchObject({ title: 'A New Title' });
    expect(() => runner.editOutput(run.id, 'outline', { scenes: [], newCharacters: [] })).toThrow(ZodError);
    expect(() => runner.editOutput(run.id, 'render', { jobs: [], reviewed: 0, flagged: 0, rounds: 0 })).toThrow(ValidationError);
    expect(() => runner.editOutput(run.id, 'breakdown', { pages: [] })).toThrow('step breakdown has no output to edit (it is pending)');
  });

  it('a prompts edit is stored verbatim on the panels (no camera prepend, no colour strip)', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.approve(run.id); // outline → breakdown → scripts (review point)
    await queue.idle();
    runner.approve(run.id); // scripts → prompts → render (which stops: nobody picked Mika's portrait)
    await queue.idle();
    expect(runner.get(run.id).steps[4]!.status).toBe('done');
    const prompts = runner.get(run.id).steps[4]!.output as { panels: Array<{ panelId: string; scene: string }> };
    const edited = { panels: prompts.panels.map((p) => ({ ...p, scene: 'red umbrella, rain' })) };
    runner.editOutput(run.id, 'prompts', edited);
    for (const p of prompts.panels) expect(lib.store.panels.require(p.panelId).prompt.scene).toBe('red umbrella, rain');
  });

  it('re-running a step at or before scripts needs confirm once pages exist, then replaces them', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const pagesBefore = storyPages(lib.store, chapter.id);
    const before = pagesBefore.map((p) => p.id);
    const panelsBefore = pagesBefore.flatMap((p) => lib.store.panels.listByPage(p.id).map((pn) => pn.id));
    const err = (() => { try { runner.rerun(run.id, 'scripts', false); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(NeedsConfirmError);
    expect((err as NeedsConfirmError).removedPanelIds).toHaveLength(4);
    expect((err as NeedsConfirmError).message).toBe("re-running scripts replaces the chapter's pages; resend with confirm=true");
    events.length = 0;
    const rerun = runner.rerun(run.id, 'scripts', true);
    expect(rerun.steps.slice(3).every((s) => s.status === 'pending' || s.status === 'running')).toBe(true);
    // F7: exactly what DELETE /api/pages/:id emits, per page: panel deleted for each panel, then page deleted.
    const deletions = events
      .filter((e): e is Extract<ServerEvent, { type: 'entity' }> => e.type === 'entity' && e.op === 'deleted')
      .map((e) => `${e.entity}:${e.id}`);
    expect(deletions).toEqual([
      `panel:${panelsBefore[0]}`, `panel:${panelsBefore[1]}`, `page:${before[0]}`,
      `panel:${panelsBefore[2]}`, `panel:${panelsBefore[3]}`, `page:${before[1]}`,
    ]);
    await queue.idle();
    const after = storyPages(lib.store, chapter.id).map((p) => p.id);
    expect(runner.get(run.id).status).toBe('done');
    expect(after).toHaveLength(2);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it('a rerun keeps the queued character-portrait jobs; cancelling the run cancels them', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ imaging: false });
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.approve(run.id);
    await queue.idle();
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
    const portraits = portraitJobs(queue);
    expect(portraits).toHaveLength(4);
    runner.rerun(run.id, 'breakdown', true);
    await queue.idle();
    expect(portraits.map((j) => lib.store.jobs.require(j.id).status)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
    runner.cancel(run.id);
    expect(portraits.map((j) => lib.store.jobs.require(j.id).status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
  });

  it('re-running the outline after its characters exist re-proposes them without failing or duplicating', async () => {
    const { chapter, manga, input } = world();
    const { runner, queue } = rig();
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    runner.approve(run.id);
    await queue.idle();
    expect(runner.get(run.id).currentStep).toBe(3);
    runner.rerun(run.id, 'outline', true);
    await queue.idle();
    const outline = runner.get(run.id).steps[1]!;
    expect(outline.status).toBe('awaiting-review');
    expect((outline.output as { newCharacters: Array<{ name: string }> }).newCharacters.map((c) => c.name)).toEqual(['Mika']);
    runner.approve(run.id);
    await queue.idle();
    expect(runner.get(run.id)).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
    expect(lib.store.characters.listByManga(manga.id).filter((c) => c.name === 'Mika')).toHaveLength(1);
    expect(portraitJobs(queue)).toHaveLength(4);
    expect(storyPages(lib.store, chapter.id)).toHaveLength(2);
  });

  it('an answer that stays invalid fails the step and keeps the raw output in the error', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ responses: { 'episode.premise': () => ({ title: '', synopsis: 'x' }) } });
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    const step = runner.get(run.id).steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.error).toContain('--- raw output ---');
    expect(step.error).toContain('"synopsis":"x"');
  });

  it('the raw output appears once, not also in the engine message (F25)', async () => {
    const raw = '{"title":"","synopsis":"only once"}';
    const { chapter, input } = world();
    const { runner, queue } = rig({
      responses: {
        'episode.premise': () => {
          throw new InvalidOutputError(`episode.premise: the answer still did not match after one correction round (title: too short). Raw output: ${raw}`, raw);
        },
      },
    });
    const run = runner.start(chapter.id, input, 'review');
    await queue.idle();
    const error = runner.get(run.id).steps[0]!.error!;
    expect(error).toBe(`episode.premise: the answer still did not match after one correction round (title: too short).\n--- raw output ---\n${raw}`);
    expect(error.split('only once')).toHaveLength(2);
  });

  it('a prompts answer with no usable scene fails the step cleanly, naming the panel, with its raw output', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({
      responses: {
        'episode.prompts': (req) => {
          const answer = EPISODE_FAKE_RESPONSES['episode.prompts']!(req) as { panels: Array<{ panelId: string; scene: string }> };
          return { panels: answer.panels.map((p, i) => (i === 0 ? { ...p, scene: 'upper body, ...' } : p)) };
        },
      },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const failed = runner.get(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.steps[4]!.status).toBe('failed');
    expect(failed.steps[4]!.error).toMatch(/^prompts: the AI wrote no usable scene for panel pn_\w+\n--- raw output ---\nupper body, \.\.\.$/);
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
    const pages = storyPages(lib.store, chapter.id);
    expect(pages.flatMap((p) => lib.store.panels.listByPage(p.id)).every((p) => p.prompt.scene === '')).toBe(true);
  });

  it('cancel stops the run, cancels its queued jobs and returns the chapter to draft', () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    const [job] = queue.jobs('llm.step');
    const cancelled = runner.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[0]).toMatchObject({ status: 'failed', error: 'Cancelled' });
    expect(lib.store.jobs.require(job!.id).status).toBe('cancelled');
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
  });
});

describe('EpisodeRunner — restart safety', () => {
  it('resume re-attaches to a queued step job instead of enqueueing a duplicate, and that watch drives the step', async () => {
    const { chapter, input } = world();
    const first = rig({ auto: false });
    first.runner.start(chapter.id, input, 'review');
    expect(first.queue.jobs('llm.step')).toHaveLength(1);
    first.runner.stop(); // the old process is gone: only the restarted runner watches the job
    const restarted = rig({ auto: false });
    expect(restarted.runner.resume()).toBe(1);
    expect(restarted.queue.jobs()).toEqual([]);
    const [job] = first.queue.jobs('llm.step');
    restarted.queue.fail(job!.id, 'engine gone');
    await restarted.queue.idle();
    expect(lib.store.episodes.latestByChapter(chapter.id)!.steps[0]).toMatchObject({ status: 'failed', error: 'engine gone' });
  });

  it('resume enqueues a pending current step and a running step whose job is gone', () => {
    const a = world();
    seedRun(lib.store, a.chapter.id, { outputs: { premise: PREMISE } });
    const b = seedEpisodeWorld(lib.store, { mangaTitle: 'Second' });
    const orphan = seedRun(lib.store, b.chapter.id);
    lib.store.episodes.update(orphan.id, { steps: orphan.steps.map((s, i) => (i === 0 ? { ...s, status: 'running', startedAt: '2026-09-27T00:00:00.000Z' } : s)) });
    const { runner, queue } = rig({ auto: false });
    expect(runner.resume()).toBe(2);
    expect(queue.jobs('llm.step').map((j) => (j.payload as { step: string }).step).sort()).toEqual(['outline', 'premise']);
  });

  it('resume moves on from a done current step (stopped between completing it and dispatching the next)', () => {
    const { chapter } = world();
    const run = seedRun(lib.store, chapter.id, { mode: 'autopilot', outputs: { premise: PREMISE }, currentStep: 'premise' });
    const { runner, queue } = rig({ auto: false });
    expect(runner.resume()).toBe(1);
    expect(runner.get(run.id)).toMatchObject({ status: 'running', currentStep: 1 });
    expect(queue.jobs('llm.step').map((j) => (j.payload as { step: string }).step)).toEqual(['outline']);
  });

  it('stop releases the job watches and dispatches nothing more', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ auto: false });
    const run = runner.start(chapter.id, input, 'review');
    const lifetime = (runner as unknown as { lifetime: AbortController }).lifetime.signal;
    expect(getEventListeners(lifetime, 'abort')).toHaveLength(1); // the step job's watch
    expect(getMaxListeners(lifetime)).toBe(0); // many watched jobs never warn (review M4)
    runner.stop();
    expect(lifetime.aborted).toBe(true);
    expect(getEventListeners(lifetime, 'abort')).toHaveLength(0);
    const [job] = queue.jobs('llm.step');
    queue.fail(job!.id, 'server stopping');
    await queue.idle();
    expect(runner.get(run.id).steps[0]!.status).toBe('running'); // left for resume() after the restart
  });

  it('an error while moving a run on during resume fails that run and resumes the others (M1)', () => {
    const bad = world();
    lib.store.chapters.update(bad.chapter.id, { status: 'generating' });
    const mika = { name: 'Mika', role: 'supporting' as const, personality: 'cheerful', speechStyle: 'short', appearanceTags: '1girl' };
    const broken = seedRun(lib.store, bad.chapter.id, {
      mode: 'autopilot', outputs: { premise: PREMISE, outline: outline(['Aiko'], [mika]) }, currentStep: 'outline',
    });
    const good = seedEpisodeWorld(lib.store, { mangaTitle: 'Second' });
    const healthy = seedRun(lib.store, good.chapter.id);
    const { runner, queue } = portraitQueueDown();
    expect(runner.resume()).toBe(1);
    expect(runner.get(broken.id)).toMatchObject({ status: 'failed' });
    expect(runner.get(broken.id).steps[1]).toMatchObject({ status: 'failed', error: 'portrait queue down' });
    expect(lib.store.chapters.require(bad.chapter.id).status).toBe('draft');
    expect(runner.get(healthy.id).steps[0]!.status).toBe('running');
    expect(queue.jobs('llm.step').map((j) => (j.payload as { runId: string }).runId)).toEqual([healthy.id]);
  });

  it('an error while accepting a finished step fails the run instead of leaving it running (M1)', async () => {
    const { chapter, input } = world();
    const { runner, queue } = portraitQueueDown({ auto: true });
    const run = runner.start(chapter.id, input, 'autopilot');
    await queue.idle();
    const after = runner.get(run.id);
    expect(after.status).toBe('failed');
    expect(after.steps[1]).toMatchObject({ name: 'outline', status: 'failed', error: 'portrait queue down' });
    expect(lib.store.chapters.require(chapter.id).status).toBe('draft');
    expect(queue.jobs('llm.step').map((j) => [(j.payload as { step: string }).step, j.status])).toEqual([
      ['premise', 'succeeded'], ['outline', 'failed'],
    ]);
  });

  it('a cancelled job whose handler ignores the abort cannot complete a retried step (M2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { chapter, input } = world();
    const { runner, queue } = rig({
      auto: false,
      responses: { 'episode.premise': async (req) => { await gate; return EPISODE_FAKE_RESPONSES['episode.premise']!(req); } },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    const token = runner.get(run.id).steps[0]!.startedAt;
    const [old] = queue.jobs('llm.step');
    const controller = new AbortController();
    const pending = runner.handleStepJob(fakeJobContext(lib.store, bus, queue, old!, controller.signal), old!.payload as LlmStepPayload);
    runner.cancel(run.id);
    controller.abort(new Error('cancelled'));
    const retried = runner.rerun(run.id, 'premise', false);
    expect(retried.steps[0]).toMatchObject({ status: 'running', startedAt: token }); // a retry: same token as the cancelled job
    release(); // the scripted engine checks the signal only before it answers, so the old handler still returns a value
    await expect(pending).resolves.toEqual({ skipped: true });
    expect(runner.get(run.id).steps[0]).toMatchObject({ status: 'running', output: null });
    expect(lib.store.chapters.require(chapter.id).title).toBe('Draft');
  });

  it('an error inside a job watch is logged, not an unhandled rejection (M3)', async () => {
    const { chapter, input } = world();
    const { runner, queue } = rig({ auto: false });
    runner.start(chapter.id, input, 'review');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(lib.store.episodes, 'update').mockImplementation(() => { throw new Error('disk full'); });
    const [job] = queue.jobs('llm.step');
    queue.fail(job!.id, 'model overloaded'); // the watch's failStep -> save throws
    await queue.idle();
    expect(logged).toHaveBeenCalledWith('[manga] episode runner:', expect.objectContaining({ message: 'disk full' }));
  });

  it('a late result of a superseded job is discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { chapter, input } = world();
    const { runner, queue } = rig({
      auto: false,
      responses: { 'episode.premise': async (req) => { await gate; return EPISODE_FAKE_RESPONSES['episode.premise']!(req); } },
    });
    const run = runner.start(chapter.id, input, 'autopilot');
    const [old] = queue.jobs('llm.step');
    const pending = runner.handleStepJob(fakeJobContext(lib.store, bus, queue, old!), old!.payload as LlmStepPayload);
    runner.rerun(run.id, 'premise', false);
    release();
    await expect(pending).resolves.toEqual({ skipped: true });
    const after = runner.get(run.id);
    expect(after.steps[0]).toMatchObject({ status: 'running', output: null });
    expect(lib.store.chapters.require(chapter.id).title).toBe('Draft');
    expect(queue.jobs('llm.step')).toHaveLength(2);
  });
});
