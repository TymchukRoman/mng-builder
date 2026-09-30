import { existsSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTI_FEMALE_NEGATIVE, assemblePrompt, type ImageGeneratePayload } from '@manga/shared';
import { generatePanelImage } from '../src/handlers/panel-image.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { RECIPES } from '../src/imaging/recipes/index.js';
import { panelSize } from '../src/imaging/size.js';
import { PermanentError } from '../src/jobs/index.js';
import { NotFoundError } from '../src/store/index.js';
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
  it('assembles the prompt from style, B&W tokens, the cast\'s people count, the character tags and the scene', async () => {
    const { manga, page, panels } = seedManga(lib.store, { layout: '2-rows' });
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair, twintails');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: 'rooftop, sunset', negative: 'blurry background' } });
    const { ctx, events } = jobContext(lib.store, 'image.generate', {});
    const result = await generatePanelImage(ctx, services, { target: 'panel', panelId: panel.id });

    expect(lib.store.panels.require(panel.id).activeImageId).toBe(result.imageId);
    const graph = fake.graphs[0]!;
    const expected = assemblePrompt({ styleGuide: manga.styleGuide, colorMode: 'bw', characterTags: ['1girl, solo', 'silver hair, twintails'], scene: 'rooftop, sunset', extraNegative: 'blurry background' });
    expect(nodesOf(graph, 'CLIPTextEncode').map((n) => n.inputs['text'])).toEqual([expected.prompt, expected.negative]);
    expect(expected.prompt).toContain('1girl, solo, silver hair, twintails, rooftop, sunset');
    expect(nodesOf(graph, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
    const [width, height] = panelSize(page, manga.pageFormat, panel.id, RECIPES['anime']!);
    expect(width).toBeGreaterThan(height);
    expect(nodesOf(graph, 'EmptyLatentImage')[0]!.inputs).toMatchObject({ width, height });
    expect(events).toContainEqual({ type: 'entity', entity: 'image', id: result.imageId, op: 'created', mangaId: manga.id });
    expect(events).toContainEqual({ type: 'entity', entity: 'panel', id: panel.id, op: 'updated', mangaId: manga.id });
  });

  describe('male subjects (Roman: men rendered as women)', () => {
    const texts = (i = 0) => nodesOf(fake.graphs[i]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    const loraStrengths = (i = 0) => nodesOf(fake.graphs[i]!, 'LoraLoader').map((n) => [n.inputs['lora_name'], n.inputs['strength_model']]);
    const ROGUE_SCENE = 'upper body, 2girls, from side, crouching on a branch, forest, night';

    it("replaces the LLM's 2girls on the Rogue Ninja panel with one male count set and the anti-female negative", async () => {
      const { manga, panels } = seedManga(lib.store, { preset: 'manga-hatching' });
      const rogue = seedCharacter(lib.store, manga.id, 'Rogue Ninja', '1boy, long dark hair, ninja headband, dark cloak');
      const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(rogue.id)] }, { prompt: { scene: ROGUE_SCENE, negative: '' } });
      await run(panel.id);
      const [positive, negative] = texts();
      expect(positive).toContain('lineart, 1boy, solo, male focus, long dark hair, ninja headband, dark cloak, upper body, from side, crouching on a branch');
      expect(positive).not.toContain('2girls');
      expect(positive!.match(/\b(?:1boy|solo|male focus)\b/g)).toEqual(['1boy', 'solo', 'male focus']);
      expect(negative!.endsWith(`, ${ANTI_FEMALE_NEGATIVE}`)).toBe(true);
      expect(loraStrengths()).toEqual([['Ashpwright_style_mix-000033.safetensors', 0.8]]);
    });

    it("runs the 'manga' Mnga LoRA at 0.4 with a man in the panel and at 0.8 without one", async () => {
      const { manga, panels } = seedManga(lib.store);
      const deb = seedCharacter(lib.store, manga.id, 'Debil', '1other, fat man, long hair, wavy hair, aristocratic clothes');
      const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
      const male = updatePanel(lib.store, panels[0]!.id, { characters: [stage(deb.id)] }, { prompt: { scene: 'ballroom', negative: '' } });
      const female = updatePanel(lib.store, panels[1]!.id, { characters: [stage(aiko.id)] }, { prompt: { scene: 'ballroom', negative: '' } });
      await run(male.id);
      await run(female.id);
      expect(loraStrengths(0)).toEqual([['Mnga-illustriousXL_v01_V1-CAME.safetensors', 0.4]]);
      expect(texts(0)[0]).toContain('1boy, solo, male focus, fat man, long hair');
      expect(loraStrengths(1)).toEqual([['Mnga-illustriousXL_v01_V1-CAME.safetensors', 0.8]]);
      expect(texts(1)[1]).not.toContain(ANTI_FEMALE_NEGATIVE);
      expect(lib.store.images.get(lib.store.panels.require(male.id).activeImageId!)!.gen!.loras).toEqual([{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.4 }]);
    });

    it('a mixed panel counts 1boy, 1girl, uses the male LoRA strength and no anti-female negative', async () => {
      const { manga, panels } = seedManga(lib.store);
      const ren = seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair');
      const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
      const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(ren.id), stage(aiko.id)] }, { prompt: { scene: '2girls, solo, park', negative: '' } });
      await run(panel.id);
      const [positive, negative] = texts();
      expect(positive).toContain('lineart, 1boy, 1girl, black hair, silver hair, park');
      expect(positive).not.toMatch(/2girls|solo|male focus/);
      expect(negative).not.toContain(ANTI_FEMALE_NEGATIVE);
      expect(loraStrengths()).toEqual([['Mnga-illustriousXL_v01_V1-CAME.safetensors', 0.4]]);
    });

    it("opens a natural scene with the count sentence and leaves klein's unused negative alone; the refine pass gets both", async () => {
      lib.store.settings.patch({ routing: { bwRefine: 'anime-refine' } });
      const { manga, panels } = seedManga(lib.store);
      const naruto = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Naruto', '1boy, spiky blond hair'), ['portrait']);
      const sasuke = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Sasuke', '1boy, black hair'), ['portrait']);
      const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(naruto.id, 'left'), stage(sasuke.id, 'right')] }, {
        refCharacterIds: [naruto.id, sasuke.id], prompt: { scene: 'Medium shot at eye level. Two girls. The boy from picture 1 glares at the boy from picture 2.', negative: '' },
      });
      await run(panel.id);
      const klein = lib.store.images.listByOwner('panel', panel.id).find((i) => i.gen?.recipe === 'klein-ref')!;
      expect(klein.gen!.prompt).toContain('spiky blond hair, black hair, Exactly two men. Medium shot at eye level. The boy from picture 1 glares');
      expect(klein.gen!.prompt).not.toContain('Two girls');
      expect(klein.gen!.negative).not.toContain(ANTI_FEMALE_NEGATIVE);
      const [refinePositive, refineNegative] = texts(1);
      expect(refinePositive).toContain('lineart, 2boys, male focus, spiky blond hair, black hair');
      expect(refineNegative).toContain(ANTI_FEMALE_NEGATIVE);
      expect(loraStrengths(1)).toEqual([['Mnga-illustriousXL_v01_V1-CAME.safetensors', 0.4]]);
    });
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
    // F6: the manga's style guide is SDXL (family 'sdxl'); its LoRA must not cross onto the forced anima
    // recipe (family 'anima'). The manga's only LoRA is that style LoRA, so no LoRA node at all should appear.
    expect(nodesOf(graph, 'LoraLoaderModelOnly')).toHaveLength(0);
    expect(nodesOf(graph, 'LoraLoader')).toHaveLength(0);
  });

  it('adds sceneSuffix and negativeExtra for review retries', async () => {
    const { panels } = seedManga(lib.store);
    await run(panels[0]!.id, { sceneSuffix: 'exactly two people', negativeExtra: 'letters, writing' });
    const [positive, negative] = nodesOf(fake.graphs[0]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    expect(positive).toContain('exactly two people');
    expect(negative).toContain('letters, writing');
  });

  it('drops "no humans" (any spelling) when a person shares the panel, on the tags path (M4 final S4)', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, short black hair');
    const kitten = seedCharacter(lib.store, manga.id, 'Kitten', 'No_Humans, kitten, grey tabby');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id), stage(kitten.id)] }, {
      prompt: { scene: 'solo, no  humans, crouching, vending machine', negative: '' },
    });
    await run(panel.id);
    const [positive] = nodesOf(fake.graphs[0]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    expect(positive).toContain('1girl, solo, short black hair, kitten, grey tabby, crouching, vending machine');
    expect(positive!.toLowerCase().replace(/_/g, ' ')).not.toMatch(/no\s+humans/);
  });

  it('keeps "no humans" for a panel whose cast has no person (M4 final S4)', async () => {
    const { manga, panels } = seedManga(lib.store);
    const kitten = seedCharacter(lib.store, manga.id, 'Kitten', 'no humans, kitten');
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(kitten.id)] }, { prompt: { scene: 'no humans, box, rain', negative: '' } });
    await run(panel.id);
    const [positive] = nodesOf(fake.graphs[0]!, 'CLIPTextEncode').map((n) => String(n.inputs['text']));
    expect(positive).toContain('no humans, kitten, no humans, box, rain');
  });

  it('drops "no humans" on the natural path (klein-ref, the multiChar default) too (M4 final S4)', async () => {
    const { manga, panels } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const kitten = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Kitten', 'no humans, kitten'), ['portrait']);
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: [stage(aiko.id, 'left'), stage(kitten.id, 'right')] }, {
      refCharacterIds: [aiko.id, kitten.id], prompt: { scene: 'The girl from picture 1 holds the kitten from picture 2 under an umbrella.', negative: '' },
    });
    await run(panel.id);
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'ReferenceLatent')).not.toHaveLength(0); // the natural-language klein recipe
    const text = JSON.stringify(graph);
    expect(text).toContain('holds the kitten from picture 2');
    expect(text.toLowerCase()).not.toContain('no humans');
  });

  it('routes two referenced characters through klein-ref, then refines B&W with anime-refine', async () => {
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
    const [klein, refine] = fake.graphs;
    expect(nodesOf(klein!, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${aiko.refs.portrait}.png`, `manga-builder/${ren.refs.portrait}.png`]);

    const images = lib.store.images.listByOwner('panel', panel.id);
    const first = images.find((i) => i.gen?.recipe === 'klein-ref')!;
    const second = images.find((i) => i.gen?.recipe === 'anime-refine')!;
    expect(result.imageId).toBe(second.id);
    expect(second.gen).toMatchObject({ initImageId: first.id, denoise: 0.3 });
    expect(nodesOf(refine!, 'KSampler')[0]!.inputs['denoise']).toBe(0.3);
    expect(nodesOf(refine!, 'LoadImage')[0]!.inputs['image']).toBe(`manga-builder/${first.id}.png`);
    expect(lib.store.panels.require(panel.id).activeImageId).toBe(second.id);
    // F6: anime-refine is the same family (sdxl) as the manga's style recipe ('anime'), so it does carry the
    // style LoRA (unlike the klein-ref pass above, which drops it both by family mismatch and supportsLoras).
    expect(nodesOf(refine!, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
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
    expect(images[0]!.gen?.recipe).toBe('klein-ref');
    expect(images.some((i) => i.gen?.recipe === 'anime-refine')).toBe(false);
    expect(result.imageId).toBe(images[0]!.id);
    expect(lib.store.panels.require(panel.id).activeImageId).toBe(images[0]!.id);
  });

  it('passes a multi-character panel refs to klein-ref in cast order, one image each, within its 4-ref cap', async () => {
    const { manga, panels } = seedManga(lib.store);
    const cast = ['Aiko', 'Ren', 'Mika', 'Sora'].map((name) => giveRefs(lib.store, seedCharacter(lib.store, manga.id, name, '1girl'), ['portrait', 'fullbody']));
    const panel = updatePanel(lib.store, panels[0]!.id, { characters: cast.map((c) => stage(c.id)) }, { refCharacterIds: cast.map((c) => c.id) });
    await run(panel.id);
    const graph = fake.graphs[0]!;
    expect(RECIPES['klein-ref']!.maxRefs).toBeGreaterThanOrEqual(RECIPES['qwen-edit-ref']!.maxRefs);
    expect(nodesOf(graph, 'ReferenceLatent')).toHaveLength(2 * 4); // positive + negative conditioning per ref
    expect(nodesOf(graph, 'LoadImage').map((n) => n.inputs['image'])).toEqual(cast.map((c) => `manga-builder/${c.refs.portrait}.png`));
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
    expect(String(nodesOf(graph, 'CLIPTextEncode')[0]!.inputs['text'])).toContain('1boy, solo, male focus, black hair');
    // F6: plain SDXL routing (no refs → the style's own recipe, 'anime') keeps the style LoRA, since the
    // families match.
    expect(nodesOf(graph, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
  });

  it('fails clearly when a forced recipe needs references the panel does not have', async () => {
    const { panels } = seedManga(lib.store);
    const err = await run(panels[0]!.id, { recipe: 'anime-ref' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain('needs at least one reference image');
  });

  it('rejects and leaves nothing behind when the panel is deleted mid-generation', async () => {
    const { manga, panels } = seedManga(lib.store);
    const panelId = panels[0]!.id;
    const { ctx, events } = jobContext(lib.store, 'image.generate', {});
    let deleted = false;
    const originalProgress = ctx.progress;
    ctx.progress = (label, value, max) => {
      if (label === 'Sampling' && !deleted) {
        deleted = true;
        lib.store.panels.delete(panelId);
      }
      originalProgress(label, value, max);
    };

    await expect(generatePanelImage(ctx, services, { target: 'panel', panelId })).rejects.toThrow(NotFoundError);

    expect(events.some((e) => e.type === 'entity' && e.entity === 'panel' && e.op === 'updated')).toBe(false);
    expect(lib.store.images.listByOwner('panel', panelId)).toEqual([]);
    const dir = lib.store.files.abs(`mangas/${manga.id}/images`);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
