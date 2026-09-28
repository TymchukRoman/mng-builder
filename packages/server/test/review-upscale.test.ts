import { readdirSync } from 'node:fs';
import { newId } from '@manga/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewImage } from '../src/handlers/review.js';
import { upscaleImage } from '../src/handlers/upscale.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { createImageWithId } from '../src/imaging/image-row.js';
import { loadPrompt } from '../src/prompts/load.js';
import { NotFoundError } from '../src/store/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { makeJpegHeader } from './helpers/png.js';
import { giveRefs, seedCharacter, seedImage, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let comfy: ComfyClient;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 });
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

function panelWithAiko() {
  const { manga, panels } = seedManga(lib.store);
  const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
  const panel = updatePanel(lib.store, panels[0]!.id, {
    action: 'Aiko waves', characters: [{ characterId: aiko.id, pose: 'waving', expression: 'smile', position: 'center' }],
  });
  const image = seedImage(lib.store, manga.id, { type: 'panel', id: panel.id }, null);
  return { manga, aiko, panel, image };
}

describe('image.review', () => {
  it('asks the review engine with the script, the image and the portraits, and stores the verdict', async () => {
    const services = handlerServices(lib.store, comfy, {
      claude: { review: () => ({ pass: false, issues: [{ kind: 'text', note: 'A speech bubble is drawn top left.' }] }) },
    });
    const { manga, aiko, panel, image } = panelWithAiko();
    const { ctx, events } = jobContext(lib.store, 'image.review', { imageId: image.id, panelId: panel.id });
    const result = await reviewImage(ctx, services, { imageId: image.id, panelId: panel.id });

    expect(result).toMatchObject({ engine: 'claude', pass: false, issues: [{ kind: 'text', note: 'A speech bubble is drawn top left.' }] });
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
    expect(lib.store.images.require(image.id).review).toEqual(result);
    const call = services.claude.calls[0]!;
    expect(call).toMatchObject({ name: 'review', task: 'review', system: loadPrompt('review') });
    expect(call.images).toEqual([lib.store.files.abs(image.path), lib.store.files.abs(lib.store.images.require(aiko.refs.portrait!).path)]);
    expect(call.prompt).toContain('- Action: Aiko waves');
    expect(call.prompt).toContain('- Picture 1: the generated image to check.');
    expect(call.prompt).toContain('- Picture 2: reference portrait of Aiko.');
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'updated', mangaId: manga.id });
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'image' && e.op === 'updated')).toHaveLength(1);
  });

  it('uses the local engine for a review queued in the gpu lane (I1)', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { tasks: { review: 'local' } } });
    const { panel, image } = panelWithAiko();
    const result = await reviewImage(jobContext(lib.store, 'image.review', {}, { lane: 'gpu' }).ctx, services, { imageId: image.id, panelId: panel.id });
    expect(result.engine).toBe('local');
    expect(services.local.calls).toHaveLength(1);
    expect(services.claude.calls).toHaveLength(0);
  });

  it('keeps a review that stays in the claude lane on Claude, even when the settings say local (I1)', async () => {
    const services = handlerServices(lib.store, comfy);
    lib.store.settings.patch({ engine: { mode: 'local', tasks: { review: 'local' } } });
    const { panel, image } = panelWithAiko();
    const result = await reviewImage(jobContext(lib.store, 'image.review', {}, { lane: 'claude' }).ctx, services, { imageId: image.id, panelId: panel.id });
    expect(result.engine).toBe('claude');
    expect(services.claude.calls).toHaveLength(1);
    expect(services.local.calls).toHaveLength(0);
  });

  it('reviews a character image without a panel and never compares it with itself', async () => {
    const services = handlerServices(lib.store, comfy);
    const { aiko } = panelWithAiko();
    const portraitId = aiko.refs.portrait!;
    await reviewImage(jobContext(lib.store, 'image.review', {}).ctx, services, { imageId: portraitId, panelId: null });
    const call = services.claude.calls[0]!;
    expect(call.prompt).toContain('No panel script: this is a character reference image of Aiko.');
    expect(call.images).toEqual([lib.store.files.abs(lib.store.images.require(portraitId).path)]);
  });

  it('fails without touching the image when the answer stays invalid', async () => {
    const services = handlerServices(lib.store, comfy, { claude: { review: () => ({ pass: 'maybe' }) } });
    const { panel, image } = panelWithAiko();
    const err = await reviewImage(jobContext(lib.store, 'image.review', {}).ctx, services, { imageId: image.id, panelId: panel.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect(lib.store.images.require(image.id).review).toBeNull();
  });

  it('rejects without crashing when the image is deleted while the engine is reviewing it', async () => {
    const { panel, image } = panelWithAiko();
    const services = handlerServices(lib.store, comfy, {
      // Scripted engines answer in-process (no real network round trip like ComfyUI's), so the delete happens
      // from the answer hook itself — the same "mid-flight owner deletion" shape as Tasks 15/17's progress hooks.
      claude: { review: () => { lib.store.images.delete(image.id); return { pass: true, issues: [] }; } },
    });
    const { ctx, events } = jobContext(lib.store, 'image.review', { imageId: image.id, panelId: panel.id });
    await expect(reviewImage(ctx, services, { imageId: image.id, panelId: panel.id })).rejects.toThrow(NotFoundError);
    expect(events.some((e) => e.type === 'entity' && e.entity === 'image' && e.op === 'updated')).toBe(false);
  });
});

describe('image.upscale', () => {
  it('stores a 4x-AnimeSharp upscale as an upscaled child with the same owner', async () => {
    const services = handlerServices(lib.store, comfy);
    const { manga, panels } = seedManga(lib.store);
    const source = seedImage(lib.store, manga.id, { type: 'panel', id: panels[0]!.id }, null, [100, 80]);
    const { ctx, events } = jobContext(lib.store, 'image.upscale', { imageId: source.id, factor: 4 });
    const result = await upscaleImage(ctx, services, { imageId: source.id, factor: 4 });
    const image = lib.store.images.require(result.imageId);
    expect(image).toMatchObject({ ownerType: 'panel', ownerId: panels[0]!.id, role: null, width: 400, height: 320, source: 'upscaled', parentImageId: source.id });
    expect(nodesOf(fake.graphs[0]!, 'ImageUpscaleWithModel')).toHaveLength(1);
    expect(nodesOf(fake.graphs[0]!, 'ImageScaleBy')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: image.id, op: 'created', mangaId: manga.id });
    expect(events.filter((e) => e.type === 'entity' && e.entity === 'image' && e.op === 'created')).toHaveLength(1);
  });

  it('upscales an uploaded JPEG (stored as .png) under the fakes (M8)', async () => {
    const services = handlerServices(lib.store, comfy);
    const { manga, panels } = seedManga(lib.store);
    const id = newId('im');
    const path = lib.store.files.writeImage(manga.id, id, makeJpegHeader(100, 80));
    const jpeg = createImageWithId(lib.store, id, {
      mangaId: manga.id, ownerType: 'panel', ownerId: panels[0]!.id, role: null, path, width: 100, height: 80,
      source: 'uploaded', parentImageId: null, gen: null, review: null,
    });
    const { ctx } = jobContext(lib.store, 'image.upscale', { imageId: jpeg.id, factor: 2 });
    const result = await upscaleImage(ctx, services, { imageId: jpeg.id, factor: 2 });
    expect(lib.store.images.require(result.imageId)).toMatchObject({ width: 200, height: 160, source: 'upscaled', parentImageId: jpeg.id });
  });

  it('rejects and leaves nothing behind when the owner is deleted mid-upscale', async () => {
    const services = handlerServices(lib.store, comfy);
    const { manga, panels } = seedManga(lib.store);
    const panelId = panels[0]!.id;
    const source = seedImage(lib.store, manga.id, { type: 'panel', id: panelId }, null, [100, 80]);
    const { ctx, events } = jobContext(lib.store, 'image.upscale', { imageId: source.id, factor: 4 });
    let deleted = false;
    const originalProgress = ctx.progress;
    ctx.progress = (label, value, max) => {
      if (label === 'Upscaling' && !deleted) {
        deleted = true;
        lib.store.panels.delete(panelId);
      }
      originalProgress(label, value, max);
    };

    await expect(upscaleImage(ctx, services, { imageId: source.id, factor: 4 })).rejects.toThrow(NotFoundError);

    expect(lib.store.images.listByOwner('panel', panelId)).toEqual([source]);
    const dir = lib.store.files.abs(`mangas/${manga.id}/images`);
    expect(readdirSync(dir).sort()).toEqual([`${source.id}.png`]);
    expect(events.some((e) => e.type === 'entity' && e.entity === 'image' && e.op === 'created')).toBe(false);
  });
});
