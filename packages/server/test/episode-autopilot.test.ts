import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Chapter, Character, EpisodeRun, ImageGeneratePayload, Job, Manga, Page, PageDetail } from '@manga/shared';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const FINAL = new Set(['done', 'failed', 'cancelled']);

async function finished(server: M4TestServer, chapterId: string): Promise<EpisodeRun> {
  const run = await server.until(async () => {
    const r = (await server.api<EpisodeRun | null>('GET', `/api/chapters/${chapterId}/episode`)).body;
    return r && FINAL.has(r.status) ? r : null;
  }, 100_000);
  expect(run.status, JSON.stringify(run.steps.find((st) => st.status === 'failed') ?? null)).toBe('done');
  return run;
}

const runJobs = async (server: M4TestServer, runId: string): Promise<Job[]> =>
  (await server.api<Job[]>('GET', '/api/jobs?limit=500')).body.filter((j) => j.episodeRunId === runId);

async function setup(server: M4TestServer, pages: number) {
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Дощ', language: 'uk' })).body;
  const aiko = (await server.api<Character>('POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko', appearanceTags: '1girl, short black hair' })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'Один' })).body;
  const run = (await server.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, {
    input: { prompt: 'Айко знаходить кота під дощем', characterIds: [aiko.id], pages }, mode: 'autopilot',
  })).body;
  return { manga, chapter, run };
}

describe('episode in autopilot (integration, fakes)', { timeout: 120_000 }, () => {
  it('turns one prompt into a lettered two-page chapter with a cover', async () => {
    s = await startM4TestServer();
    // Slow every render a little so Mika's four outline portraits are still queued when the render step starts (F13).
    s.fake.completionDelayMs = 40;
    const { manga, chapter, run } = await setup(s, 2);
    await finished(s, chapter.id);

    const ch = (await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body;
    expect(ch).toMatchObject({ status: 'ready', title: 'Кіт під дощем' });
    expect(ch.coverPageId).not.toBeNull();

    const pages = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body;
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const detail = (await s.api<PageDetail>('GET', `/api/pages/${page.id}`)).body;
      expect(detail.panels).toHaveLength(2);
      for (const panel of detail.panels) {
        expect(panel.activeImageId).not.toBeNull();
        expect(detail.images[panel.activeImageId!]!.width).toBeGreaterThan(0);
        expect(panel.prompt.scene).not.toBe('');
      }
      expect(detail.frames.length).toBeGreaterThan(0);
      expect(detail.frames.some((f) => f.text.startsWith('Привіт'))).toBe(true);
    }

    const cover = (await s.api<PageDetail>('GET', `/api/pages/${ch.coverPageId}`)).body;
    expect(cover.panels[0]!.activeImageId).not.toBeNull();
    expect(cover.frames.map((f) => [f.kind, f.text])).toEqual([['title', 'Кіт під дощем']]);

    const characters = (await s.api<Character[]>('GET', `/api/mangas/${manga.id}/characters`)).body;
    expect(characters.find((c) => c.name === 'Mika')?.refs.portrait).toBeDefined();

    const jobs = await runJobs(s, run.id);
    const count = (kind: Job['kind']) => jobs.filter((j) => j.kind === kind).length;
    expect(count('llm.step')).toBe(7);
    expect(count('image.generate')).toBe(4 + 5); // Mika's portraits + 4 story panels + the cover
    expect(count('image.review')).toBe(5);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);

    // F13: exactly the four outline portraits per new character, none extra; Aiko is on no panel, so she gets none.
    const mika = characters.find((c) => c.name === 'Mika')!;
    const aiko = characters.find((c) => c.name === 'Aiko')!;
    const generates = jobs.filter((j) => j.kind === 'image.generate');
    const portraitsOf = (id: string): Job[] =>
      generates.filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait' && (j.payload as { characterId?: string }).characterId === id);
    expect(portraitsOf(mika.id)).toHaveLength(4);
    expect(portraitsOf(aiko.id)).toHaveLength(0);
    // ... and the render step waited for them: no panel job started before the last portrait finished.
    const lastPortrait = portraitsOf(mika.id).map((j) => j.finishedAt!).sort().at(-1)!;
    const panelJobs = generates.filter((j) => (j.payload as ImageGeneratePayload).target === 'panel');
    expect(panelJobs).toHaveLength(5);
    for (const j of panelJobs) expect(j.startedAt! >= lastPortrait).toBe(true);
  });

  it('re-running scripts needs confirm, then replaces the pages and finishes again', async () => {
    s = await startM4TestServer();
    const { chapter, run } = await setup(s, 1);
    await finished(s, chapter.id);
    const before = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => p.id);

    const refused = await s.api<ApiErrorBody>('POST', `/api/episodes/${run.id}/steps/scripts/rerun`, {});
    expect([refused.status, refused.body.error.code]).toEqual([409, 'needs_confirm']);
    expect((await s.api('POST', `/api/episodes/${run.id}/steps/scripts/rerun`, { confirm: true })).status).toBe(200);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.status).toBe('generating');
    await finished(s, chapter.id);

    const after = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body.map((p) => p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.status).toBe('ready');

    // F12: the rerun keeps the character-portrait jobs, so Mika still has exactly her four portraits.
    const generates = (await runJobs(s, run.id)).filter((j) => j.kind === 'image.generate');
    expect(generates.filter((j) => (j.payload as ImageGeneratePayload).target === 'character-portrait')).toHaveLength(4);
  });

  it('runs a six-page Ukrainian manga: scripts in chunks, Ukrainian dialogue lettered on every page', async () => {
    s = await startM4TestServer();
    const { chapter } = await setup(s, 6);
    await finished(s, chapter.id);

    const scriptCalls = s.claude.calls.filter((c) => c.name === 'episode.scripts');
    expect(scriptCalls.length).toBe(2); // pages 1-4, then 5-6
    const pages = (await s.api<Page[]>('GET', `/api/chapters/${chapter.id}/pages`)).body;
    expect(pages).toHaveLength(6);
    const details = await Promise.all(pages.map(async (p) => (await s!.api<PageDetail>('GET', `/api/pages/${p.id}`)).body));
    details.forEach((detail, i) => {
      expect(detail.panels).toHaveLength(2);
      expect(detail.panels.every((p) => p.activeImageId !== null)).toBe(true);
      const texts = detail.frames.map((f) => f.text);
      expect(texts.some((x) => x.startsWith('Привіт'))).toBe(true);
      expect(texts.some((x) => /Hello|Autumn|Mika waves/.test(x))).toBe(false);
      if (i === 0) expect(texts).toContain('Осінь.');
    });
    // chunking keeps absolute page numbers: page 6's dialogue says (6.x)
    expect(details[5]!.frames.some((f) => f.text.includes('(6.'))).toBe(true);
    expect((await s.api<Chapter>('GET', `/api/chapters/${chapter.id}`)).body.status).toBe('ready');
  });
});
