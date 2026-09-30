import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, REVIEW_AVG_SECONDS, castCount, countSentence, countTag, estimateReviewSeconds, formatEstimate, renderGate, stepIndex,
  type EpisodeRun, type ImageGeneratePayload, type ImageReviewPayload, type ServerEvent,
} from '@manga/shared';
import { EventBus } from '../src/events/bus.js';
import { chapterPanels } from '../src/workflows/episode/chapter.js';
import { materializeScripts } from '../src/workflows/episode/effects.js';
import { runLetteringStep } from '../src/workflows/episode/lettering.js';
import {
  ANATOMY_NEGATIVE, TEXT_NEGATIVE, estimateRender, retryPatch, retryTarget, runRenderStep,
  type DriverDeps, type RetryTarget,
} from '../src/workflows/episode/render.js';
import { nowIso, patchStep } from '../src/workflows/episode/steps.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeImaging, fakeJobContext, type FakeImagingOptions } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedImage } from './helpers/seed.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
let queue: FakeQueue;
beforeEach(() => {
  lib = openTestLibrary();
  bus = new EventBus();
  events = [];
  bus.on((e) => { events.push(e); });
  queue = new FakeQueue(lib.store);
});
afterEach(() => { lib.close(); });

const deps = (): DriverDeps => ({ store: lib.store, bus, queue: queue.asQueue(), engines: { laneFor: () => 'claude' }, newSeed: () => 777 });

/** Two story pages (or `pages`) of two panels + the cover, all with Aiko; the render step is running. */
function renderWorld(opts: { portrait?: boolean; mode?: 'review' | 'autopilot'; previewFirst?: boolean; pages?: number } = {}) {
  const { manga, chapter } = seedEpisodeWorld(lib.store);
  let aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, short black hair');
  if (opts.portrait !== false) aiko = giveRefs(lib.store, aiko, ['portrait']);
  const bd = breakdown(opts.pages ?? 2);
  const sc = scripts(bd, 'Aiko');
  materializeScripts({ store: lib.store, bus }, chapter.id, { breakdown: bd, scripts: sc, premise: PREMISE });
  const seeded = seedRun(lib.store, chapter.id, {
    mode: opts.mode ?? 'autopilot', outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: sc }, currentStep: 'render',
    ...(opts.previewFirst !== undefined ? { input: { previewFirst: opts.previewFirst } } : {}),
  });
  const run = lib.store.episodes.update(seeded.id, { steps: patchStep(seeded.steps, stepIndex('render'), { status: 'running', startedAt: nowIso() }) });
  const panelIds = chapterPanels(lib.store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  events.length = 0;
  return { manga, chapter, aiko, run, panelIds };
}

function stepContext(run: EpisodeRun, signal?: AbortSignal, progress: string[] = []) {
  const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'cpu', payload: { type: 'episode', runId: run.id, step: 'render' }, priority: 0, maxAttempts: 1, nextRunAt: nowIso(), episodeRunId: run.id });
  return fakeJobContext(lib.store, bus, queue, job, signal, progress);
}

async function render(run: EpisodeRun, imaging: FakeImagingOptions = {}, progress: string[] = []) {
  fakeImaging(lib.store, queue, imaging);
  return runRenderStep(deps(), stepContext(run, undefined, progress), run);
}

const panelJobs = (panelId: string) =>
  queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload & { panelId?: string }).panelId === panelId);
const portraitJobs = () => queue.jobs('image.generate').filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait');

describe('retryPatch', () => {
  const s = DEFAULT_SETTINGS;
  const oneGirl = { girl: 1, boy: 0, other: 0 };
  const solo: RetryTarget = { cast: oneGirl, hasPortraitRefs: true, style: 'tags' };

  it('maps issue kinds to retry strategies, keeping defects out of the positive prompt (F14)', () => {
    expect(retryPatch([], s, 1, solo)).toEqual({ seed: 1 });
    expect(retryPatch([{ kind: 'identity', note: 'wrong hair' }], s, 2, solo)).toEqual({ seed: 2, recipe: 'qwen-edit-ref' });
    expect(retryPatch([{ kind: 'text', note: 'letters on wall' }], s, 3, solo)).toEqual({ seed: 3, negativeExtra: TEXT_NEGATIVE });
    expect(retryPatch([{ kind: 'anatomy', note: 'extra arm' }, { kind: 'script-mismatch', note: 'standing, should be sitting', fix: 'sitting' }], s, 4, solo))
      .toEqual({ seed: 4, negativeExtra: ANATOMY_NEGATIVE, sceneSuffix: 'sitting' });
    expect(retryPatch(
      [{ kind: 'anatomy', note: 'six fingers' }, { kind: 'text', note: 'sign' }, { kind: 'character-count', note: 'three people' }, { kind: 'other', note: 'dry street', fix: ' rain is falling ' }],
      s, 6, { cast: { girl: 2, boy: 0, other: 0 }, hasPortraitRefs: true, style: 'tags' },
    )).toEqual({ seed: 6, negativeExtra: `${TEXT_NEGATIVE}, ${ANATOMY_NEGATIVE}`, sceneSuffix: '2girls, rain is falling' });
  });

  it('writes the people count as a sentence for a natural-style recipe (F14, amended)', () => {
    const natural: RetryTarget = { cast: { girl: 1, boy: 1, other: 0 }, hasPortraitRefs: true, style: 'natural' };
    expect(retryPatch([{ kind: 'character-count', note: 'three people' }, { kind: 'script-mismatch', note: 'She stands.', fix: 'She sits on the bench.' }], s, 8, natural))
      .toEqual({ seed: 8, sceneSuffix: 'Exactly two people: one man and one woman. She sits on the bench.' });
  });

  it('says "grown man" in a natural retry count when every man is grown, as the build does', () => {
    const man: RetryTarget = { cast: { girl: 0, boy: 1, other: 0 }, grownMen: true, hasPortraitRefs: true, style: 'natural' };
    expect(retryPatch([{ kind: 'character-count', note: 'two people' }], s, 3, man)).toEqual({ seed: 3, sceneSuffix: 'Exactly one grown man.' });
    expect(retryPatch([{ kind: 'character-count', note: 'two people' }], s, 3, { ...man, style: 'tags' })).toEqual({ seed: 3, sceneSuffix: '1boy, solo, male focus' });
  });

  it('puts only the wanted state in the scene, never the reviewer\'s "X instead of Y" note (M4 final S1)', () => {
    const natural: RetryTarget = { ...solo, style: 'natural' };
    const note = 'The kitten is perched on top of the vending machine instead of peeking from a box.';
    expect(retryPatch([{ kind: 'script-mismatch', note, fix: 'The kitten peeks out of a cardboard box.' }], s, 1, natural))
      .toEqual({ seed: 1, sceneSuffix: 'The kitten peeks out of a cardboard box.' });
    // A review stored before `fix` existed (or an empty fix) adds no scene text: never the raw note.
    expect(retryPatch([{ kind: 'script-mismatch', note }], s, 2, natural)).toEqual({ seed: 2 });
    expect(retryPatch([{ kind: 'other', note, fix: '  ' }], s, 3, natural)).toEqual({ seed: 3 });
  });

  it('judges the style on the recipe the retry uses: the drift recipe writes sentences', () => {
    expect(retryPatch([{ kind: 'identity', note: '' }, { kind: 'text', note: '' }, { kind: 'character-count', note: 'only one person' }], s, 5, solo))
      .toEqual({ seed: 5, recipe: 'qwen-edit-ref', negativeExtra: TEXT_NEGATIVE, sceneSuffix: 'Exactly one woman.' });
    expect(retryPatch([{ kind: 'identity', note: '' }, { kind: 'character-count', note: 'x' }], s, 9, { ...solo, hasPortraitRefs: false }))
      .toEqual({ seed: 9, sceneSuffix: '1girl, solo' });
  });

  it('keeps the recipe for an identity issue on a panel without referenced portraits (F31)', () => {
    expect(retryPatch([{ kind: 'identity', note: 'not Aiko' }], s, 7, { ...solo, hasPortraitRefs: false })).toEqual({ seed: 7 });
  });
});

describe('people count', () => {
  const c = (appearanceTags: string) => ({ appearanceTags });

  // The count wording itself (1boy, solo, male focus; men and women) is tested with the helpers in shared/test/gender.test.ts.
  it('does not count a non-human character (a `no humans` cast member, e.g. a pet) as a person (live smoke)', () => {
    const kitten = c('no humans, kitten, cat, small');
    expect(castCount([c('1girl, short black hair'), kitten])).toEqual({ girl: 1, boy: 0, other: 0 });
    expect(countSentence(castCount([c('1girl'), kitten]))).toBe('Exactly one woman.');
    expect(countTag(castCount([c('1girl'), kitten]))).toBe('1girl, solo');
    expect(countTag(castCount([kitten]))).toBe('no humans');
    expect(countSentence(castCount([c('No Humans, dog')]))).toBe('No people.');
    // Any spelling (M4 final S4, Task 22 review minor 1)
    expect(castCount([c('1girl'), c('no_humans, dog'), c(' No  Human , cat')])).toEqual({ girl: 1, boy: 0, other: 0 });
  });

  it('counts only script characters that exist in this manga, as the renderer does', () => {
    const { manga, panelIds } = renderWorld();
    const other = seedEpisodeWorld(lib.store, { mangaTitle: 'Elsewhere' });
    const stranger = seedCharacter(lib.store, other.manga.id, 'Stranger', '1boy');
    const panel = lib.store.panels.require(panelIds[0]!);
    const extra = [stranger.id, 'ch_gone'].map((characterId) => ({ characterId, pose: '', expression: '', position: 'left' as const }));
    const updated = lib.store.panels.update(panel.id, { script: { ...panel.script, characters: [...panel.script.characters, ...extra] } });
    expect(manga.id).not.toBe(other.manga.id);
    expect(retryTarget(lib.store, DEFAULT_SETTINGS, updated)).toEqual({ cast: { girl: 1, boy: 0, other: 0 }, grownMen: false, hasPortraitRefs: true, style: 'tags' });
  });

  it('a pet in the panel script is not a person on the wired retry path (Task 22 fix A; review minor 5)', () => {
    const { manga, panelIds } = renderWorld();
    const kitten = seedCharacter(lib.store, manga.id, 'Kitten', 'No_Humans, kitten');
    const panel = lib.store.panels.require(panelIds[0]!);
    const withPet = lib.store.panels.update(panel.id, {
      script: { ...panel.script, characters: [...panel.script.characters, { characterId: kitten.id, pose: 'in a box', expression: '', position: 'left' }] },
    });
    const target = retryTarget(lib.store, DEFAULT_SETTINGS, withPet);
    expect(target.cast).toEqual({ girl: 1, boy: 0, other: 0 });
    const count = [{ kind: 'character-count' as const, note: 'a second girl sits in the box' }];
    expect(retryPatch(count, DEFAULT_SETTINGS, 1, target).sceneSuffix).toBe(target.style === 'natural' ? 'Exactly one woman.' : '1girl, solo');
    expect(retryPatch(count, DEFAULT_SETTINGS, 1, { ...target, style: 'natural' }).sceneSuffix).toBe('Exactly one woman.');
  });
});

describe('estimateRender (M4 final S5)', () => {
  it('adds the expected review rounds when the episode reviews, and nothing when it does not', () => {
    const { manga, panelIds } = renderWorld();
    const panels = panelIds.map((id) => lib.store.panels.require(id));
    const off = { ...DEFAULT_SETTINGS, review: { autoInEpisode: false, rounds: 2 } };
    const on = { ...DEFAULT_SETTINGS, review: { autoInEpisode: true, rounds: 2 } };
    const renderOnly = estimateRender(lib.store, off, manga, panels);
    expect(renderOnly).toBeGreaterThan(0);
    expect(estimateRender(lib.store, { ...on, review: { autoInEpisode: true, rounds: 0 } }, manga, panels)).toBe(renderOnly);
    expect(estimateRender(lib.store, on, manga, panels)).toBe(renderOnly + estimateReviewSeconds(renderOnly, panels.length, 2));
    expect(estimateRender(lib.store, on, manga, panels)).toBeGreaterThan(renderOnly + panels.length * REVIEW_AVG_SECONDS);
  });
});

describe('runRenderStep', () => {
  it('renders every story panel and the cover, showing the estimate before queueing', async () => {
    const { run, panelIds } = renderWorld();
    const progress: string[] = [];
    const out = await render(run, {}, progress);
    expect(panelIds).toHaveLength(5);
    expect(out).toMatchObject({ reviewed: 5, flagged: 0, rounds: 0 });
    expect(out.jobs).toHaveLength(10);
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
    expect(progress[0]).toMatch(/^Rendering 5 panels · est\. ~\d+ (s|min)$/);
    expect(queue.jobs('image.generate').every((j) => j.lane === 'gpu' && j.episodeRunId === run.id)).toBe(true);
    expect(queue.jobs('image.review').every((j) => j.lane === 'claude' && j.episodeRunId === run.id)).toBe(true);
  });

  it('reports the estimate before it queues any panel', async () => {
    const { run } = renderWorld();
    fakeImaging(lib.store, queue);
    const seen: Array<[string, number]> = [];
    const ctx = { ...stepContext(run), progress: (label: string) => { seen.push([label, queue.jobs('image.generate').length]); } };
    await runRenderStep(deps(), ctx, run);
    expect(seen[0]![0]).toMatch(/^Rendering 5 panels · est\. /);
    expect(seen[0]![1]).toBe(0);
  });

  it('counts a failed review job as not flagged (review is advisory)', async () => {
    const { run, panelIds } = renderWorld();
    const out = await render(run, {
      review: (_imageId, panelId) => { if (panelId === panelIds[0]) throw new Error('Claude quota'); return []; },
    });
    expect(out).toMatchObject({ reviewed: 4, flagged: 0, rounds: 0 });
    expect(queue.jobs('image.review').filter((j) => j.status === 'failed')).toHaveLength(1);
  });

  it('keeps the first image and succeeds when a re-render in a review round fails', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[0]!;
    let renders = 0;
    const out = await render(run, {
      review: (_imageId, panelId) => (panelId === target ? [{ kind: 'text', note: 'sign' }] : []),
      beforePanel: (id) => { if (id === target && ++renders > 1) throw new Error('ComfyUI crashed'); },
    });
    const firstImage = (panelJobs(target)[0]!.result as { imageId: string }).imageId;
    expect(out).toMatchObject({ reviewed: 5, flagged: 1, rounds: 1 });
    expect(panelJobs(target).map((j) => j.status)).toEqual(['succeeded', 'failed']);
    expect(lib.store.panels.require(target).activeImageId).toBe(firstImage);
  });

  it('reviews in batches and re-renders flagged panels with the strategy for their issues', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[0]!;
    const seen = new Set<string>();
    const out = await render(run, {
      review: (_imageId, panelId) => {
        if (panelId !== target || seen.has(panelId)) return [];
        seen.add(panelId);
        return [{ kind: 'text', note: 'letters on the wall' }];
      },
    });
    expect(out).toMatchObject({ reviewed: 6, flagged: 1, rounds: 1 });
    expect(panelJobs(target).map((j) => j.payload)).toEqual([
      { target: 'panel', panelId: target },
      { target: 'panel', panelId: target, seed: 777, negativeExtra: TEXT_NEGATIVE },
    ]);
  });

  it('asks for the panel\'s people count on a character-count flag', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[1]!;
    const seen = new Set<string>();
    await render(run, {
      review: (_imageId, panelId) => {
        if (panelId !== target || seen.has(panelId)) return [];
        seen.add(panelId);
        return [{ kind: 'character-count', note: 'two girls instead of one' }];
      },
    });
    expect(panelJobs(target).at(-1)!.payload).toEqual({ target: 'panel', panelId: target, seed: 777, sceneSuffix: '1girl, solo' });
  });

  it('writes the people count as a sentence for a panel on a natural-style recipe', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[1]!;
    lib.store.panels.update(target, { recipe: 'qwen-edit-ref' });
    const seen = new Set<string>();
    await render(run, {
      review: (_imageId, panelId) => {
        if (panelId !== target || seen.has(panelId)) return [];
        seen.add(panelId);
        return [{ kind: 'character-count', note: 'two girls instead of one' }];
      },
    });
    expect(panelJobs(target).at(-1)!.payload).toEqual({ target: 'panel', panelId: target, seed: 777, sceneSuffix: 'Exactly one woman.' });
  });

  it('stops after settings.review.rounds', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[1]!;
    const out = await render(run, { review: (_i, panelId) => (panelId === target ? [{ kind: 'identity', note: 'not Aiko' }] : []) });
    expect(out).toMatchObject({ reviewed: 6, flagged: 2, rounds: 2 });
    expect(panelJobs(target)).toHaveLength(3);
    expect(panelJobs(target).at(-1)!.payload).toMatchObject({ recipe: DEFAULT_SETTINGS.routing.driftFallback, seed: 777 });
  });

  it('retries an identity flag with a new seed only when the panel references no character (F31)', async () => {
    const { run, panelIds } = renderWorld();
    const target = panelIds[2]!;
    lib.store.panels.update(target, { refCharacterIds: [] });
    await render(run, { review: (_i, panelId) => (panelId === target ? [{ kind: 'identity', note: 'who is this' }] : []) });
    expect(panelJobs(target).at(-1)!.payload).toEqual({ target: 'panel', panelId: target, seed: 777 });
  });

  it('skips review when review.autoInEpisode is off', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run } = renderWorld();
    const out = await render(run);
    expect(out).toMatchObject({ reviewed: 0, flagged: 0, rounds: 0 });
    expect(queue.jobs('image.review')).toEqual([]);
  });

  it('refuses to render in review mode while a character has no portrait', async () => {
    const { run } = renderWorld({ portrait: false, mode: 'review' });
    await expect(render(run)).rejects.toThrow('Pick a portrait for Aiko in the Characters tab, then retry the render step');
    expect(queue.jobs('image.generate')).toEqual([]);
  });

  it('takes the first generated portrait in autopilot', async () => {
    const { run, aiko } = renderWorld({ portrait: false });
    const first = seedImage(lib.store, aiko.mangaId, { type: 'character', id: aiko.id }, 'portrait');
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
    seedImage(lib.store, aiko.mangaId, { type: 'character', id: aiko.id }, 'portrait');
    await render(run);
    expect(lib.store.characters.require(aiko.id).refs.portrait).toBe(first.id);
    expect(portraitJobs()).toEqual([]);
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'character')).toEqual([
      { type: 'entity', entity: 'character', id: aiko.id, op: 'updated', mangaId: aiko.mangaId },
    ]);
  });

  it('generates a portrait in autopilot when none exists yet', async () => {
    const { run, aiko } = renderWorld({ portrait: false });
    await render(run);
    expect(portraitJobs()).toHaveLength(1);
    expect(portraitJobs()[0]!.episodeRunId).toBe(run.id);
    expect(lib.store.characters.require(aiko.id).refs.portrait).toBe((portraitJobs()[0]!.result as { imageId: string }).imageId);
  });

  it('waits for this run\'s queued portraits instead of generating another one (F13)', async () => {
    const { run, aiko } = renderWorld({ portrait: false });
    const outlinePortrait = queue.enqueue({
      kind: 'image.generate', lane: 'gpu', payload: { target: 'character-portrait', characterId: aiko.id, seed: 1 }, episodeRunId: run.id,
    }); // no handler yet: it stays queued, as behind other GPU work
    const rendering = render(run);
    await queue.idle();
    expect(queue.jobs('image.generate')).toHaveLength(1);
    const image = seedImage(lib.store, aiko.mangaId, { type: 'character', id: aiko.id }, 'portrait');
    queue.succeed(outlinePortrait.id, { imageId: image.id });
    await rendering;
    expect(portraitJobs().map((j) => j.id)).toEqual([outlinePortrait.id]);
    expect(lib.store.characters.require(aiko.id).refs.portrait).toBe(image.id);
  });

  it('on retry renders only the panels not rendered since the step started', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, manga, panelIds } = renderWorld();
    for (const id of panelIds.slice(0, 2)) {
      lib.store.panels.update(id, { activeImageId: seedImage(lib.store, manga.id, { type: 'panel', id }, null).id });
    }
    await render(run);
    expect(queue.jobs('image.generate').map((j) => (j.payload as { panelId: string }).panelId)).toEqual(panelIds.slice(2));
  });

  it('adopts this run\'s unfinished generate job for a panel instead of queueing a duplicate (F11)', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, manga, panelIds } = renderWorld();
    const target = panelIds[3]!;
    const leftover = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: target }, episodeRunId: run.id });
    const rendering = render(run);
    await queue.idle();
    const image = seedImage(lib.store, manga.id, { type: 'panel', id: target }, null);
    lib.store.panels.update(target, { activeImageId: image.id });
    queue.succeed(leftover.id, { imageId: image.id });
    const out = await rendering;
    expect(panelJobs(target).map((j) => j.id)).toEqual([leftover.id]);
    expect(queue.jobs('image.generate')).toHaveLength(5);
    expect(out.jobs).toContain(leftover.id);
  });

  it('adopts this run\'s unfinished review job for an image (F11)', async () => {
    const { run, manga, panelIds } = renderWorld();
    for (const id of panelIds) lib.store.panels.update(id, { activeImageId: seedImage(lib.store, manga.id, { type: 'panel', id }, null).id });
    const imageId = lib.store.panels.require(panelIds[0]!).activeImageId!;
    const payload: ImageReviewPayload = { imageId, panelId: panelIds[0]! };
    const leftover = queue.enqueue({ kind: 'image.review', lane: 'claude', payload, episodeRunId: run.id });
    const rendering = render(run);
    await queue.idle();
    lib.store.images.update(imageId, { review: { engine: 'claude', pass: true, issues: [], at: nowIso() } });
    queue.succeed(leftover.id);
    const out = await rendering;
    expect(queue.jobs('image.generate')).toEqual([]);
    expect(queue.jobs('image.review').filter((j) => (j.payload as ImageReviewPayload).imageId === imageId).map((j) => j.id)).toEqual([leftover.id]);
    expect(out).toMatchObject({ reviewed: 5, flagged: 0 });
  });

  it('stops waiting at once when the step is aborted, leaving its jobs queued (F10)', async () => {
    const { run } = renderWorld();
    const controller = new AbortController();
    const rendering = runRenderStep(deps(), stepContext(run, controller.signal), run); // no imaging handlers: jobs stay queued
    await queue.idle();
    const reason = new Error('server stopping');
    controller.abort(reason);
    await expect(rendering).rejects.toBe(reason);
    expect(queue.jobs('image.generate')).toHaveLength(5);
    expect(queue.jobs('image.generate').every((j) => j.status === 'queued')).toBe(true);
  });
});

describe('runLetteringStep', () => {
  it('letters every story page and the cover title', async () => {
    const { run } = renderWorld();
    const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'cpu', payload: {}, priority: 0, maxAttempts: 1, nextRunAt: nowIso(), episodeRunId: run.id });
    const out = await runLetteringStep({ store: lib.store, bus }, fakeJobContext(lib.store, bus, queue, job), run);
    expect(out).toEqual({ frames: 5 });
    const created = events.filter((e) => e.type === 'entity' && e.entity === 'textFrame' && e.op === 'created');
    expect(created).toHaveLength(5);
    expect(new Set(created.map((e) => (e.type === 'entity' ? e.id : '')))).toHaveProperty('size', 5);
    expect(events).toHaveLength(5); // G5: only the new frame rows changed
  });
});

describe('runRenderStep — failed panels (W1 R1)', () => {
  it('records a failed panel, finishes the step, labels the failure and skips it in review', async () => {
    const { run, panelIds } = renderWorld();
    const broken = panelIds[2]!;
    const progress: string[] = [];
    const out = await render(run, { beforePanel: (id) => { if (id === broken) throw new Error('ComfyUI rejected the graph'); } }, progress);
    expect(out.failedPanelIds).toEqual([broken]);
    expect(lib.store.panels.require(broken).activeImageId).toBeNull();
    expect(progress.some((l) => /^Rendering 5 panels · est\. .+ · 1 failed$/.test(l))).toBe(true);
    const reviewed = queue.jobs('image.review').map((j) => (j.payload as ImageReviewPayload).panelId);
    expect(reviewed).toHaveLength(4);
    expect(reviewed).not.toContain(broken);
  });

  it('fails the step only when every panel failed, naming the first failure', async () => {
    const { run } = renderWorld();
    await expect(render(run, { beforePanel: () => { throw new Error('ComfyUI is not reachable'); } }))
      .rejects.toThrow(/^All 5 panel renders failed \(pn_[a-z2-7]+: ComfyUI is not reachable\)\. Check the image engine, then retry the render step\.$/);
  });
});

describe('runRenderStep — preview first (W1 Q2)', () => {
  it('renders the cover and page 1 first, then stops with the rest and its estimate', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, manga, panelIds } = renderWorld({ previewFirst: true });
    const [p1a, p1b, p2a, p2b, cover] = panelIds;
    const progress: string[] = [];
    const out = await render(run, {}, progress);
    expect(renderGate(out)).toBe('preview');
    const now = [p1a!, p1b!, cover!].map((id) => lib.store.panels.require(id));
    const rest = [p2a!, p2b!].map((id) => lib.store.panels.require(id));
    expect(out).toMatchObject({ preview: true, remainingPanels: 2, failedPanelIds: [], estimateSeconds: estimateRender(lib.store, lib.store.settings.get(), manga, rest) });
    expect(progress[0]).toBe(`Rendering page 1 and the cover: 3 panels · est. ${formatEstimate(estimateRender(lib.store, lib.store.settings.get(), manga, now))}`);
    expect(queue.jobs('image.generate').map((j) => (j.payload as { panelId: string }).panelId).sort()).toEqual([p1a!, p1b!, cover!].sort());
    expect(rest.every((p) => p.activeImageId === null)).toBe(true);
  });

  it('Continue (the stop kept as the output, same token) renders only the rest and does not stop again', async () => {
    lib.store.settings.patch({ review: { autoInEpisode: false } });
    const { run, panelIds } = renderWorld({ previewFirst: true });
    const first = await render(run);
    const again = lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('render'), { output: first }) });
    const out = await render(again);
    expect(renderGate(out)).toBeNull();
    expect(out.failedPanelIds).toEqual([]);
    expect(queue.jobs('image.generate')).toHaveLength(5); // 3 for the preview + the 2 remaining, none twice
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });

  it('Continue never reviews again the page 1 the user checked (F14)', async () => {
    lib.store.settings.patch({ review: { rounds: 1 } });
    const { run, panelIds } = renderWorld({ previewFirst: true });
    const [p1a, , p2a, p2b] = panelIds;
    const flagP1a = { review: (_imageId: string, panelId: string | null) => (panelId === p1a ? [{ kind: 'text' as const, note: 'sign' }] : []) };
    // The preview's last review round re-renders p1a and does not review the new image.
    const first = await render(run, flagP1a);
    expect(first).toMatchObject({ preview: true, flagged: 1, rounds: 1 });
    expect(panelJobs(p1a!)).toHaveLength(2);
    const reviewsBefore = queue.jobs('image.review').length;
    const again = lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('render'), { output: first }) });
    const out = await render(again, flagP1a);
    const continued = queue.jobs('image.review').slice(reviewsBefore).map((j) => (j.payload as ImageReviewPayload).panelId);
    expect(continued.sort()).toEqual([p2a!, p2b!].sort());
    expect(out).toMatchObject({ reviewed: 2, flagged: 0 });
    expect(panelJobs(p1a!)).toHaveLength(2); // page 1 stays as the user saw it
  });

  it('does not stop when page 1 is the only story page', async () => {
    const { run, panelIds } = renderWorld({ previewFirst: true, pages: 1 });
    const out = await render(run);
    expect(renderGate(out)).toBeNull();
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });
});

describe('runRenderStep — size stop (W1 C2)', () => {
  it('stops once before any GPU work when the render would take longer than confirmRenderMinutes', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { run } = renderWorld({ portrait: false, mode: 'autopilot', previewFirst: false });
    const out = await render(run);
    expect(renderGate(out)).toBe('confirm');
    expect(out.panels).toBe(5);
    expect(out.estimateSeconds).toBeGreaterThan(60);
    expect(queue.jobs('image.generate')).toEqual([]); // not even a portrait
  });

  it('Continue after the size stop renders without asking again', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 }, review: { autoInEpisode: false } });
    const { run, panelIds } = renderWorld({ previewFirst: false });
    const stop = await render(run);
    const again = lib.store.episodes.update(run.id, { steps: patchStep(run.steps, stepIndex('render'), { output: stop }) });
    expect(renderGate(await render(again))).toBeNull();
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });

  it('with the preview on, only the preview stops (it shows the estimate for the rest)', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { run } = renderWorld({ previewFirst: true });
    expect(renderGate(await render(run))).toBe('preview');
  });

  it('never stops a run stored before W1, whose input has no previewFirst (F18)', async () => {
    lib.store.settings.patch({ episode: { confirmRenderMinutes: 1 } });
    const { run, panelIds } = renderWorld();
    expect(run.input.previewFirst).toBeUndefined();
    expect(renderGate(await render(run))).toBeNull();
    for (const id of panelIds) expect(lib.store.panels.require(id).activeImageId).not.toBeNull();
  });
});
