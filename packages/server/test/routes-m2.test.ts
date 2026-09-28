import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Image, JobRef, JobRefs, Panel, RecipeInfo } from '@manga/shared';
import { pngSize } from '../src/imaging/png-size.js';
import { startM2TestServer, type M2TestServer } from './helpers/m2-server.js';
import { giveRefs, seedCharacter, seedManga } from './helpers/seed.js';

let s: M2TestServer;
beforeEach(async () => { s = await startM2TestServer(); });
afterEach(async () => { await s.close(); });

describe('M2 routes', () => {
  it('GET /api/recipes lists the nine recipes', async () => {
    const res = await s.api<RecipeInfo[]>('GET', '/api/recipes');
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id).sort()).toEqual(['anima', 'anima-turbo', 'anime', 'anime-pose', 'anime-ref', 'anime-refine', 'klein-ref', 'qwen-edit-ref', 'upscale']);
    expect(res.body.find((r) => r.id === 'qwen-edit-ref')).toEqual({
      id: 'qwen-edit-ref', label: 'Qwen Image Edit 2511 (1-3 references)', maxRefs: 3, requiresRefs: true,
      supportsPose: false, supportsLineart: false, supportsLoras: false, supportsInit: false,
    });
  });

  it('portraits enqueue n generate jobs with consecutive seeds and leave the pick to the user', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko', '1girl');
    const res = await s.api<JobRefs>('POST', `/api/characters/${aiko.id}/portraits`, { n: 2 });
    expect(res.status).toBe(200);
    const jobs = await Promise.all(res.body.jobIds.map((id) => s.deps.queue.waitFor(id)));
    expect(jobs.map((j) => [j.kind, j.lane, j.status])).toEqual([['image.generate', 'gpu', 'succeeded'], ['image.generate', 'gpu', 'succeeded']]);
    expect(jobs.map((j) => (j.payload as { seed: number }).seed)).toEqual([1234, 1235]);
    expect(s.deps.store.images.listByOwner('character', aiko.id).map((i) => i.role)).toEqual(['portrait', 'portrait']);
    expect(s.deps.store.characters.require(aiko.id).refs.portrait).toBeUndefined();
    const invalid = await s.api<ApiErrorBody>('POST', `/api/characters/${aiko.id}/portraits`, { n: 9 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation');
  });

  it('sheet needs a picked portrait, then fills fullbody, side and back', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko', '1girl');
    const conflict = await s.api<ApiErrorBody>('POST', `/api/characters/${aiko.id}/sheet`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toEqual({ code: 'conflict', message: 'Aiko has no portrait yet: generate portraits and pick one first' });
    giveRefs(s.deps.store, aiko, ['portrait']);
    const ok = await s.api<JobRef>('POST', `/api/characters/${aiko.id}/sheet`);
    const job = await s.deps.queue.waitFor(ok.body.jobId);
    expect(job).toMatchObject({ kind: 'character.refs', lane: 'gpu', status: 'succeeded' });
    expect(Object.keys(s.deps.store.characters.require(aiko.id).refs).sort()).toEqual(['back', 'fullbody', 'portrait', 'side']);
  });

  it('panel generate validates the recipe and serves the new active image', async () => {
    const { panels } = seedManga(s.deps.store);
    const panelId = panels[0]!.id;
    const bad = await s.api<ApiErrorBody>('POST', `/api/panels/${panelId}/generate`, { recipe: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toContain('Unknown recipe "nope"');
    const ok = await s.api<JobRef>('POST', `/api/panels/${panelId}/generate`, { seed: 5 });
    const job = await s.deps.queue.waitFor(ok.body.jobId);
    expect(job).toMatchObject({ kind: 'image.generate', lane: 'gpu', status: 'succeeded', payload: { target: 'panel', panelId, seed: 5 } });
    const panel = (await s.api<Panel>('GET', `/api/panels/${panelId}`)).body;
    expect(panel.seed).toBe(5);
    const file = await fetch(`${s.url}/files/images/${panel.activeImageId}.png`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('image/png');
    expect(pngSize(new Uint8Array(await file.arrayBuffer())).width).toBeGreaterThan(0);
  });

  it('panel review needs an active image, then stores the verdict', async () => {
    const { panels } = seedManga(s.deps.store);
    const panelId = panels[0]!.id;
    const conflict = await s.api<ApiErrorBody>('POST', `/api/panels/${panelId}/review`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    await s.deps.queue.waitFor((await s.api<JobRef>('POST', `/api/panels/${panelId}/generate`, {})).body.jobId);
    const review = await s.api<JobRef>('POST', `/api/panels/${panelId}/review`);
    const job = await s.deps.queue.waitFor(review.body.jobId);
    expect(job).toMatchObject({ kind: 'image.review', lane: 'claude', status: 'succeeded' });
    const activeId = s.deps.store.panels.require(panelId).activeImageId!;
    expect((await s.api<Image>('GET', `/api/images/${activeId}`)).body.review).toMatchObject({ engine: 'claude', pass: true, issues: [] });
  });

  it('prompt and suggest-appearance run as llm.step in the lane of their engine', async () => {
    const { manga, panels } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko');
    const prompt = await s.api<JobRef>('POST', `/api/panels/${panels[0]!.id}/prompt`);
    const promptJob = await s.deps.queue.waitFor(prompt.body.jobId);
    expect(promptJob).toMatchObject({ kind: 'llm.step', lane: 'claude', status: 'succeeded', payload: { type: 'panel-prompt', panelId: panels[0]!.id } });
    expect(s.deps.store.panels.require(panels[0]!.id).prompt.scene).toBe('upper body, solo, standing, school rooftop, chain-link fence, sunset, wind'); // I2: camera tags from the script

    expect((await s.api('PATCH', '/api/settings', { engine: { mode: 'local' } })).status).toBe(200);
    const suggest = await s.api<JobRef>('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: 'silver twin-tails' });
    const suggestJob = await s.deps.queue.waitFor(suggest.body.jobId);
    expect(suggestJob).toMatchObject({ kind: 'llm.step', lane: 'gpu', status: 'succeeded' });
    expect(s.deps.store.characters.require(aiko.id).appearanceTags).toBe('1girl, silver hair, long hair, twintails, amber eyes, red scarf, school uniform, pleated skirt');
    expect(s.local.calls.map((c) => c.name)).toEqual(['appearance']);
    expect((await s.api('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: '' })).status).toBe(400);
  });

  it('bounds the appearance description at 4000 characters (M12)', async () => {
    const { manga } = seedManga(s.deps.store);
    const aiko = seedCharacter(s.deps.store, manga.id, 'Aiko');
    const long = await s.api<ApiErrorBody>('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: 'x'.repeat(4001) });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('validation');
    expect((await s.api('POST', `/api/characters/${aiko.id}/suggest-appearance`, { description: 'x'.repeat(4000) })).status).toBe(200);
  });

  it('answers 404 for unknown ids', async () => {
    const res = await s.api<ApiErrorBody>('POST', '/api/panels/pn_missing0001/generate', {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
