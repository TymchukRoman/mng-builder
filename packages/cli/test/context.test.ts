import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chapter, Character, Manga } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { createContext } from '../src/context.js';
import { CliError } from '../src/errors.js';
import { createResolver } from '../src/resolver.js';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const silent = { stdout: () => {}, stderr: () => {} };

describe('resolver', () => {
  it('resolves mangas by id or case-insensitive title and refuses ambiguous titles', async () => {
    const api = new ApiClient(h.url);
    const r = createResolver(api);
    const a = await api.post<Manga>('/api/mangas', { title: 'Night Market' });
    expect((await r.manga(a.id)).id).toBe(a.id);
    expect((await r.manga('night market')).id).toBe(a.id);
    await expect(r.manga('Nope')).rejects.toThrow('no manga matches "Nope"');
    await api.post('/api/mangas', { title: 'NIGHT MARKET' });
    await expect(r.manga('Night Market')).rejects.toThrow('"Night Market" matches 2 mangas; use the id');
    await expect(r.manga('mg_missing000')).rejects.toMatchObject({ status: 404 });
  });

  it('resolves characters within a manga, and chapters by id or <manga>/<number>', async () => {
    const api = new ApiClient(h.url);
    const r = createResolver(api);
    const m = await api.post<Manga>('/api/mangas', { title: 'Oni Tales' });
    const other = await api.post<Manga>('/api/mangas', { title: 'Other Tales' });
    const aiko = await api.post<Character>(`/api/mangas/${m.id}/characters`, { name: 'Aiko' });
    await api.post(`/api/mangas/${other.id}/characters`, { name: 'Aiko' });
    expect((await r.character('aiko', 'oni tales')).id).toBe(aiko.id);
    expect((await r.character(aiko.id)).id).toBe(aiko.id);
    await expect(r.character('Aiko')).rejects.toThrow(/matches 2 characters/);
    const chapter = await api.post<Chapter>(`/api/mangas/${m.id}/chapters`, { title: 'One' });
    expect((await r.chapter('Oni Tales/1')).id).toBe(chapter.id);
    expect((await r.chapter(chapter.id)).id).toBe(chapter.id);
    await expect(r.chapter('Oni Tales/9')).rejects.toThrow('no chapter matches "Oni Tales/9"');
    const bad = await r.chapter('garbage').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(CliError);
    expect((bad as CliError).exitCode).toBe(2);
  });
});

describe('createContext', () => {
  it('prints JSON with --json and the human text otherwise', async () => {
    const lines: string[] = [];
    const io = {
      stdout: (s: string) => {
        lines.push(s);
      },
      stderr: () => {},
    };
    const human = await createContext({ json: false, wait: false, url: h.url, io });
    human.out({ a: 1 }, () => 'human');
    const json = await createContext({ json: true, wait: false, url: h.url, io });
    json.out({ a: 1 }, () => 'human');
    expect(lines).toEqual(['human\n', '{\n  "a": 1\n}\n']);
    expect(human.baseUrl).toBe(h.url);
  });

  it('waitJobs streams progress to stderr and resolves once every job is terminal, including already-finished ones', async () => {
    const queue = h.server.deps.queue;
    queue.register('export.render', async (ctx) => {
      ctx.progress('Rendering page', 1, 2);
      await new Promise((r) => setTimeout(r, 30));
      ctx.progress('Rendering page', 2, 2);
      return { files: [] };
    });
    const early = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    await queue.waitFor(early.id);
    const errors: string[] = [];
    const c = await createContext({
      json: false, wait: true, url: h.url,
      io: {
        stdout: () => {},
        stderr: (s) => {
          errors.push(s);
        },
      },
    });
    const live = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    const jobs = await c.waitJobs([early.id, live.id]);
    expect(jobs.map((j) => [j.id, j.status])).toEqual([[early.id, 'succeeded'], [live.id, 'succeeded']]);
    expect(errors.join('')).toContain(`${live.id} Rendering page 2/2`);
    expect(await c.waitJobs([])).toEqual([]);
    const quiet = await createContext({ json: true, wait: true, url: h.url, io: silent });
    const third = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    expect((await quiet.waitJobs([third.id]))[0]?.status).toBe('succeeded');
  });
});

describe('runCli', () => {
  it('exits 0 for --help and --version and 2 for an unknown option', async () => {
    const help = await h.run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: manga');
    expect(await h.run('--version')).toMatchObject({ code: 0, stdout: '0.1.0\n' });
    const bad = await h.run('--bogus');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown option/);
  });
});
