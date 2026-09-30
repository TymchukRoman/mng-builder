import { afterEach, describe, expect, it } from 'vitest';
import type { Chapter, Character, EpisodeRun, ImageGeneratePayload, Job, Manga, ServerEvent } from '@manga/shared';
import { startM4TestServer, type M4TestServer } from './helpers/m4-server.js';

// M4 final I1: deleting a chapter (or its manga) mid-run cancels every unfinished job of its runs first, and
// announces the runs the cascade removed.

let s: M4TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const allJobs = async (server: M4TestServer): Promise<Job[]> => (await server.api<Job[]>('GET', '/api/jobs?limit=500')).body;
const isPanelRender = (j: Job): boolean => j.kind === 'image.generate' && (j.payload as ImageGeneratePayload).target === 'panel';

/** An autopilot run on a 2-page chapter, stopped in the middle of its render step (a panel render is running). */
async function midRender(server: M4TestServer): Promise<{ manga: Manga; chapter: Chapter; run: EpisodeRun; events: ServerEvent[] }> {
  server.fake.completionDelayMs = 400; // every render takes a while, so the render step has queued panel jobs
  const manga = (await server.api<Manga>('POST', '/api/mangas', { title: 'Delete me' })).body;
  const aiko = (await server.api<Character>('POST', `/api/mangas/${manga.id}/characters`, { name: 'Aiko', appearanceTags: '1girl' })).body;
  const chapter = (await server.api<Chapter>('POST', `/api/mangas/${manga.id}/chapters`, { title: 'One' })).body;
  const run = (await server.api<EpisodeRun>('POST', `/api/chapters/${chapter.id}/episode`, {
    input: { prompt: 'Aiko finds a cat in the rain', characterIds: [aiko.id], pages: 2 }, mode: 'autopilot',
  })).body;
  await server.until(async () => {
    const jobs = server.deps.store.jobs.listByEpisodeRun(run.id);
    return jobs.some((j) => isPanelRender(j) && j.status === 'running') && jobs.some((j) => isPanelRender(j) && j.status === 'queued');
  }, 60_000);
  const events: ServerEvent[] = [];
  server.deps.bus.on((e) => events.push(e));
  return { manga, chapter, run, events };
}

/** Once nothing is queued or running any more, and stays so for a moment (a late failure would show up then). */
async function settled(server: M4TestServer): Promise<Job[]> {
  await server.until(async () => (await allJobs(server)).every((j) => j.status !== 'queued' && j.status !== 'running'), 30_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  return allJobs(server);
}

function expectAllStopped(jobs: Job[], unfinished: Set<string>): void {
  expect(jobs.filter((j) => j.status === 'failed').map((j) => [j.kind, j.error])).toEqual([]);
  expect(jobs.filter((j) => j.status === 'queued' || j.status === 'running')).toEqual([]);
  for (const id of unfinished) expect(jobs.find((j) => j.id === id)?.status).toBe('cancelled');
}

const runDeleted = (events: ServerEvent[], runId: string): ServerEvent[] =>
  events.filter((e) => e.type === 'entity' && e.entity === 'episodeRun' && e.id === runId && e.op === 'deleted');

describe('deleting a chapter or manga mid-run (M4 final I1)', { timeout: 120_000 }, () => {
  it('DELETE /api/chapters/:id cancels every unfinished job of the run and emits episodeRun deleted', async () => {
    s = await startM4TestServer();
    const { manga, chapter, run, events } = await midRender(s);
    const unfinished = new Set(s.deps.store.jobs.listByEpisodeRun(run.id).filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id));
    expect(unfinished.size).toBeGreaterThan(1); // the render step job plus panel renders

    expect((await s.api('DELETE', `/api/chapters/${chapter.id}`)).status).toBe(200);
    expect(s.deps.store.episodes.get(run.id)).toBeNull();

    expectAllStopped(await settled(s), unfinished);
    expect(runDeleted(events, run.id)).toEqual([{ type: 'entity', entity: 'episodeRun', id: run.id, op: 'deleted', mangaId: manga.id }]);
  });

  it('DELETE /api/mangas/:id does the same for the runs of every chapter', async () => {
    s = await startM4TestServer();
    const { manga, run, events } = await midRender(s);
    const unfinished = new Set(s.deps.store.jobs.listByEpisodeRun(run.id).filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id));

    expect((await s.api('DELETE', `/api/mangas/${manga.id}`)).status).toBe(200);

    expectAllStopped(await settled(s), unfinished);
    expect(runDeleted(events, run.id)).toHaveLength(1);
  });
});
