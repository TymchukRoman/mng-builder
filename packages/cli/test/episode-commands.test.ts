import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SCRIPT, GPU_MANUAL_PAUSE_REASON, type Chapter, type Character, type EpisodeRun, type Job, type Manga, type PageDetail, type QueueLanes } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { registerChapterCommands } from '../src/commands/chapters.js';
import { registerEpisodeCommands } from '../src/commands/episode.js';
import { registerExportCommands } from '../src/commands/export.js';
import { registerQueueCommands } from '../src/commands/queue.js';
import { registerTextAutoCommand } from '../src/commands/text-auto.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/errors.js';
import { buildProgram, exitCodeFor, runCli } from '../src/program.js';
import { startM4TestServer, type M4TestServer, type M4TestServerOptions } from '../../server/test/helpers/m4-server.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const FAILING_PREMISE: M4TestServerOptions = { claude: { 'episode.premise': () => { throw new Error('model overloaded'); } } };

interface CtxOptions { json?: boolean; signal?: AbortSignal }

function testContext(baseUrl: string, outputs: unknown[], stderr: string[], wait: boolean, opts: CtxOptions = {}): CliContext {
  const api = new ApiClient(baseUrl);
  return {
    api, json: opts.json === true, wait, baseUrl,
    io: { stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, ...(opts.signal ? { signal: opts.signal } : {}) },
    out: (data, human) => { outputs.push(data); humans.push(human()); },
    waitJobs: async (ids) => {
      const done: Job[] = [];
      for (const id of ids) {
        for (;;) {
          const job = await api.get<Job>(`/api/jobs/${id}`);
          if (TERMINAL.has(job.status)) { done.push(job); break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return done;
    },
    resolve: {
      manga: (ref) => api.get(`/api/mangas/${ref}`),
      character: async (ref, mangaRef) => {
        const list = await api.get<Character[]>(`/api/mangas/${mangaRef}/characters`);
        const hit = list.find((c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase());
        if (!hit) throw new Error(`no character ${ref}`);
        return hit;
      },
      chapter: (ref) => api.get(`/api/chapters/${ref}`),
      page: (id) => api.get(`/api/pages/${id}`),
      panel: (id) => api.get(`/api/panels/${id}`),
      frame: (id) => api.get(`/api/frames/${id}`),
    },
  };
}

let s: M4TestServer;
let outputs: unknown[];
let stderr: string[];
let stdout: string[];
let humans: string[];
const open: M4TestServer[] = [];
async function serve(opts?: M4TestServerOptions): Promise<void> {
  s = await startM4TestServer(opts);
  open.push(s);
}
beforeEach(() => {
  outputs = [];
  stderr = [];
  stdout = [];
  humans = [];
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

function manga(wait = false, opts: CtxOptions = {}): Command {
  const ctx = testContext(s.url, outputs, stderr, wait, opts);
  const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride().configureOutput({ writeErr: () => undefined });
  root.command('text'); // M1's group
  registerChapterCommands(root, async () => ctx);
  registerEpisodeCommands(root, async () => ctx);
  registerQueueCommands(root, async () => ctx);
  registerExportCommands(root, async () => ctx);
  registerTextAutoCommand(root, async () => ctx);
  return root;
}
const run = (args: string[], wait = false, opts: CtxOptions = {}) => manga(wait, opts).parseAsync(args, { from: 'user' });
const last = <T>() => outputs.at(-1) as T;

async function world(): Promise<{ chapter: Chapter; aiko: Character }> {
  const m = (await s.api<Manga>('POST', '/api/mangas', { title: `CLI ${Date.now()}` })).body;
  const aiko = (await s.api<Character>('POST', `/api/mangas/${m.id}/characters`, { name: 'Aiko' })).body;
  const chapter = (await s.api<Chapter>('POST', `/api/mangas/${m.id}/chapters`, { title: 'One' })).body;
  return { chapter, aiko };
}

const latest = async (chapterId: string): Promise<EpisodeRun | null> => (await s.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;

async function awaitingAt(chapterId: string, step: number): Promise<void> {
  await s.until(async () => {
    const r = await latest(chapterId);
    return r?.status === 'awaiting-review' && r.currentStep === step;
  });
}

describe('manga episode …', { timeout: 90_000 }, () => {
  beforeEach(() => serve());

  it('start --autopilot --wait follows the run to the end', async () => {
    const { chapter, aiko } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat in the rain', '--pages', '1', '--chars', 'aiko', '--autopilot'], true);
    const final = last<EpisodeRun>();
    expect(final.status).toBe('done');
    expect(final.input).toMatchObject({ pages: 1, characterIds: [aiko.id] });
    expect(stderr.at(-1)).toBe('done: lettering done\n');
  });

  it('start stops at review points; status prints; approve --wait continues to the next one', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat']);
    expect(last<EpisodeRun>().mode).toBe('review');
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'status', chapter.id]);
    expect(last<EpisodeRun>().currentStep).toBe(1);
    await run(['episode', 'approve', chapter.id], true);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
  });

  it('edit reads the output from a JSON file; rerun needs --confirm once pages exist', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '1']);
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'approve', chapter.id], true);
    const file = join(mkdtempSync(join(tmpdir(), 'manga-cli-')), 'premise.json');
    writeFileSync(file, JSON.stringify({ title: 'From a file', synopsis: 'S.', tone: 'calm', setting: 'Pier' }));
    await run(['episode', 'edit', chapter.id, 'premise', '--file', file]);
    // The typed chapter title ('One') stays; the edited premise reaches the chapter's synopsis (M4 final M6).
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body).toMatchObject({ title: 'One', synopsis: 'S.' });
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow(CliError);
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow(/^re-running breakdown replaces the chapter's pages \(\d+ panels: pn_\w+.*\); add --confirm$/);
    await run(['episode', 'rerun', chapter.id, 'breakdown', '--confirm'], true);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
  });

  /** What the server itself says the rerun would replace (the story pages' panels; the cover is kept). */
  async function removedIds(chapterId: string): Promise<string[]> {
    const runId = (await latest(chapterId))!.id;
    const refused = await s.api<{ error: { details: { removedPanelIds: string[] } } }>('POST', `/api/episodes/${runId}/steps/breakdown/rerun`, {});
    return refused.body.error.details.removedPanelIds;
  }

  async function pagesExist(): Promise<Chapter> {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '1']);
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'approve', chapter.id], true);
    return chapter;
  }

  it('rerun without --confirm lists the panel ids in the error', async () => {
    const chapter = await pagesExist();
    const err = await run(['episode', 'rerun', chapter.id, 'breakdown']).catch((e: unknown) => e);
    const ids = await removedIds(chapter.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1, silent: false });
    expect((err as Error).message).toBe(`re-running breakdown replaces the chapter's pages (${ids.length} panels: ${ids.join(', ')}); add --confirm`);
  });

  it('rerun without --confirm under --json prints { error, removedPanelIds } on stdout and fails silently', async () => {
    const chapter = await pagesExist();
    stderr.length = 0;
    const ids = await removedIds(chapter.id);
    const err = await run(['episode', 'rerun', chapter.id, 'breakdown'], false, { json: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1, silent: true });
    const printed = JSON.parse(stdout.join('')) as { error: string; removedPanelIds: string[] };
    expect(printed.error).toBe('needs_confirm');
    expect([...printed.removedPanelIds].sort()).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(0);
    expect(stderr).toEqual([]);
  });

  it('cancel stops the run', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat']);
    await awaitingAt(chapter.id, 1);
    await run(['episode', 'cancel', chapter.id]);
    expect(last<EpisodeRun>().status).toBe('cancelled');
  });

  it('rejects a bad step name and a bad page count as usage errors', async () => {
    const { chapter } = await world();
    await expect(run(['episode', 'rerun', chapter.id, 'colouring'])).rejects.toBeInstanceOf(CommanderError);
    await expect(run(['episode', 'start', chapter.id, '--prompt', 'x', '--pages', '0'])).rejects.toBeInstanceOf(CommanderError);
  });
});

describe('manga episode --wait exit codes (F17)', { timeout: 90_000 }, () => {
  it('start --wait prints the run, then exits 1 with the step error when the run ends failed', async () => {
    await serve(FAILING_PREMISE);
    const { chapter } = await world();
    const err = await run(['episode', 'start', chapter.id, '--prompt', 'A cat'], true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ exitCode: 1 });
    expect((err as Error).message).toMatch(/^episode failed: .*model overloaded/);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'failed', currentStep: 0 });
    expect(stderr.at(-1)).toBe('failed: premise failed\n');
  });

  it('without --wait a failed run is only reported', async () => {
    await serve(FAILING_PREMISE);
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat']);
    await s.until(async () => (await latest(chapter.id))?.status === 'failed' || null);
    await run(['episode', 'status', chapter.id]);
    expect(last<EpisodeRun>().status).toBe('failed');
  });

  it('a run cancelled while --wait follows it exits 1 with "episode cancelled"', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await serve({ claude: { 'episode.premise': async (req) => { await held; req.signal?.throwIfAborted(); throw new Error('unreachable'); } } });
    const { chapter } = await world();
    const pending = run(['episode', 'start', chapter.id, '--prompt', 'A cat'], true).catch((e: unknown) => e);
    await s.until(async () => s.claude.calls.some((c) => c.name === 'episode.premise') || null);
    const runId = (await latest(chapter.id))!.id;
    await s.api('POST', `/api/episodes/${runId}/cancel`);
    release();
    const err = await pending;
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1 });
    expect((err as Error).message).toMatch(/^episode cancelled/);
    expect(last<EpisodeRun>().status).toBe('cancelled');
  });

  it('an aborted --wait follow exits 1 as interrupted (not 0) and returns at once', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await serve({ claude: { 'episode.premise': async (req) => { await held; req.signal?.throwIfAborted(); throw new Error('unreachable'); } } });
    const { chapter } = await world();
    const controller = new AbortController();
    const pending = run(['episode', 'start', chapter.id, '--prompt', 'A cat'], true, { signal: controller.signal }).catch((e: unknown) => e);
    await s.until(async () => s.claude.calls.some((c) => c.name === 'episode.premise') || null);
    controller.abort();
    const err = await pending;
    release();
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1 });
    expect((err as Error).message).toMatch(/^interrupted: episode still running/);
    expect(last<EpisodeRun>().status).toBe('running');
  });

  it('the real program prints the run as JSON and exits 1', async () => {
    await serve(FAILING_PREMISE);
    const { chapter } = await world();
    let out = '';
    let err = '';
    const io = { stdout: (t: string) => { out += t; }, stderr: (t: string) => { err += t; } };
    const code = await runCli(['--url', s.url, '--json', '--wait', 'episode', 'start', chapter.id, '--prompt', 'A cat'], io);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: 'failed' });
    expect(err).toMatch(/^error: episode failed: .*model overloaded\n$/);
  });

  it('the real program registers episode, export and text auto', () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['episode', 'export', 'text']));
    expect(program.commands.find((c) => c.name() === 'text')?.commands.map((c) => c.name())).toContain('auto');
    expect(exitCodeFor(new CliError('x', 1), { stdout: () => undefined, stderr: () => undefined })).toBe(1);
  });
});

describe('manga export / text auto', { timeout: 60_000 }, () => {
  beforeEach(() => serve());

  it('export prints the job id, and with --wait reports why the job failed (exit 1)', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    await run(['export', chapter.id, '--format', 'png']);
    expect(last<{ jobId: string }>().jobId).toMatch(/^jb_/);
    const err = await run(['export', chapter.id], true).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1 });
    expect((err as Error).message).toMatch(/^export failed: The UI is not built/);
  });

  it('export --wait --json prints the failed Job before exiting 1', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    const err = await run(['export', chapter.id], true, { json: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CliError', exitCode: 1 });
    expect(last<Job>()).toMatchObject({ kind: 'export.render', status: 'failed' });
    expect(last<Job>().error).toContain('The UI is not built');
  });

  it('export sends --out as an absolute path resolved against the CLI cwd (Task 12 carry-over)', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    const outDirOf = (): string | undefined => (s.deps.store.jobs.require(last<{ jobId: string }>().jobId).payload as { outDir?: string }).outDir;
    await run(['export', chapter.id, '--out', 'relative-out']);
    expect(outDirOf()).toBe(resolve('relative-out'));
    expect(isAbsolute(outDirOf() ?? '')).toBe(true);
    await run(['export', chapter.id]);
    expect(outDirOf()).toBeUndefined();
  });

  it('export of a pg_ id targets the page', async () => {
    const { chapter } = await world();
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' })).body;
    await run(['export', page.page.id, '--format', 'png']);
    expect(s.deps.store.jobs.require(last<{ jobId: string }>().jobId).payload).toMatchObject({ target: { type: 'page', id: page.page.id }, format: 'png' });
  });

  it('text auto letters a page', async () => {
    const { chapter } = await world();
    const page = (await s.api<PageDetail>('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' })).body;
    await s.api('PATCH', `/api/panels/${page.panels[0]!.id}`, { script: { ...EMPTY_SCRIPT, dialogue: [{ speakerId: null, kind: 'narration', text: 'Rain.' }] } });
    await run(['text', 'auto', page.page.id]);
    expect(last<PageDetail>().frames.map((f) => f.text)).toEqual(['Rain.']);
    expect(humans.at(-1)).toBe(`1 frames created on ${page.page.id} (1 in all)`);
    await run(['text', 'auto', page.page.id]);
    expect(last<PageDetail>().frames.map((f) => f.text)).toEqual(['Rain.']);
    expect(humans.at(-1)).toBe(`0 frames created on ${page.page.id} (1 in all)`);
  });
});

describe('manga W1 commands', { timeout: 90_000 }, () => {
  beforeEach(() => serve());

  it('episode start previews by default, --no-preview turns it off, and the estimate goes to stderr', async () => {
    const a = await world();
    await run(['episode', 'start', a.chapter.id, '--prompt', 'A cat', '--pages', '8']);
    expect(last<EpisodeRun>().input.previewFirst).toBe(true);
    expect(stderr[0]).toBe('8 pages ≈ 36 panels ≈ 37 min\n');
    const b = await world();
    await run(['episode', 'start', b.chapter.id, '--prompt', 'A cat', '--no-preview']);
    expect(last<EpisodeRun>().input.previewFirst).toBe(false);
  });

  it('the estimate stays off stderr under --json', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat'], false, { json: true });
    expect(stderr).toEqual([]);
  });

  it('episode pause and resume a rendering run; with --wait, pause returns at the pause and resume follows to the end', async () => {
    s.fake.loadDelayMs = 1_500; // each image takes a while: the render step is caught running
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '2', '--autopilot', '--no-preview']);
    await s.until(async () => {
      const r = await latest(chapter.id);
      return r?.status === 'running' && r.currentStep === 5 && r.steps[5]!.status === 'running';
    });
    await run(['episode', 'pause', chapter.id], true); // Task 7 minor 2: a pause is a stop; --wait returns (exit 0)
    expect(last<EpisodeRun>().status).toBe('paused');
    s.fake.loadDelayMs = 0;
    await run(['episode', 'resume', chapter.id], true);
    expect(last<EpisodeRun>().status).toBe('done');
  });

  it('a 409 from the server surfaces with its message and exits 1 (Task 7 minor 2)', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '2']); // stops at the outline review
    await awaitingAt(chapter.id, 1);
    const io = { stdout: () => undefined, stderr: (t: string) => { stderr.push(t); } };
    const paused = await run(['episode', 'pause', chapter.id]).catch((e: unknown) => e);
    expect((paused as Error).message).toBe('only a run that is rendering images can be paused');
    expect(exitCodeFor(paused, io)).toBe(1);
    const missing = await run(['chapter', 'render-missing', chapter.id]).catch((e: unknown) => e);
    expect((missing as Error).message).toBe('the episode has not rendered this chapter yet; wait for its render step');
    expect(exitCodeFor(missing, io)).toBe(1);
    expect(stderr.slice(-2)).toEqual([
      'error: only a run that is rendering images can be paused\n',
      'error: the episode has not rendered this chapter yet; wait for its render step\n',
    ]);
  });

  it('chapter render-missing --wait exits 1 when a job fails (Task 7 minor 2)', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    s.fake.failNext = 'CUDA error: an illegal memory access';
    const err = await run(['chapter', 'render-missing', chapter.id], true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(1);
    expect((err as Error).message).toBe('1 job(s) did not succeed');
    expect(last<Job[]>().map((j) => j.status).sort()).toEqual(['failed', 'succeeded']);
  });

  it('chapter render-missing --wait renders the panels without an image; a second call has nothing to do', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    await run(['chapter', 'render-missing', chapter.id], true);
    expect(last<Job[]>().map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    await run(['chapter', 'render-missing', chapter.id], true);
    expect(last<Job[]>()).toEqual([]);
    expect(humans.at(-1)).toBe('no panels without an image');
  });

  it('chapter render-missing without --wait prints the job ids', async () => {
    const { chapter } = await world();
    await s.api('POST', `/api/chapters/${chapter.id}/pages`, { layoutPreset: '2-rows' });
    await run(['chapter', 'render-missing', chapter.id]);
    expect(last<{ jobIds: string[] }>().jobIds).toHaveLength(2);
    expect(humans.at(-1)).toMatch(/^jb_\w+\njb_\w+$/);
  });

  it('an autopilot --wait run that stops at the page 1 preview says what is left (F20)', async () => {
    const { chapter } = await world();
    await run(['episode', 'start', chapter.id, '--prompt', 'A cat', '--pages', '2', '--autopilot'], true);
    expect(last<EpisodeRun>().status).toBe('awaiting-review');
    const hint = `manga episode approve ${chapter.id}`; // Task 7 minor 1: how to answer the stop
    expect(stderr.filter((l) => l.startsWith('awaiting-review')).at(-1))
      .toMatch(new RegExp(`^awaiting-review: Page 1 is ready — continue with \\d+ panels \\(~\\d+ (s|min)\\)\\? — ${hint}\n$`));
    expect(humans.at(-1)).toMatch(/\nPage 1 is ready — continue with \d+ panels/);
    expect(humans.at(-1)).toContain(hint);
  });

  it('chapter edit --summary patches the summary', async () => {
    const { chapter } = await world();
    await run(['chapter', 'edit', chapter.id, '--summary', 'Aiko found the cat.']);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.summary).toBe('Aiko found the cat.');
  });

  it('queue pause|resume gpu; another lane is refused', async () => {
    await run(['queue', 'pause', 'gpu']);
    expect(last<QueueLanes>().pausedLanes).toEqual([{ lane: 'gpu', until: null, reason: GPU_MANUAL_PAUSE_REASON }]);
    expect(humans.at(-1)).toBe(`gpu paused: ${GPU_MANUAL_PAUSE_REASON}`);
    await run(['queue', 'resume', 'gpu']);
    expect(last<QueueLanes>().pausedLanes).toEqual([]);
    expect(humans.at(-1)).toBe('no lane is paused');
    await expect(run(['queue', 'pause', 'cpu'])).rejects.toThrow(/only the gpu lane/);
  });

  it('the real program registers queue', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('queue');
  });
});
