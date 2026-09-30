import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmStepPayload, ServerEvent } from '@manga/shared';
import { EPISODE_FAKE_RESPONSES } from '../src/dev/fake-episode.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { EventBus } from '../src/events/bus.js';
import { extractContext, type SummaryContext } from '../src/workflows/episode/context.js';
import { writeChapterSummary } from '../src/workflows/episode/summary.js';
import { PREMISE, breakdown, outline, scripts, seedEpisodeWorld, seedRun } from './helpers/episode-fixtures.js';
import { FakeQueue, fakeJobContext } from './helpers/fake-queue.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
let bus: EventBus;
let events: ServerEvent[];
beforeEach(() => { lib = openTestLibrary(); bus = new EventBus(); events = []; bus.on((e) => { events.push(e); }); });
afterEach(() => { lib.close(); });

function doneRun() {
  const { chapter } = seedEpisodeWorld(lib.store);
  const bd = breakdown(2);
  const run = seedRun(lib.store, chapter.id, {
    outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') }, status: 'done',
  });
  return { chapter, run };
}

const summaryJob = (run: { id: string; chapterId: string }) => {
  const payload: LlmStepPayload = { type: 'chapter-summary', chapterId: run.chapterId, runId: run.id };
  const job = lib.store.jobs.insert({ kind: 'llm.step', lane: 'claude', payload, priority: 0, maxAttempts: 2, nextRunAt: new Date().toISOString(), episodeRunId: run.id });
  return { job, payload: payload as Extract<LlmStepPayload, { type: 'chapter-summary' }> };
};

describe('chapter summary (W1 Q1)', () => {
  it('writes chapter.summary with one story call on the job\'s lane engine and emits chapter updated once', async () => {
    const { chapter, run } = doneRun();
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const { job, payload } = summaryJob(run);
    const ctx = fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job);
    const out = await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, ctx, payload);
    expect(out).toMatchObject({ summary: expect.any(String) });
    expect(lib.store.chapters.require(chapter.id).summary).toBe((out as { summary: string }).summary);
    expect(engine.calls.map((c) => [c.name, c.task])).toEqual([['episode.summary', 'story']]);
    const sent = extractContext<SummaryContext>(engine.calls[0]!.prompt);
    expect(sent.story).toContain('Page 1:\n- Page 1 panel 1');
    expect(engine.calls[0]!.system.length).toBeLessThan(1500); // G2: the story goes in the prompt, not the system prompt
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'chapter' && e.id === chapter.id)).toHaveLength(1);
  });

  it('writes the summary in the manga\'s language', async () => {
    const { manga, chapter } = seedEpisodeWorld(lib.store, { language: 'uk' });
    const bd = breakdown(2);
    const run = seedRun(lib.store, chapter.id, {
      outputs: { premise: PREMISE, outline: outline(['Aiko']), breakdown: bd, scripts: scripts(bd, 'Aiko') }, status: 'done',
    });
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const { job, payload } = summaryJob(run);
    await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job), payload);
    expect(engine.calls[0]!.system).toContain('in Ukrainian');
    expect(extractContext<SummaryContext>(engine.calls[0]!.prompt).language).toBe(manga.language);
    expect(lib.store.chapters.require(chapter.id).summary).toMatch(/^Розділ 1/);
  });

  it('skips a run that is no longer the finished latest one', async () => {
    const { chapter, run } = doneRun();
    lib.store.episodes.update(run.id, { status: 'running' });
    const engine = new ScriptedEngine('claude', EPISODE_FAKE_RESPONSES);
    const { job, payload } = summaryJob(run);
    const out = await writeChapterSummary({ store: lib.store, bus, engines: { forLane: () => engine } }, fakeJobContext(lib.store, bus, new FakeQueue(lib.store), job), payload);
    expect(out).toEqual({ skipped: true });
    expect(engine.calls).toEqual([]);
    expect(lib.store.chapters.require(chapter.id).summary).toBe('');
  });
});
