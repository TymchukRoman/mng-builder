import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readingOrder, type Chapter, type Character, type Manga, type PageDetail, type ServiceStatus, type Settings } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { runCli } from '../src/program.js';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('status and engine', () => {
  it('status prints the server, services and the queue', async () => {
    const r = await h.run('status');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^server\\s+${h.url.replace(/\./g, '\\.')}$`, 'm'));
    expect(r.stdout).toMatch(/^claude\s+down\s+not configured$/m);
    expect(r.stdout).toMatch(/^queue\s+0 queued, 0 running$/m);
    expect((await h.json<ServiceStatus>('status')).queue).toEqual({ queued: 0, running: 0, pausedLanes: [] });
  });

  it('engine shows and sets the global mode and per-task overrides', async () => {
    expect((await h.run('engine')).stdout).toMatch(/^mode\s+claude$/m);
    expect((await h.run('engine', 'local')).stdout).toMatch(/^mode\s+local$/m);
    const r = await h.run('engine', '--task', 'story=claude', 'review=claude');
    expect(r.stdout).toMatch(/^story\s+claude \(override\)$/m);
    expect(r.stdout).toMatch(/^prompts\s+local$/m);
    await h.run('engine', '--task', 'story=default');
    expect(await h.json<Settings['engine']>('engine')).toEqual({ mode: 'local', tasks: { review: 'claude' } });
    const bad = await h.run('engine', 'gpt');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/engine must be claude or local/);
    expect((await h.run('engine', '--task', 'plot=local')).code).toBe(2);
    expect((await h.run('engine', 'claude', '--task', 'review=default')).code).toBe(0);
  });
});

describe('mangas', () => {
  it('create, list, show and rm', async () => {
    const created = await h.run('create', 'Night Market', '--lang', 'uk', '--dir', 'ltr');
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/^created mg_[a-z2-7]{10}  Night Market  \(uk, bw, ltr\)\n$/);
    const sunny = await h.json<Manga>('create', 'Sunny', '--color', 'color');
    expect(sunny.styleGuide.stylePrompt).toContain('vibrant colors');
    const list = await h.run('list');
    expect(list.stdout).toMatch(/Night Market\s+uk\s+bw\s+ltr/);
    expect(list.stdout).toMatch(/Sunny\s+en\s+color\s+rtl/);

    const night = (await h.json<Manga[]>('list')).find((m) => m.title === 'Night Market');
    expect(night).toBeDefined();
    const api = new ApiClient(h.url);
    const aiko = await api.post<Character>(`/api/mangas/${night?.id}/characters`, { name: 'Aiko', role: 'main' });
    const chapter = await api.post<Chapter>(`/api/mangas/${night?.id}/chapters`, { title: 'Opening' });
    const page = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: '2x2' });
    const order = readingOrder(page.page.layout, 'ltr');
    const shown = await h.run('show', 'night market');
    expect(shown.stdout).toContain(`  ${aiko.id}  Aiko  main`);
    expect(shown.stdout).toContain(`  #1  ${chapter.id}  Opening  draft`);
    expect(shown.stdout).toContain(`      p1  ${page.page.id}  ${order.join(' ')}`);
    const json = await h.json<{ chapters: Array<{ pages: Array<{ id: string; panelIds: string[] }> }> }>('show', 'night market');
    expect(json.chapters[0]?.pages[0]).toMatchObject({ id: page.page.id, panelIds: order });

    expect((await h.run('rm', 'sunny')).stdout).toBe(`deleted ${sunny.id}  Sunny\n`);
    const gone = await h.run('show', 'Sunny');
    expect(gone.code).toBe(1);
    expect(gone.stderr).toBe('error: no manga matches "Sunny"\n');
  });

  it('create takes the colour mode from --style, and warns when an explicit --color disagrees (F3)', async () => {
    const styled = await h.run('--json', 'create', 'Neon Alley', '--style', 'anime-color');
    expect([styled.code, (JSON.parse(styled.stdout) as Manga).colorMode, styled.stderr]).toEqual([0, 'color', '']);
    const mixed = await h.run('--json', 'create', 'Ink Alley', '--color', 'bw', '--style', 'anime-color');
    expect([mixed.code, (JSON.parse(mixed.stdout) as Manga).colorMode]).toEqual([0, 'bw']);
    expect(mixed.stderr).toBe('warning: style anime-color is a color preset; keeping --color bw\n');
  });

  it('reports API validation errors on stderr with exit 1', async () => {
    const r = await h.run('create', 'X', '--lang', 'fr');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: language: /);
  });

  it('exits 2 for an unknown command or a missing argument', async () => {
    const unknown = await h.run('frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown command 'frobnicate'/);
    expect((await h.run('show')).code).toBe(2);
  });

  it('fails with exit 1 when the server at --url is unreachable', async () => {
    let stderr = '';
    const code = await runCli(['--url', 'http://127.0.0.1:9', 'list'], {
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toBe('error: server not reachable at http://127.0.0.1:9\n');
  });
});

describe('serve', () => {
  it('runs a server from MANGA_LIBRARY / MANGA_PORT until interrupted', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'manga-serve-'));
    const saved = { library: process.env['MANGA_LIBRARY'], port: process.env['MANGA_PORT'] };
    process.env['MANGA_LIBRARY'] = lib;
    process.env['MANGA_PORT'] = '0';
    try {
      const ac = new AbortController();
      let out = '';
      const done = runCli(['serve'], {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
        signal: ac.signal,
      });
      await vi.waitFor(() => expect(out).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/), { timeout: 10_000 });
      const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1] ?? '';
      expect(out).toContain(`(library: ${lib})`);
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
      expect(existsSync(join(lib, 'server.json'))).toBe(true);
      ac.abort();
      expect(await done).toBe(0);
      expect(existsSync(join(lib, 'server.json'))).toBe(false);
    } finally {
      if (saved.library === undefined) delete process.env['MANGA_LIBRARY'];
      else process.env['MANGA_LIBRARY'] = saved.library;
      if (saved.port === undefined) delete process.env['MANGA_PORT'];
      else process.env['MANGA_PORT'] = saved.port;
      rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
