import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_MODEL_IDS, type AutoRun, type Chapter, type GalleryPageResult, type Job, type Manga } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { parseChapterModels, parseModel, runLine } from '../src/commands/auto.js';
import { registerAutoCommands } from '../src/commands/auto.js';
import { registerChapterCommands } from '../src/commands/chapters.js';
import { registerMangaCommands } from '../src/commands/mangas.js';
import type { CliContext } from '../src/context.js';
import { startM4TestServer, type M4TestServer } from '../../server/test/helpers/m4-server.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

describe('auto helpers', () => {
  it('parses image models and per-chapter models', () => {
    expect(parseModel('flux2')).toBe('flux2');
    expect(parseModel('-')).toBe('-');
    expect(() => parseModel('nope')).toThrow(IMAGE_MODEL_IDS.join(', '));
    expect(parseChapterModels(['2=anima', '3=-'], 3)).toEqual([null, 'anima', null]);
    expect(() => parseChapterModels(['4=anima'], 3)).toThrow('3 chapters');
    expect(() => parseChapterModels(['anima'], 3)).toThrow('<chapter number>=<model>');
  });

  it('describes a run on one line', () => {
    const run = { id: 'ar_1', mangaId: 'mg_1', status: 'running', stage: 'chapters', currentChapter: 1, chapterIds: ['a', 'b', 'c'], error: null } as unknown as AutoRun;
    expect(runLine(run)).toBe('ar_1  chapter 2/3');
    expect(runLine({ ...run, status: 'failed', stage: 'plan', error: 'boom' })).toBe('ar_1  failed at plan  (boom)');
  });
});

describe('manga auto …', { timeout: 90_000 }, () => {
  let s: M4TestServer;
  let outputs: unknown[];
  let stderr: string[];
  beforeEach(async () => {
    outputs = [];
    stderr = [];
    s = await startM4TestServer();
  });
  afterEach(async () => { await s.close(); });

  function program(wait: boolean): Command {
    const api = new ApiClient(s.url);
    const ctx: CliContext = {
      api, json: false, wait, baseUrl: s.url,
      io: { stdout: () => undefined, stderr: (t) => { stderr.push(t); } },
      out: (data) => { outputs.push(data); },
      waitJobs: async (ids) => {
        const done: Job[] = [];
        for (const id of ids) for (;;) { const j = await api.get<Job>(`/api/jobs/${id}`); if (TERMINAL.has(j.status)) { done.push(j); break; } await new Promise((r) => setTimeout(r, 25)); }
        return done;
      },
      resolve: {
        manga: (ref) => api.get(`/api/mangas/${ref}`), character: () => Promise.reject(new Error('unused')),
        chapter: (ref) => api.get(`/api/chapters/${ref}`), page: (id) => api.get(`/api/pages/${id}`), panel: (id) => api.get(`/api/panels/${id}`), frame: (id) => api.get(`/api/frames/${id}`),
      },
    };
    const root = new Command('manga').option('--json').option('--wait').option('--url <url>').exitOverride().configureOutput({ writeErr: () => undefined });
    registerMangaCommands(root, async () => ctx);
    registerChapterCommands(root, async () => ctx);
    registerAutoCommands(root, async () => ctx);
    return root;
  }
  const run = (args: string[], wait = false) => program(wait).parseAsync(args, { from: 'user' });

  it('start --wait makes the whole manga and prints the estimate first', async () => {
    await run(['auto', 'start', 'Two friends. Simplistic art style.', '--chapters', '2', '--pages', '1', '--model', 'flux2', '--chapter-model', '2=anima', '--no-poster'], true);
    const final = outputs.at(-1) as AutoRun;
    expect(final).toMatchObject({ status: 'done', stage: 'done' });
    expect(stderr[0]).toMatch(/^2 chapters × 1 page ≈ \d+ panels ≈ /);
    expect(stderr.at(-1)).toMatch(/done/);
    const chapters = (await s.api<Chapter[]>('GET', `/api/mangas/${final.mangaId}/chapters`)).body;
    expect(chapters.map((c) => c.imageModel)).toEqual([null, 'anima']);
    expect((await s.api<Manga>('GET', `/api/mangas/${final.mangaId}`)).body.imageModel).toBe('flux2');

    await run(['auto', 'status', final.mangaId]);
    expect((outputs.at(-1) as AutoRun).id).toBe(final.id);
    await expect(run(['auto', 'cancel', final.mangaId])).rejects.toThrow(/already done/);

    await run(['gallery', '--manga', final.mangaId, '--limit', '5']);
    expect((outputs.at(-1) as GalleryPageResult).items.length).toBeGreaterThan(0);
  });

  it('lists the models and sets them on a manga and a chapter', async () => {
    await run(['models']);
    expect((outputs.at(-1) as Array<{ id: string }>).map((m) => m.id)).toEqual(IMAGE_MODEL_IDS);
    await run(['create', 'Models', '--model', 'qwen']);
    const manga = outputs.at(-1) as Manga;
    expect(manga.imageModel).toBe('qwen');
    await run(['edit', manga.id, '--model', '-']);
    expect((outputs.at(-1) as Manga).imageModel).toBeNull();
    await run(['chapter', 'add', manga.id, 'One', '--model', 'anima']);
    const chapter = outputs.at(-1) as Chapter;
    expect(chapter.imageModel).toBe('anima');
    await run(['chapter', 'edit', chapter.id, '--model', '-']);
    expect((outputs.at(-1) as Chapter).imageModel).toBeNull();
    await expect(run(['edit', manga.id, '--model', 'nope'])).rejects.toThrow();
  });
});
