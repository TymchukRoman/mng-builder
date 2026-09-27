import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { DEFAULT_REF_WEIGHT, generateImage, type GenerateRequest } from '../src/imaging/generate.js';
import { pngSize } from '../src/imaging/png-size.js';
import { GpuArbiter, PermanentError } from '../src/jobs/index.js';
import { NotFoundError } from '../src/store/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { seedCharacter, seedImage, seedManga } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let comfy: ComfyClient;
let gpu: GpuArbiter;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  comfy = new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 });
  gpu = new GpuArbiter();
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

const context = (): { labels: string[]; ctx: { signal: AbortSignal; progress: (label: string) => void } } => {
  const labels: string[] = [];
  return { labels, ctx: { signal: new AbortController().signal, progress: (label: string) => { labels.push(label); } } };
};
const request = (mangaId: string, over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  mangaId, owner: { type: 'panel', id: 'pn_generate01' }, role: null, recipe: 'anime', prompt: 'P', negative: 'N', width: 832, height: 1216, seed: 7,
  loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }], refImageIds: [], control: null, initImageId: null,
  denoise: null, upscale: null, ...over,
});

describe('generateImage', () => {
  it('writes the PNG, records full GenParams and holds the GPU for ComfyUI', async () => {
    const { manga, panels } = seedManga(lib.store);
    const owner = { type: 'panel' as const, id: panels[0]!.id };
    const { labels, ctx } = context();
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { owner }), ctx);
    expect(image).toMatchObject({ mangaId: manga.id, ownerType: 'panel', ownerId: owner.id, role: null, width: 832, height: 1216, source: 'generated', parentImageId: null, review: null });
    expect(image.path).toBe(lib.store.files.imageRel(manga.id, image.id));
    expect(pngSize(readFileSync(lib.store.files.abs(image.path)))).toEqual({ width: 832, height: 1216 });
    expect(image.gen).toMatchObject({
      recipe: 'anime', prompt: 'P', negative: 'N', seed: 7, steps: 28, cfg: 5.5, width: 832, height: 1216,
      loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }], refs: [], control: null, initImageId: null, denoise: null,
    });
    expect(image.gen?.comfyPromptId).toBe(fake.promptIds[0]);
    expect(lib.store.images.require(image.id)).toEqual(image);
    expect(gpu.current).toBe('comfy');
    expect(labels).toContain('Sampling');
    expect(nodesOf(fake.graphs[0]!, 'KSampler')[0]!.inputs['seed']).toBe(7);
  });

  it('uploads reference images and passes their ComfyUI names to the recipe, at the default IP-Adapter weight', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl');
    const owner = { type: 'character' as const, id: aiko.id };
    const portrait = seedImage(lib.store, manga.id, owner, 'portrait');
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { owner, recipe: 'anime-ref', refImageIds: [portrait.id] }), context().ctx);
    expect([...fake.uploads.keys()]).toEqual([`manga-builder/${portrait.id}.png`]);
    expect(nodesOf(fake.graphs[0]!, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${portrait.id}.png`]);
    expect(image.gen?.refs).toEqual([portrait.id]);
    expect(nodesOf(fake.graphs[0]!, 'IPAdapterAdvanced')[0]!.inputs['weight']).toBe(DEFAULT_REF_WEIGHT);
  });

  it('overrides the IP-Adapter weight with an explicit refWeight', async () => {
    const { manga, panels } = seedManga(lib.store);
    const owner = { type: 'panel' as const, id: panels[0]!.id };
    const ref = seedImage(lib.store, manga.id, owner, null);
    await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { owner, recipe: 'anime-ref', refImageIds: [ref.id], refWeight: 0.6 }), context().ctx);
    expect(nodesOf(fake.graphs[0]!, 'IPAdapterAdvanced')[0]!.inputs['weight']).toBe(0.6);
  });

  it('marks upscales as upscaled children of their source', async () => {
    const { manga, panels } = seedManga(lib.store);
    const owner = { type: 'panel' as const, id: panels[0]!.id };
    const source = seedImage(lib.store, manga.id, owner, null, [100, 80]);
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, {
      owner, recipe: 'upscale', prompt: '', negative: '', width: 200, height: 160, seed: 0, loras: [], initImageId: source.id, upscale: 2,
    }), context().ctx);
    expect(image).toMatchObject({ source: 'upscaled', parentImageId: source.id, width: 200, height: 160, ownerId: owner.id });
    expect(image.gen).toMatchObject({ recipe: 'upscale', initImageId: source.id, denoise: null });
  });

  it('drops style LoRAs for recipes that cannot take them', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko');
    const owner = { type: 'character' as const, id: aiko.id };
    const portrait = seedImage(lib.store, manga.id, owner, 'portrait');
    const image = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { owner, recipe: 'qwen-edit-ref', refImageIds: [portrait.id] }), context().ctx);
    expect(image.gen?.loras).toEqual([]);
    expect(nodesOf(fake.graphs[0]!, 'LoraLoader')).toHaveLength(0);
  });

  it.each<[string, Partial<GenerateRequest>, string]>([
    ['an unknown recipe', { recipe: 'nope' }, 'Unknown recipe "nope"'],
    ['too many references', { recipe: 'anime-ref', refImageIds: ['im_a', 'im_b', 'im_c'] }, 'at most 2 reference image(s)'],
    ['missing references', { recipe: 'anime-ref' }, 'needs at least one reference image'],
    ['a pose on a recipe without pose support', { control: { kind: 'pose', imageId: 'im_x', strength: 0.8 } }, 'does not take a pose image'],
    ['an init image on a recipe without img2img', { recipe: 'anima', initImageId: 'im_x' }, 'does not take an input image'],
  ])('refuses %s before touching ComfyUI', async (_name, over, message) => {
    const { manga } = seedManga(lib.store);
    const err = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, over), context().ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain(message);
    expect(fake.graphs).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('turns a recipe input error into a PermanentError', async () => {
    const { manga } = seedManga(lib.store);
    const err = await generateImage({ store: lib.store, comfy, gpu }, request(manga.id, { recipe: 'anime-pose' }), context().ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('anime-pose: anime-pose needs a pose image');
  });

  it('removes the file and inserts no row when the owner is deleted mid-generation', async () => {
    const { manga, panels } = seedManga(lib.store);
    const panelId = panels[0]!.id;
    let deleted = false;
    const progress = (label: string): void => {
      if (label === 'Sampling' && !deleted) {
        deleted = true;
        lib.store.panels.delete(panelId);
      }
    };
    const req = request(manga.id, { owner: { type: 'panel', id: panelId } });
    await expect(
      generateImage({ store: lib.store, comfy, gpu }, req, { signal: new AbortController().signal, progress }),
    ).rejects.toThrow(NotFoundError);
    expect(lib.store.images.listByOwner('panel', panelId)).toEqual([]);
    const dir = lib.store.files.abs(`mangas/${manga.id}/images`);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
