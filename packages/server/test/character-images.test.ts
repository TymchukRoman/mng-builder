import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCharacterRefs, generatePortrait, generateSlot } from '../src/handlers/character-images.js';
import { ComfyClient } from '../src/imaging/comfy.js';
import { nodesOf, type Link } from '../src/imaging/comfy-graph.js';
import { PermanentError } from '../src/jobs/index.js';
import { NotFoundError } from '../src/store/index.js';
import { startFakeComfy, type FakeComfy } from './fakes/fake-comfy.js';
import { handlerServices, type TestServices } from './helpers/handler-services.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';
import { giveRefs, seedCharacter, seedManga } from './helpers/seed.js';

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

const ctx = () => jobContext(lib.store, 'image.generate', {}).ctx;

describe('character images', () => {
  it('generates an unpicked bust portrait from the appearance tags and seed', async () => {
    const { manga } = seedManga(lib.store);
    const created = seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair');
    const aiko = lib.store.characters.update(created.id, { recipe: 'anime-ref' });
    const first = await generatePortrait(ctx(), services, { characterId: aiko.id });
    const image = lib.store.images.require(first.imageId);
    expect(image).toMatchObject({ ownerType: 'character', ownerId: aiko.id, role: 'portrait', width: 832, height: 1216 });
    expect(image.gen).toMatchObject({ recipe: 'anime', seed: 1234 });
    expect(image.gen?.prompt).toContain('1girl, silver hair');
    expect(image.gen?.prompt).toContain('upper body');
    expect(image.gen?.negative).toContain('multiple views');
    expect(lib.store.characters.require(aiko.id).refs).toEqual({});
    const second = await generatePortrait(ctx(), services, { characterId: aiko.id, seed: 77 });
    expect(lib.store.images.require(second.imageId).gen?.seed).toBe(77);
  });

  it("prefers the character's own recipe over the manga's style recipe when it can draw from tags alone", async () => {
    // F6 (clarified 2026-09-28): spec §6.4 "anime unless the character has a prompt-only recipe set" — the
    // manga's style recipe here is 'anime' (SDXL), but the character overrides it with 'anima'.
    const { manga } = seedManga(lib.store);
    const created = seedCharacter(lib.store, manga.id, 'Ren', '1boy, black hair');
    const ren = lib.store.characters.update(created.id, { recipe: 'anima' });
    const result = await generatePortrait(ctx(), services, { characterId: ren.id });
    expect(lib.store.images.require(result.imageId).gen?.recipe).toBe('anima');
    // The manga's SDXL style LoRA must not cross onto the 'anima'-family portrait.
    expect(nodesOf(fake.graphs[0]!, 'LoraLoader')).toHaveLength(0);
    expect(nodesOf(fake.graphs[0]!, 'LoraLoaderModelOnly')).toHaveLength(0);
  });

  it('refuses a sheet view without a portrait', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = seedCharacter(lib.store, manga.id, 'Aiko', '1girl');
    const err = await generateSlot(ctx(), services, { characterId: aiko.id, slot: 'fullbody' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('Aiko has no portrait yet: generate portraits and pick one first');
  });

  it('makes the full body with anime-ref from the portrait and stores it as a ref', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const { ctx: jobCtx, events } = jobContext(lib.store, 'image.generate', {});
    const result = await generateSlot(jobCtx, services, { characterId: aiko.id, slot: 'fullbody' });
    const graph = fake.graphs[0]!;
    expect(nodesOf(graph, 'IPAdapterAdvanced')).toHaveLength(1);
    expect(nodesOf(graph, 'LoadImage').map((n) => n.inputs['image'])).toEqual([`manga-builder/${aiko.refs.portrait}.png`]);
    expect(String(nodesOf(graph, 'CLIPTextEncode')[0]!.inputs['text'])).toContain('full body');
    expect(lib.store.images.require(result.imageId).role).toBe('fullbody');
    expect(lib.store.characters.require(aiko.id).refs).toEqual({ portrait: aiko.refs.portrait, fullbody: result.imageId });
    expect(events).toContainEqual({ type: 'entity', entity: 'character', id: aiko.id, op: 'updated', mangaId: manga.id });
    // F6: manga-bw's style recipe ('anime') is the same family (sdxl) as anime-ref, so the style LoRA carries over.
    expect(nodesOf(graph, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
  });

  it('drops the style LoRA on a sheet view whose family does not match the manga style, keeps it when it does', async () => {
    // F6 (controller ruling): styleLoras() only carries manga.styleGuide.loras onto a recipe of the same family.
    // anima-bw's style recipe is 'anima' (family 'anima'); the fullbody sheet view always uses anime-ref (family 'sdxl').
    const { manga: animaManga } = seedManga(lib.store, { preset: 'anima-bw' });
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, animaManga.id, 'Aiko', '1girl'), ['portrait']);
    await generateSlot(ctx(), services, { characterId: aiko.id, slot: 'fullbody' });
    expect(nodesOf(fake.graphs[0]!, 'LoraLoader')).toHaveLength(0);

    // Vice versa, as far as the fixtures allow: manga-bw's style recipe ('anime') is family 'sdxl', matching the
    // fullbody view's own family, so its style LoRA does carry over onto the same anime-ref sheet view.
    const { manga: bwManga } = seedManga(lib.store, { preset: 'manga-bw' });
    const ren = giveRefs(lib.store, seedCharacter(lib.store, bwManga.id, 'Ren', '1boy'), ['portrait']);
    await generateSlot(ctx(), services, { characterId: ren.id, slot: 'fullbody' });
    expect(nodesOf(fake.graphs[1]!, 'LoraLoader').map((n) => n.inputs['lora_name'])).toEqual(['Mnga-illustriousXL_v01_V1-CAME.safetensors']);
  });

  it('refuses side and back views before the full body exists', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const err = await generateSlot(ctx(), services, { characterId: aiko.id, slot: 'side' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe("Aiko has no full-body reference yet: generate the sheet's full-body view first");
  });

  it('character.refs makes full body, side and back in order inside one job', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl, silver hair'), ['portrait']);
    const { ctx: jobCtx, progress } = jobContext(lib.store, 'character.refs', { characterId: aiko.id });
    const result = await generateCharacterRefs(jobCtx, services, { characterId: aiko.id });

    expect(result.imageIds).toHaveLength(3);
    const [fullbody, side, back] = result.imageIds;
    expect(lib.store.characters.require(aiko.id).refs).toEqual({ portrait: aiko.refs.portrait, fullbody, side, back });
    expect(fake.graphs).toHaveLength(3);
    for (const [index, view] of [[1, 'right profile'], [2, 'from directly behind']] as const) {
      const graph = fake.graphs[index]!;
      const encode = nodesOf(graph, 'TextEncodeQwenImageEditPlus')[0]!;
      // F4 (controller ruling): the first reference now goes through FluxKontextImageScale before the encoder,
      // so follow one more hop (same fix as packages/server/test/panel-image.test.ts).
      const loadName = (link: unknown): unknown => {
        const node = graph[(link as Link)[0]]!;
        return node.class_type === 'FluxKontextImageScale' ? loadName(node.inputs['image']) : node.inputs['image'];
      };
      expect(loadName(encode.inputs['image1'])).toBe(`manga-builder/${aiko.refs.portrait}.png`);
      expect(loadName(encode.inputs['image2'])).toBe(`manga-builder/${fullbody}.png`);
      expect(String(encode.inputs['prompt'])).toContain(view);
      expect(String(encode.inputs['prompt'])).toContain('1girl, silver hair');
    }
    const labels = progress.map((p) => p.label);
    expect(labels.some((l) => l.startsWith('Full body (1/3): '))).toBe(true);
    expect(labels.some((l) => l.startsWith('Side view (2/3): '))).toBe(true);
    expect(labels.some((l) => l.startsWith('Back view (3/3): '))).toBe(true);
  });

  it('rejects and emits no character-updated event when the character is deleted mid-generation', async () => {
    const { manga } = seedManga(lib.store);
    const aiko = giveRefs(lib.store, seedCharacter(lib.store, manga.id, 'Aiko', '1girl'), ['portrait']);
    const { ctx: jobCtx, events } = jobContext(lib.store, 'image.generate', {});
    let deleted = false;
    const originalProgress = jobCtx.progress;
    jobCtx.progress = (label, value, max) => {
      if (label === 'Sampling' && !deleted) {
        deleted = true;
        lib.store.characters.delete(aiko.id);
      }
      originalProgress(label, value, max);
    };

    await expect(generateSlot(jobCtx, services, { characterId: aiko.id, slot: 'fullbody' })).rejects.toThrow(NotFoundError);

    expect(events.some((e) => e.type === 'entity' && e.entity === 'character' && e.op === 'updated')).toBe(false);
  });
});
