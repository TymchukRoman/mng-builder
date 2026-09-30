import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SCRIPT, type Chapter, type Character, type EpisodeRun, type Job, type Manga, type PageDetail } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { registerEpisodeCommands } from '../src/commands/episode.js';
import { registerExportCommands } from '../src/commands/export.js';
import { registerTextAutoCommand } from '../src/commands/text-auto.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/errors.js';
import { buildProgram, exitCodeFor, runCli } from '../src/program.js';
import { startM4TestServer, type M4TestServer, type M4TestServerOptions } from '../../server/test/helpers/m4-server.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const FAILING_PREMISE: M4TestServerOptions = { claude: { 'episode.premise': () => { throw new Error('model overloaded'); } } };

function testContext(baseUrl: string, outputs: unknown[], stderr: string[], wait: boolean): CliContext {
  const api = new ApiClient(baseUrl);
  return {
    api, json: false, wait, baseUrl,
    io: { stdout: () => undefined, stderr: (t) => { stderr.push(t); } },
    out: (data) => { outputs.push(data); },
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
const open: M4TestServer[] = [];
async function serve(opts?: M4TestServerOptions): Promise<void> {
  s = await startM4TestServer(opts);
  open.push(s);
}
beforeEach(() => {
  outputs = [];
  stderr = [];
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

function manga(wait = false): Command {
  const ctx = testContext(s.url, outputs, stderr, wait);
  const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride().configureOutput({ writeErr: () => undefined });
  root.command('text'); // M1's group
  registerEpisodeCommands(root, async () => ctx);
  registerExportCommands(root, async () => ctx);
  registerTextAutoCommand(root, async () => ctx);
  return root;
}
const run = (args: string[], wait = false) => manga(wait).parseAsync(args, { from: 'user' });
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
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.title).toBe('From a file');
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow(CliError);
    await expect(run(['episode', 'rerun', chapter.id, 'breakdown'])).rejects.toThrow("re-running breakdown replaces the chapter's pages (2 panels); add --confirm");
    await run(['episode', 'rerun', chapter.id, 'breakdown', '--confirm'], true);
    expect(last<EpisodeRun>()).toMatchObject({ status: 'awaiting-review', currentStep: 3 });
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
  });
});
