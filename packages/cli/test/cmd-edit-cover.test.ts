import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { STYLE_PRESETS, type Chapter, type Character, type Manga, type PageDetail } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { startHarness, type Harness } from './helpers.js';

// F4: thin CLI wrappers over the existing cover and PATCH routes.

let h: Harness;
let api: ApiClient;
let manga: Manga;
let other: Manga;
let aiko: Character;
let chapter: Chapter;
let patches: MockInstance<ApiClient['patch']>;

beforeAll(async () => {
  h = await startHarness();
  api = new ApiClient(h.url);
  manga = await api.post<Manga>('/api/mangas', { title: 'Edit Tales', synopsis: 'Old synopsis', readingDirection: 'ltr' });
  other = await api.post<Manga>('/api/mangas', { title: 'Other Tales' });
  aiko = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Aiko', personality: 'calm', seed: 1 });
  chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title: 'Opening', synopsis: 'Dawn' });
  await api.post<Chapter>(`/api/mangas/${other.id}/chapters`, { title: 'Elsewhere' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  patches = vi.spyOn(ApiClient.prototype, 'patch');
});
afterEach(() => {
  patches.mockRestore();
});

/** The body of the only PATCH the command sent. */
function sent(): unknown {
  expect(patches).toHaveBeenCalledTimes(1);
  return patches.mock.calls[0]?.[1];
}

describe('manga cover', () => {
  it('creates the manga cover once and prints its page and panel', async () => {
    const r = await h.run('cover', 'edit tales');
    const [, pageId = '', panelId = ''] = /^cover (pg_[a-z2-7]{10}) {2}panel (pn_[a-z2-7]{10})\n$/.exec(r.stdout) ?? [];
    expect(pageId).not.toBe('');
    expect((await api.get<Manga>(`/api/mangas/${manga.id}`)).coverPageId).toBe(pageId);
    expect((await h.run('cover', manga.id)).stdout).toBe(`cover ${pageId}  panel ${panelId}\n`);
  });

  it('creates a chapter cover, by number, id or <manga>/<number>, and refuses a chapter of another manga', async () => {
    const detail = await h.json<PageDetail>('cover', 'Edit Tales', '--chapter', '1');
    expect(detail.page).toMatchObject({ kind: 'cover', chapterId: chapter.id });
    expect((await h.json<PageDetail>('cover', 'Edit Tales', '--chapter', chapter.id)).page.id).toBe(detail.page.id);
    expect((await h.json<PageDetail>('cover', 'Edit Tales', '--chapter', 'Edit Tales/1')).page.id).toBe(detail.page.id);
    const foreign = await h.run('cover', 'Edit Tales', '--chapter', 'Other Tales/1');
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toMatch(/belongs to another manga/);
  });
});

describe('manga edit', () => {
  it('sends only the options given', async () => {
    const r = await h.run('edit', 'Edit Tales', '--title', 'Edit Tales II');
    expect(r.stdout).toBe(`updated ${manga.id}  Edit Tales II  (en, bw, ltr)\n`);
    expect(sent()).toEqual({ title: 'Edit Tales II' });
    expect((await api.get<Manga>(`/api/mangas/${manga.id}`)).synopsis).toBe('Old synopsis');
  });

  it('maps --lang, --color, --dir and --synopsis to the Manga fields', async () => {
    const updated = await h.json<Manga>('edit', manga.id, '--lang', 'uk', '--color', 'color', '--dir', 'rtl', '--synopsis', 'New');
    expect(sent()).toEqual({ language: 'uk', colorMode: 'color', readingDirection: 'rtl', synopsis: 'New' });
    expect(updated).toMatchObject({ language: 'uk', colorMode: 'color', readingDirection: 'rtl', synopsis: 'New' });
  });

  it("--style sends the preset's style guide and warns when the colour mode does not match", async () => {
    const r = await h.run('edit', manga.id, '--style', 'manga-hatching');
    expect(sent()).toEqual({ styleGuide: STYLE_PRESETS['manga-hatching']?.styleGuide });
    expect(r.stderr).toBe('warning: style manga-hatching is a bw preset but the manga is color\n');
  });

  it('is a usage error without options or with an unknown style', async () => {
    expect((await h.run('edit', manga.id)).code).toBe(2);
    expect((await h.run('edit', manga.id, '--style', 'nope')).code).toBe(2);
    expect(patches).not.toHaveBeenCalled();
  });
});

describe('manga character edit', () => {
  it('sends only the options given, with "-" clearing the recipe', async () => {
    const r = await h.run('character', 'edit', 'Aiko', '--manga', manga.id, '--role', 'main', '--seed', '7');
    expect(r.stdout).toBe(`updated ${aiko.id}  Aiko  (main, seed 7)\n`);
    expect(sent()).toEqual({ role: 'main', seed: 7 });
    expect((await api.get<Character>(`/api/characters/${aiko.id}`)).personality).toBe('calm');
    patches.mockClear();
    await h.run('character', 'edit', aiko.id, '--name', 'Aiko S.', '--personality', 'bold', '--speech', 'curt', '--appearance', '1girl', '--recipe', 'anime');
    expect(sent()).toEqual({ name: 'Aiko S.', personality: 'bold', speechStyle: 'curt', appearanceTags: '1girl', recipe: 'anime' });
    patches.mockClear();
    expect((await h.json<Character>('character', 'edit', aiko.id, '--recipe', '-')).recipe).toBeNull();
    expect(sent()).toEqual({ recipe: null });
  });

  it('is a usage error without options', async () => {
    expect((await h.run('character', 'edit', aiko.id)).code).toBe(2);
    expect((await h.run('character', 'edit', aiko.id, '--seed', '-3')).code).toBe(2);
  });
});

describe('manga chapter edit', () => {
  it('sends only the options given', async () => {
    const r = await h.run('chapter', 'edit', chapter.id, '--title', 'Prologue');
    expect(r.stdout).toBe(`updated ${chapter.id}  #1  Prologue\n`);
    expect(sent()).toEqual({ title: 'Prologue' });
    expect((await api.get<Chapter>(`/api/chapters/${chapter.id}`)).synopsis).toBe('Dawn');
    patches.mockClear();
    expect((await h.json<Chapter>('chapter', 'edit', `${manga.id}/1`, '--number', '4', '--synopsis', 'Night')).number).toBe(4);
    expect(sent()).toEqual({ synopsis: 'Night', number: 4 });
  });

  it('is a usage error without options or with a bad number', async () => {
    expect((await h.run('chapter', 'edit', chapter.id)).code).toBe(2);
    expect((await h.run('chapter', 'edit', chapter.id, '--number', '0')).code).toBe(2);
  });
});
