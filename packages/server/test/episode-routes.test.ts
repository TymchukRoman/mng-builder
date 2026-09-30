import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SCRIPT, type ApiErrorBody, type Chapter, type EpisodeRun, type Job, type LlmStepPayload, type Manga, type PageDetail, type ServerEvent,
} from '@manga/shared';
import type { JsonRequest } from '../src/engines/types.js';
import type { episodeModule } from '../src/workflows/episode/module.js';
import { seedEpisodeWorld, seedRun, STAMP, TWO_PANEL_PRESET } from './helpers/episode-fixtures.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
/** Servers and libraries a test opened besides `s`; released in reverse order even when the test fails. */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await s?.close();
  s = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A library folder with a seeded chapter, closed and ready for a server to open. Removed after the test. */
function seededLibrary(): { dir: string; chapter: Chapter; store: TestLibrary['store'] } {
  const lib = openTestLibrary();
  cleanups.push(() => lib.close());
  const { chapter } = seedEpisodeWorld(lib.store);
  return { dir: lib.dir, chapter, store: lib.store };
}

async function chapterOn(server: M4TestServer): Promise<{ manga: Manga; chapter: Chapter }> {
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: `Routes ${Date.now()}` })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  return { manga, chapter };
}

async function runUntil(server: M4TestServer, chapterId: string, status: EpisodeRun['status'], step?: number): Promise<EpisodeRun> {
  return server.until(async () => {
    const run = (await server.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;
    return run && run.status === status && (step === undefined || run.currentStep === step) ? run : null;
  });
}

const premiseJobs = (server: M4TestServer, runId: string): Job[] =>
  server.deps.store.jobs.listByEpisodeRun(runId).filter((j) => (j.payload as { step?: string }).step === 'premise');

/** An answer that never comes: it ends only when the engine call is aborted (as when the server stops). */
const hangUntilAborted = (req: JsonRequest<unknown>): Promise<never> => new Promise((_resolve, reject) => {
  req.signal?.addEventListener('abort', () => reject(req.signal?.reason ?? new Error('aborted')), { once: true });
});

describe('episode routes', { timeout: 90_000 }, () => {
  it('GET is null before a run; POST starts one that stops at the outline in review mode', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    expect(await s.api('GET', `/api/chapters/${chapter.id}/episode`)).toEqual({ status: 200, body: null });
    const started = await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 }, mode: 'review' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ chapterId: chapter.id, mode: 'review', input: { prompt: 'A cat', pages: 1, characterIds: [], tone: '' } });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.steps[0]!.status).toBe('done');
  });

  it('maps errors: 409 conflict, 404 not_found, 400 validation', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    const again = await s.api<ApiErrorBody>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'Again', pages: 1 } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
    expect((await s.api<ApiErrorBody>('POST', '/api/episodes/er_missing000/approve')).status).toBe(404);
    const badStep = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/colouring/rerun`, {});
    expect([badStep.status, badStep.body.error.code]).toEqual([400, 'validation']);
    const badInput = await s.api<ApiErrorBody>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: '', pages: 99 } });
    expect([badInput.status, badInput.body.error.code]).toEqual([400, 'validation']);
  });

  it('PUT output validates and applies the edit', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    const premise = { title: 'Edited', synopsis: 'S.', tone: 'calm', setting: 'Pier' };
    const ok = await s.api<EpisodeRun>('PUT', `/api/episodes/${run.id}/steps/premise/output`, { output: premise });
    expect(ok.status).toBe(200);
    expect(ok.body.steps[0]!.output).toEqual(premise);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.title).toBe('Edited');
    const bad = await s.api<ApiErrorBody>('PUT', `/api/episodes/${run.id}/steps/outline/output`, { output: { scenes: [], newCharacters: [] } });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'validation']);
  });

  it('rerun answers 409 needs_confirm with the panel ids, and replaces the pages with confirm', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect((await s.api('POST', `/api/episodes/${run.id}/approve`)).status).toBe(200);
    await runUntil(s, chapter.id, 'awaiting-review', 3);
    const refused = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/breakdown/rerun`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('needs_confirm');
    expect((refused.body.error.details as { removedPanelIds: string[] }).removedPanelIds).toHaveLength(2);
    const accepted = await s.api<EpisodeRun>('POST', `/api/episodes/${run.id}/steps/breakdown/rerun`, { confirm: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.currentStep).toBe(2);
    await runUntil(s, chapter.id, 'awaiting-review', 3);
  });

  it('autopilot and cancel', async () => {
    s = await startM4TestServer();
    const a = await chapterOn(s);
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${a.chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, a.chapter.id, 'awaiting-review', 1);
    const cancelled = await s.api<EpisodeRun>('POST', `/api/episodes/${run.id}/cancel`);
    expect([cancelled.status, cancelled.body.status]).toEqual([200, 'cancelled']);
    expect((await s.api<Chapter>('GET', `/api/chapters/${a.chapter.id}`)).body.status).toBe('draft');
    const b = await chapterOn(s);
    const second = (await s.api<EpisodeRun>('POST', `/api/chapters/${b.chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await runUntil(s, b.chapter.id, 'awaiting-review', 1);
    expect((await s.api<EpisodeRun>('POST', `/api/episodes/${second.id}/autopilot`)).body.mode).toBe('autopilot');
    await runUntil(s, b.chapter.id, 'done');
    expect((await s.api<Chapter>('GET', `/api/chapters/${b.chapter.id}`)).body.status).toBe('ready');
  });

  it('auto-letter letters a page once and emits textFrame created per new frame (G5)', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: TWO_PANEL_PRESET })).body;
    const panel = page.panels[0]!;
    await s.api('PATCH', `/api/panels/${panel.id}`, {
      script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Rain.' }, { speakerId: null, kind: 'sfx', text: 'DRIP' }] },
    });
    const events: ServerEvent[] = [];
    s.deps.bus.on((e) => { events.push(e); });
    const first = await s.api<PageDetail>('POST', `/api/pages/${page.page.id}/auto-letter`);
    expect(first.status).toBe(200);
    expect(first.body.frames.map((f) => f.kind)).toEqual(['narration', 'sfx']);
    const entityEvents = () => events.flatMap((e) => (e.type === 'entity' ? [`${e.entity} ${e.op} ${e.id}`] : []));
    expect(entityEvents().sort()).toEqual(first.body.frames.map((f) => `textFrame created ${f.id}`).sort());
    events.length = 0;
    const second = await s.api<PageDetail>('POST', `/api/pages/${page.page.id}/auto-letter`);
    expect(second.body.frames).toHaveLength(2);
    expect(entityEvents()).toEqual([]);
    expect((await s.api('POST', '/api/pages/pg_missing000/auto-letter')).status).toBe(404);
  });

  it('resumes a running run when the server starts', async () => {
    const { dir, chapter, store } = seededLibrary();
    seedRun(store, chapter.id, { input: { pages: 1 } });
    store.close();
    s = await startM4TestServer({ library: dir });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.steps[0]!.status).toBe('done');
  });

  it('restart: a run stopped mid-step continues on a new server over the same library', async () => {
    const { dir, chapter, store } = seededLibrary();
    store.close();
    const first = await startM4TestServer({ library: dir, claude: { 'episode.premise': hangUntilAborted } });
    cleanups.push(() => first.close());
    const started = (await first.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    await first.until(async () => first.claude.calls.some((c) => c.name === 'episode.premise') || null);
    await first.close(); // the premise call is interrupted: its job goes back to queued and the step stays running
    s = await startM4TestServer({ library: dir });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.id).toBe(started.id);
    expect(run.steps[0]!.status).toBe('done');
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.title).toBe('The Cat in the Rain');
    expect(premiseJobs(s, run.id).map((j) => j.status)).toEqual(['succeeded']); // the interrupted job was re-run, not duplicated
  });

  it('restart: the resumed run is watching its job, so a failure after the restart fails the step', async () => {
    const { dir, chapter, store } = seededLibrary();
    store.close();
    const first = await startM4TestServer({ library: dir, claude: { 'episode.premise': hangUntilAborted } });
    cleanups.push(() => first.close());
    await first.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } });
    await first.until(async () => first.claude.calls.some((c) => c.name === 'episode.premise') || null);
    await first.close();
    s = await startM4TestServer({ library: dir, claude: { 'episode.premise': () => { throw new Error('engine gone'); } } });
    const run = await runUntil(s, chapter.id, 'failed');
    expect(run.steps[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('engine gone') as string });
  });

  it('crash: a step job left running in the database is queued again before the run resumes, and runs once', async () => {
    const { dir, chapter, store } = seededLibrary();
    // What a crash leaves behind: no graceful stop, the premise step running with its job claimed (status 'running').
    const seeded = seedRun(store, chapter.id, { input: { pages: 1 } });
    store.episodes.update(seeded.id, { steps: seeded.steps.map((st, i) => (i === 0 ? { ...st, status: 'running' as const, startedAt: STAMP } : st)) });
    const payload: LlmStepPayload = { type: 'episode', runId: seeded.id, step: 'premise' };
    const inserted = store.jobs.insert({ kind: 'llm.step', lane: 'claude', priority: 0, payload, maxAttempts: 3, nextRunAt: STAMP, episodeRunId: seeded.id });
    expect(store.jobs.claimNext('claude', new Date().toISOString())?.id).toBe(inserted.id);
    expect(store.jobs.require(inserted.id).status).toBe('running');
    store.close();

    // resume() must see the job as queued: startServer runs queue.recover() before the modules' start().
    const seenAtResume: Array<string | undefined> = [];
    s = await startM4TestServer({
      library: dir,
      inspectModules: (modules, deps) => {
        const episode = modules.find((m) => m.name === 'episode') as ReturnType<typeof episodeModule>;
        const resume = episode.runner.resume.bind(episode.runner);
        episode.runner.resume = (): number => {
          seenAtResume.push(deps.store.jobs.get(inserted.id)?.status);
          return resume();
        };
      },
    });
    const run = await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(run.id).toBe(seeded.id);
    expect(seenAtResume).toEqual(['queued']);
    const jobs = premiseJobs(s, run.id);
    expect(jobs.map((j) => [j.id, j.status])).toEqual([[inserted.id, 'succeeded']]); // the same job ran, once, and no second one was queued
    expect(s.claude.calls.filter((c) => c.name === 'episode.premise')).toHaveLength(1);
  });
});

describe('episode steps and engines (F1, I1)', { timeout: 90_000 }, () => {
  it('an episode step runs on the engine of its lane, whatever the settings say when it starts', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    // Hold the claude lane, queue a step there, switch the stored settings to local without re-laning, then release.
    s.deps.queue.pauseLane('claude', null, 'test hold');
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    const [job] = s.deps.store.jobs.listByEpisodeRun(run.id);
    expect(job!.lane).toBe('claude');
    s.deps.store.settings.patch({ engine: { mode: 'local' } }); // store only: no settings event, so nothing re-lanes the job
    s.deps.queue.resumeLane('claude');
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(s.claude.calls.map((c) => c.name)).toEqual(['episode.premise']);
    expect(s.local.calls.map((c) => c.name)).toEqual(['episode.outline']); // the next step was queued after the switch
  });

  it('an engine switch through PATCH /api/settings re-lanes the queued episode step, which then runs on local', async () => {
    s = await startM4TestServer();
    const { chapter } = await chapterOn(s);
    s.deps.queue.pauseLane('claude', null, 'test hold');
    const run = (await s.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, { input: { prompt: 'A cat', pages: 1 } })).body;
    const [job] = s.deps.store.jobs.listByEpisodeRun(run.id);
    expect(job!.lane).toBe('claude');
    expect((await s.api('PATCH', '/api/settings', { engine: { mode: 'local' } })).status).toBe(200);
    expect(s.deps.store.jobs.require(job!.id).lane).toBe('gpu');
    await runUntil(s, chapter.id, 'awaiting-review', 1);
    expect(s.local.calls.map((c) => c.name)).toEqual(['episode.premise', 'episode.outline']);
    expect(s.claude.calls).toEqual([]);
  });
});
