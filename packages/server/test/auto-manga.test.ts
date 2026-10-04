import { afterEach, describe, expect, it } from 'vitest';
import {
  MANGA_TITLE_FROM_PLAN, type ApiErrorBody, type AutoRun, type Chapter, type Character, type Image, type Manga, type Page, type PageDetail,
} from '@manga/shared';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const FINAL = new Set(['done', 'failed', 'cancelled']);
const BRIEF = 'Two friends on a harbour pier. Simplistic art style, short dialogue.';

async function settled(server: M4TestServer, runId: string): Promise<AutoRun> {
  return server.until(async () => {
    const r = (await server.api<AutoRun>('GET', `/api/auto-runs/${runId}`)).body;
    return FINAL.has(r.status) ? r : null;
  }, 90_000);
}

describe('auto-created manga (integration, fakes)', { timeout: 150_000 }, () => {
  it('plans a series and writes its poster and every chapter with its own image model', async () => {
    s = await startM4TestServer();
    const res = await s.api<AutoRun>('POST', '/api/auto-mangas', {
      input: { brief: BRIEF, chapters: 2, pagesPerChapter: 1, imageModel: 'flux2', chapterModels: [null, 'anima'] },
    });
    expect(res.status).toBe(200);
    const early = (await s.api<Manga>('GET', `/api/mangas/${res.body.mangaId}`)).body;
    expect(early.title === MANGA_TITLE_FROM_PLAN || early.title === 'Harbour Tales').toBe(true);

    const run = await settled(s, res.body.id);
    expect(run, run.error ?? '').toMatchObject({ status: 'done', stage: 'done' });
    expect(run.error).toBeNull();

    const manga = (await s.api<Manga>('GET', `/api/mangas/${run.mangaId}`)).body;
    expect(manga).toMatchObject({ title: 'Harbour Tales', imageModel: 'flux2' });
    expect(manga.synopsis).toContain(BRIEF);
    // The brief's "simplistic art style" became style tags of the whole manga.
    expect(manga.styleGuide.stylePrompt).toContain('simple background');

    const chapters = (await s.api<Chapter[]>('GET', `/api/mangas/${manga.id}/chapters`)).body;
    expect(chapters.map((c) => [c.title, c.imageModel, c.status])).toEqual([['Part 1', null, 'ready'], ['Part 2', 'anima', 'ready']]);
    expect(run.chapterIds).toEqual(chapters.map((c) => c.id));

    const characters = (await s.api<Character[]>('GET', `/api/mangas/${manga.id}/characters`)).body;
    expect(characters.map((c) => c.name).sort()).toEqual(['Aiko', 'Mika', 'Ren']);
    for (const c of characters) expect(c.refs.portrait, c.name).toBeDefined();

    // The manga poster: a cover with a picture and the manga's title.
    const poster = (await s.api<PageDetail>('GET', `/api/pages/${manga.coverPageId}`)).body;
    expect(poster.panels[0]!.activeImageId).not.toBeNull();
    expect(poster.frames.map((f) => [f.kind, f.text])).toEqual([['title', 'Harbour Tales']]);

    // Every chapter has a lettered poster of its own, drawn by its episode.
    for (const chapter of chapters) {
      const cover = (await s.api<PageDetail>('GET', `/api/pages/${chapter.coverPageId}`)).body;
      expect(cover.panels[0]!.activeImageId, chapter.title).not.toBeNull();
      expect(cover.frames.some((f) => f.kind === 'title')).toBe(true);
      const pages = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body;
      expect(pages).toHaveLength(1);
    }

    // Each chapter's panels were drawn by its own model: flux2 (klein-ref) for chapter 1, anima for chapter 2.
    const recipeOf = async (chapter: Chapter): Promise<string[]> => {
      const pages = (await s!.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body;
      const out: string[] = [];
      for (const p of pages) {
        for (const panel of (await s!.api<PageDetail>('GET', `/api/pages/${p.id}`)).body.panels) {
          out.push((await s!.api<Image[]>('GET', `/api/panels/${panel.id}/images`)).body.at(-1)!.gen!.recipe);
        }
      }
      return out;
    };
    expect(new Set(await recipeOf(chapters[0]!))).toEqual(new Set(['klein-ref']));
    expect(new Set(await recipeOf(chapters[1]!))).toEqual(new Set(['anima']));

    // Cancelling or resuming a finished run is a conflict.
    expect((await s.api<ApiErrorBody>('POST', `/api/auto-runs/${run.id}/cancel`)).status).toBe(409);
    expect((await s.api<ApiErrorBody>('POST', `/api/auto-runs/${run.id}/resume`)).status).toBe(409);
    expect((await s.api<AutoRun>('GET', `/api/mangas/${manga.id}/auto-run`)).body.id).toBe(run.id);
  });

  it('keeps a title the user typed and skips the poster when asked', async () => {
    s = await startM4TestServer();
    const res = await s.api<AutoRun>('POST', '/api/auto-mangas', { input: { brief: 'A cat.', title: 'Mine', chapters: 1, pagesPerChapter: 1, poster: false } });
    const run = await settled(s, res.body.id);
    expect(run.status, run.error ?? '').toBe('done');
    const manga = (await s.api<Manga>('GET', `/api/mangas/${run.mangaId}`)).body;
    expect(manga.title).toBe('Mine');
    expect(manga.coverPageId).toBeNull();
  });

  it('fails with the reason when the plan is unusable, and a resume runs it again', async () => {
    let calls = 0;
    s = await startM4TestServer({
      claude: { 'manga.plan': (req) => { calls += 1; return calls <= 1 ? { title: 'x' } : FAKE_RESPONSES['manga.plan']!(req); } },
    });
    const res = await s.api<AutoRun>('POST', '/api/auto-mangas', { input: { brief: 'A cat.', chapters: 1, pagesPerChapter: 1, poster: false } });
    const run = await settled(s, res.body.id);
    expect(run.status).toBe('failed');
    expect(run.stage).toBe('plan');
    expect(run.error).not.toBeNull();

    const again = await s.api<AutoRun>('POST', `/api/auto-runs/${run.id}/resume`);
    expect(again.body).toMatchObject({ status: 'running', error: null });
    const done = await settled(s, run.id);
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.chapterIds).toHaveLength(1);
  });

  it('cancels a running run', async () => {
    s = await startM4TestServer();
    s.fake.completionDelayMs = 200;
    const res = await s.api<AutoRun>('POST', '/api/auto-mangas', { input: { brief: 'A cat.', chapters: 2, pagesPerChapter: 1 } });
    await s.until(async () => (await s!.api<AutoRun>('GET', `/api/auto-runs/${res.body.id}`)).body.stage !== 'plan');
    const cancelled = await s.api<AutoRun>('POST', `/api/auto-runs/${res.body.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await s.api<AutoRun>('GET', `/api/auto-runs/${res.body.id}`)).body.status).toBe('cancelled');
  });

  it('refuses a bad request', async () => {
    s = await startM4TestServer();
    const body = (input: unknown) => s!.api<ApiErrorBody>('POST', '/api/auto-mangas', { input });
    expect((await body({ brief: '   ' })).status).toBe(400);
    expect((await body({ brief: 'x', chapters: 0 })).status).toBe(400);
    expect((await body({ brief: 'x', imageModel: 'nope' })).status).toBe(400);
    expect((await body({ brief: 'x', chapters: 1, chapterModels: ['flux2', 'anima'] })).status).toBe(400);
    expect((await body({ brief: 'x', stylePreset: 'nope' })).status).toBe(400);
    expect((await s.api<ApiErrorBody>('GET', '/api/auto-runs/ar_missing000')).status).toBe(404);
  });
});
