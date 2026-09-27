import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemblePrompt, type ImageGeneratePayload } from '@manga/shared';
import { generatePanelImage } from '../src/handlers/panel-image.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf, type Link } from '../src/imaging/comfy-graph.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { panelSize } from '../src/imaging/size.js';
import { PermanentError } from '../src/jobs/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices, type TestServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga, updatePanel } from './helpers/seed.js';

let lib: TestLibrary;
let fake: FakeComfy;
let services: TestServices;
beforeEach(async () => {
  lib = openTestLibrary();
  fake = await startFakeComfy();
  services = handlerServices(lib.store, new ComfyClient({ url: fake.url, launcher: null, pollMs: 10 }));
});
afterEach(async () => {
  await fake.close();
  lib.close();
});

type PanelPayload = Extract<ImageGeneratePayload, { target: 'panel' }>;
const stage = (characterId: string, position: 'left' | 'center' | 'right' = 'center') => ({ characterId, pose: 'standing', expression: 'calm', position });
const run = (panelId: string, extra: Omit<PanelPayload, 'target' | 'panelId'> = {}) =>
  generatePanelImage(jobContext(lib.store, 'image.generate', {}).ctx, services, { target: 'panel', panelId, ...extra });

describe('image.generate (panel)', () => {
  it('assembles the prompt from style, B&W tokens, verbatim character tags and the scene', async () => {
    const { manga, page, panels } = seedManga(lib.store, { layout: '2-rows' });
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair, twintails');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: 'rooftop, sunset', negative: 'blurry background' } });
    const { ctx, events } = jobContext(lib.store, 'image.generate', {});
    const result = await generatePanelImage(ctx, services, { target: 'panel', panelId: panel.id });

    expect(lib.store.panels.require(panel.id).activeImageId).toBe(result.imageId);
    const graph = fake.graphs[0]!;
    const expected = assemblePrompt({ styleGuide: manga.styleGuide, colorMode: 'bw', characterTags: ['1girl, silver hair, twintails'], scene: 'rooftop, sunset', extraNegative: 'blurry background' });
    expect(nodesOf(graph, 'CLIPTextEncode').map((n) => n.inputs['text'])).toEqual([expected.prompt, expected.negative]);
    expect(expected.prompt).toContain('1girl, silver hair, twintails');
    expect(nodesOf(graph, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
    const [width, height] = panelSize(page, manga.pageFormat, panel.id, RECIPES['anime']!);
    expect(width).toBeGreaterThan(height);
    expect(nodesOf(graph, 'EmptyLatentImage')[0]!.inputs).toMatchObject({ width, height });
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: result.imageId, op: 'created', mangaId: manga.id });
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: panel.id, op: 'updated', mangaId: manga.id });
  });

  it('writes a fresh seed back when unlocked and keeps a locked one', async () => {
    const { panels } = seedManga(lib.store);
    const unlocked = await run(panels[0]!.id);
    const after = lib.store.panels.require(panels[0]!.id);
    expect(nodesOf(fake.graphs[0]!, 'KSampler')[0]!.inputs['seed']).toBe(after.seed);
    expect(lib.store.images.require(unlocked.imageId).gen?.seed).toBe(after.seed);
    lib.store.panels.update(panels[1]!.id, { seedLock: true, seed: 4242 });
    await run(panels[1]!.id);
    expect(nodesOf(fake.graphs[1]!, 'KSampler')[0]!.inputs['seed']).toBe(4242);
    expect(lib.store.panels.require(panels[1]!.id).seed).toBe(4242);
  });

  it('lets the payload override recipe and seed', async () => {
    const { panels } = seedManga(lib.store);
    await run(panels[0]!.id, { recipe: 'anima', seed: 99 });
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'UNETLoader')[0]!.inputs['unet_name']).toBe('anima-aesthetic-v1.1.safetensors');
    expect(nodesOf(graph, 'KSampler')[0]!.inputs['seed']).toBe(99);
    expect(lib.store.panels.require(panels[0]!.id).seed).toBe(99);
  });

  it('adds sceneSuffix and negativeExtra for review retries', async () => {
    const { panels } = seedManga(lib.store);
    await run(panels[0]!.id, { sceneSuffix: 'exactly two people', negativeExtra: 'letters, writing' });
    const [positive, negative] = nodesOf(fake.graphs[0]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    expect(positive).toContain('exactly two people');
    expect(negative).toContain('letters, writing');
  });

  it('routes two referenced characters through qwen-edit-ref, then refines B&W with anime-refine', async () => {
    // F1b: DEFAULT_SETTINGS.routing.bwRefine is null now, so the refine pass must be turned on explicitly.
    lib.store.settings.patch({ routing: { bwRefine: 'anime-refine' } });
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const ren = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(ren.id, 'right')] }, {
      refCharacterIds: [aiko.id, ren.id], prompt: { scene: 'the character from picture 1 argues with the character from picture 2', negative: '' },
    });
    const result = await run(panel.id);

    expect(fake.graphs).toHaveLength(2);
    const [qwen, refine] = fake.graphs;
    const encode = nodesOf(qwen!, 'TextEncodeQwenImageEditPlus')[0]!;
    // F4: the first reference now goes through FluxKontextImageScale before the encoder, so follow one more hop.
    const loadName = (link: unknown): unknown => {
      const node = qwen![(link as Link)[0]]!;
      return node.class_type === 'FluxKontextImageScale' ? loadName(node.inputs['image']) : node.inputs['image'];
    };
    expect(loadName(encode.inputs['image1'])).toBe(`manga-builder/${aiko.refs.portrait}.png`);
    expect(loadName(encode.inputs['image2'])).toBe(`manga-builder/${ren.refs.portrait}.png`);

    const images = lib.store.images.listByOwner('panel', panel.id);
    const first = images.find((i) => i.gen?.recipe === 'qwen-edit-ref')!;
    const second = images.find((i) => i.gen?.recipe === 'anime-refine')!;
    expect(result.imageId).toBe(second.id);
    expect(second.gen).toMatchObject({ initImageId: first.id, denoise: 0.3 });
    expect(nodesOf(refine!, 'KSampler')[0]!.inputs['denoise']).toBe(0.3);
    expect(nodesOf(refine!, 'LoadImage')[0]!.inputs['image']).toBe(`manga-builder/${first.id}.png`);
    expect(lib.store.panels.require(panel.id).activeImageId).toBe(second.id);
  });

  it('runs exactly one graph under default settings (bwRefine is off)', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const ren = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(ren.id, 'right')] }, {
      refCharacterIds: [aiko.id, ren.id],
    });
    const result = await run(panel.id);

    expect(fake.graphs).toHaveLength(1);
    const images = lib.store.images.listByOwner('panel', panel.id);
    expect(images).toHaveLength(1);
    expect(images[0]!.gen?.recipe).toBe('qwen-edit-ref');
    expect(images.some((i) => i.gen?.recipe === 'anime-refine')).toBe(false);
    expect(result.imageId).toBe(images[0]!.id);
    expect(lib.store.panels.require(panel.id).activeImageId).toBe(images[0]!.id);
  });

  it('uses the portrait and full body of a single referenced character with anime-ref', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait', 'fullbody']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { refCharacterIds: [aiko.id] });
    await run(panel.id);
    expect(fake.graphs).toHaveLength(1);
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(1);
    expect(nodesOf(graph, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${aiko.refs.portrait}.png`, `manga-builder/${aiko.refs.fullbody}.png`]);
  });

  it('ignores deleted characters and characters without refs', async () => {
    const { manga, panels } = seedManga(lib.store);
    const ren = seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage('cr_deleted0001', 'left'), stage(ren.id, 'right')] }, {
      refCharacterIds: ['cr_deleted0001', ren.id],
    });
    const result = await run(panel.id);
    expect(result.imageId).toMatch(/^im_/);
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(0);
    expect(nodesOf(graph, 'CheckpointLoaderSimple')).toHaveLength(1);
    expect(String(nodesOf(graph, 'CLIPTextEncode')[0]!.inputs['text'])).toContain('1boy, black hair');
  });

  it('fails clearly when a forced recipe needs references the panel does not have', async () => {
    const { panels } = seedManga(lib.store);
    const err = await run(panels[0]!.id, { recipe: 'anime-ref' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain('needs at least one reference image');
  });
});
