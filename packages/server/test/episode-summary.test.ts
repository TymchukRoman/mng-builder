import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodeRun, LlmStepPayload, ServerEvent } from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { ScriptedEngine, type ScriptedResponse } from '../src/engines/scripted.js';
import { EventBus } from '../src/events/bus.js';
import { STORY_GAP, extractContext, type SummaryContext } from '../src/workflows/episode/context.js';
import { SUMMARY_LIMIT, SUMMARY_STORY_LIMIT, writeChapterSummary } from '../src/workflows/episode/summary.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => { lib = openTestLibrary(); bus = new EventBus(); events = []; bus.on((e) => { events.push(e); }); });
afterEach(() => { lib.close(); });

function doneRun(opts: { pages?: number; language?: 'en' | 'uk' } = {}) {
  const { manga, chapter } = seedEpisodeWorld(lib.store, { language: opts.language ?? 'en' });
  const run = seedChapterRun(chapter.id, opts.pages ?? 2);
  return { manga, chapter, run };
}

function seedChapterRun(chapterId: string, pages = 2): EpisodeRun {
  const bd = breakdown(pages);
  return seedRun(lib.store, chapterId, {
    outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') }, status: 'done',
  });
}

const summaryJob = (run: { id: string; chapterId: string }) => {
  const payload: LlmStepPayload = { type: 'chapter-summary', chapterId: run.chapterId, runId: run.id };
  const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'claude', payload, priority: 0, maxAttempts: 2, nextRunAt: new Date().toISOString(), episodeRunId: run.id });
  return { job, payload: payload as Extract<LlmStepPayload, { type: 'chapter-summary' }> };
};

/** Runs the summary job of `run` on a scripted engine (the fakes unless `respond` is given). */
async function summarise(run: EpisodeRun, respond?: ScriptedResponse, signal?: AbortSignal) {
  const engine = new ScriptedEngine('claude', respond ? { 'episode.summary': respond } : EPISODE_FAKE_RESPONSES);
  const { job, payload } = summaryJob(run);
  const ctx = fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job, signal);
  const out = await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, ctx, payload);
  return { out, engine };
}

const entityEvents = (entity: string, id: string) => events.filter((e) => e.type === 'entity' && e.entity === entity && e.id === id);

describe('chapter summary (W1 Q1)', () => {
  it('writes chapter.summary and the run\'s chapterSummary with one story call on the job\'s lane engine, emitting each row once', async () => {
    const { chapter, run } = doneRun();
    const { out, engine } = await summarise(run);
    expect(out).toMatchObject({ summary: expect.any(String) });
    const summary = (out as { summary: string }).summary;
    expect(lib.store.chapters.require(chapter.id).summary).toBe(summary);
    expect(lib.store.episodes.require(run.id).chapterSummary).toBe(summary);
    expect(engine.calls.map((c) => [c.name, c.task])).toEqual([['episode.summary', 'story']]);
    const sent = extractContext<SummaryContext>(engine.calls[0]!.prompt);
    expect(sent.story).toContain('Page 1:\n- Page 1 panel 1');
    expect(engine.calls[0]!.system.length).toBeLessThan(1500); // G2: the story goes in the prompt, not the system prompt
    expect(entityEvents('chapter', chapter.id)).toHaveLength(1);
    expect(entityEvents('episodeRun', run.id)).toHaveLength(1);
  });

  it('writes the summary in the manga\'s language', async () => {
    const { manga, chapter, run } = doneRun({ language: 'uk' });
    const { engine } = await summarise(run);
    expect(engine.calls[0]!.system).toContain('in Ukrainian');
    expect(extractContext<SummaryContext>(engine.calls[0]!.prompt).language).toBe(manga.language);
    expect(lib.store.chapters.require(chapter.id).summary).toMatch(/^Розділ 1/);
  });

  it('clips an answer longer than the limit instead of failing (review M4)', async () => {
    const { chapter, run } = doneRun();
    const { out } = await summarise(run, () => ({ summary: `  ${'z'.repeat(2000)}  ` }));
    expect((out as { summary: string }).summary).toBe(`${'z'.repeat(SUMMARY_LIMIT - 1)}…`);
    expect(lib.store.chapters.require(chapter.id).summary).toHaveLength(SUMMARY_LIMIT);
  });

  it('reads a long chapter from its first page and its most recent pages (review M5)', async () => {
    const { run } = doneRun({ pages: 200 });
    const { engine } = await summarise(run);
    const { story } = extractContext<SummaryContext>(engine.calls[0]!.prompt);
    expect(story.length).toBeLessThanOrEqual(SUMMARY_STORY_LIMIT);
    expect(story.startsWith('Page 1:\n')).toBe(true);
    expect(story).toContain(`\n${STORY_GAP}\n`);
    expect(story.endsWith('  Aiko: Line 200.2')).toBe(true);
  });

  it('never replaces a summary the user wrote, but replaces one a run of the chapter wrote (review M8)', async () => {
    const { chapter, run } = doneRun();
    lib.store.chapters.update(chapter.id, { summary: 'My own notes.' });
    const first = await summarise(run);
    expect(first.out).toEqual({ skipped: true });
    expect(first.engine.calls).toEqual([]);
    expect(lib.store.chapters.require(chapter.id).summary).toBe('My own notes.');

    // The summary an earlier run wrote is the run's own, so the next finished run refreshes it.
    lib.store.chapters.update(chapter.id, { summary: '' });
    await summarise(run);
    const written = lib.store.chapters.require(chapter.id).summary;
    expect(written).not.toBe('');
    const later = seedChapterRun(chapter.id);
    const second = await summarise(later, () => ({ summary: 'The second run happened.' }));
    expect(second.out).toEqual({ summary: 'The second run happened.' });
    expect(lib.store.chapters.require(chapter.id).summary).toBe('The second run happened.');

    // A user edit made while the call runs is kept too.
    const third = seedChapterRun(chapter.id);
    const edited = await summarise(third, () => {
      lib.store.chapters.update(chapter.id, { summary: 'Edited meanwhile.' });
      return { summary: 'Too late.' };
    });
    expect(edited.out).toEqual({ skipped: true });
    expect(lib.store.chapters.require(chapter.id).summary).toBe('Edited meanwhile.');
    expect(lib.store.episodes.require(third.id).chapterSummary ?? null).toBeNull();
  });

  it('skips a run that is not finished, not the latest, or whose job was aborted during the call (review M7)', async () => {
    const { chapter, run } = doneRun();
    lib.store.episodes.update(run.id, { status: 'running' });
    const running = await summarise(run);
    expect(running.out).toEqual({ skipped: true });
    expect(running.engine.calls).toEqual([]);

    lib.store.episodes.update(run.id, { status: 'done' });
    seedChapterRun(chapter.id); // a newer run is now the chapter's latest
    const stale = await summarise(run);
    expect(stale.out).toEqual({ skipped: true });
    expect(stale.engine.calls).toEqual([]);

    const latest = seedChapterRun(chapter.id);
    const abort = new AbortController();
    const aborted = await summarise(latest, () => { abort.abort(); return { summary: 'Never written.' }; }, abort.signal);
    expect(aborted.out).toEqual({ skipped: true });
    expect(lib.store.chapters.require(chapter.id).summary).toBe('');
    expect(entityEvents('chapter', chapter.id)).toEqual([]);
  });
});
