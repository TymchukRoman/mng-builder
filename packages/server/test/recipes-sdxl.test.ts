import { describe, expect, it } from 'vitest';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { anime } from '../src/imaging/recipes/anime.js';
import { animeRef } from '../src/imaging/recipes/anime-ref.js';
import { animePose } from '../src/imaging/recipes/anime-pose.js';
import { animeRefine } from '../src/imaging/recipes/anime-refine.js';
import { RecipeInputError, recipeInfo } from '../src/imaging/recipes/types.js';
import { classes, expectLinked, one, params, source } from './helpers/graph.js';

describe('anime', () => {
  it('builds WAI Illustrious with CLIP skip 2 and a KSampler', () => {
    const g = anime.build(params());
    expectLinked(g);
    expect(classes(g)).toEqual(['CheckpointLoaderSimple', 'CLIPSetLastLayer', 'CLIPTextEncode', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'].sort());
    expect(one(g, 'CheckpointLoaderSimple').inputs).toEqual({ ckpt_name: 'waiIllustriousSDXL_v170.safetensors' });
    expect(one(g, 'CLIPSetLastLayer').inputs['stop_at_clip_layer']).toBe(-2);
    expect(nodesOf(g, 'CLIPTextEncode').map((n) => n.inputs['text'])).toEqual(['POS', 'NEG']);
    expect(one(g, 'EmptyLatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(one(g, 'KSampler').inputs).toMatchObject({ seed: 42, steps: 10, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1 });
    expect(one(g, 'SaveImage').inputs['filename_prefix']).toBe('manga-builder/test');
    expect(anime).toMatchObject({ family: 'sdxl', maxRefs: 0, supportsLoras: true, supportsInit: true, defaults: { steps: 28, cfg: 5.5 } });
  });

  it('chains LoRAs on model and clip', () => {
    const g = anime.build(params({ loras: [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: 0.5 }] }));
    expectLinked(g);
    const loras = nodesOf(g, 'LoraLoader');
    expect(loras.map((l) => [l.inputs['lora_name'], l.inputs['strength_model'], l.inputs['strength_clip']])).toEqual([['a.safetensors', 0.8, 0.8], ['b.safetensors', 0.5, 0.5]]);
    expect(loras[1]!.inputs['model']).toEqual([loras[0]!.id, 0]);
    expect(loras[1]!.inputs['clip']).toEqual([loras[0]!.id, 1]);
    expect(one(g, 'KSampler').inputs['model']).toEqual([loras[1]!.id, 0]);
    expect(one(g, 'CLIPSetLastLayer').inputs['clip']).toEqual([loras[1]!.id, 1]);
  });

  it('does img2img from an init image', () => {
    const g = anime.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 0.35 } }));
    expectLinked(g);
    expect(nodesOf(g, 'EmptyLatentImage')).toHaveLength(0);
    expect(one(g, 'LoadImage').inputs).toEqual({ image: 'manga-builder/im_a.png' });
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs['denoise']).toBe(0.35);
    expect(source(g, sampler.inputs['latent_image'])).toBe('VAEEncode');
  });
});

describe('anime-ref', () => {
  it('adds noobIPA through IPAdapterAdvanced fed by a batch of references', () => {
    const g = animeRef.build(params({ refs: ['manga-builder/im_p.png', 'manga-builder/im_f.png'] }));
    expectLinked(g);
    expect(one(g, 'IPAdapterModelLoader').inputs).toEqual({ ipadapter_file: 'noobIPAMARK1_mark1.safetensors' });
    expect(one(g, 'CLIPVisionLoader').inputs).toEqual({ clip_name: 'CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors' });
    expect(nodesOf(g, 'LoadImage').map((n) => n.inputs['image'])).toEqual(['manga-builder/im_p.png', 'manga-builder/im_f.png']);
    const batch = one(g, 'ImageBatch');
    const adapter = one(g, 'IPAdapterAdvanced');
    expect(adapter.inputs).toMatchObject({ weight: 0.4, weight_type: 'linear', combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only' });
    expect(adapter.inputs['image']).toEqual([batch.id, 0]);
    expect(source(g, adapter.inputs['clip_vision'])).toBe('CLIPVisionLoader');
    expect(source(g, adapter.inputs['ipadapter'])).toBe('IPAdapterModelLoader');
    expect(one(g, 'KSampler').inputs['model']).toEqual([adapter.id, 0]);
  });

  it('uses a single reference without a batch node', () => {
    const g = animeRef.build(params({ refs: ['manga-builder/im_p.png'] }));
    expectLinked(g);
    expect(nodesOf(g, 'ImageBatch')).toHaveLength(0);
    expect(source(g, one(g, 'IPAdapterAdvanced').inputs['image'])).toBe('LoadImage');
  });

  it('needs a reference', () => {
    expect(() => animeRef.build(params())).toThrow(RecipeInputError);
  });

  it('describes itself for the API', () => {
    expect(recipeInfo(animeRef)).toEqual({
      id: 'anime-ref', label: 'Anime + reference (noobIPA)', maxRefs: 2, requiresRefs: true,
      supportsPose: false, supportsLineart: false, supportsLoras: true, supportsInit: false,
    });
  });
});

describe('anime-pose', () => {
  it('applies noob_openpose through ControlNetApplyAdvanced on both conditionings', () => {
    const g = animePose.build(params({ control: { kind: 'pose', image: 'manga-builder/im_pose.png', strength: 0.8 } }));
    expectLinked(g);
    expect(one(g, 'ControlNetLoader').inputs).toEqual({ control_net_name: 'noob_openpose_pre.safetensors' });
    const apply = one(g, 'ControlNetApplyAdvanced');
    expect(apply.inputs).toMatchObject({ strength: 0.8, start_percent: 0, end_percent: 1 });
    expect(source(g, apply.inputs['image'])).toBe('LoadImage');
    expect(source(g, apply.inputs['vae'])).toBe('CheckpointLoaderSimple');
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs['positive']).toEqual([apply.id, 0]);
    expect(sampler.inputs['negative']).toEqual([apply.id, 1]);
    expect(nodesOf(g, 'IPAdapterAdvanced')).toHaveLength(0);
  });

  it('can add references on top of the pose', () => {
    const g = animePose.build(params({ refs: ['manga-builder/im_p.png'], control: { kind: 'pose', image: 'manga-builder/im_pose.png', strength: 0.8 } }));
    expectLinked(g);
    expect(nodesOf(g, 'IPAdapterAdvanced')).toHaveLength(1);
  });

  it('needs a pose image', () => {
    expect(() => animePose.build(params())).toThrow('needs a pose image');
  });
});

describe('anime-refine', () => {
  it('is img2img only and keeps the style LoRA', () => {
    expect(() => animeRefine.build(params())).toThrow('needs an input image');
    const g = animeRefine.build(params({
      init: { image: 'manga-builder/im_q.png', denoise: 0.3 }, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }],
    }));
    expectLinked(g);
    expect(one(g, 'KSampler').inputs['denoise']).toBe(0.3);
    expect(one(g, 'LoraLoader').inputs['lora_name']).toBe('Mnga-illustriousXL_v01_V1-CAME.safetensors');
    expect(nodesOf(g, 'EmptyLatentImage')).toHaveLength(0);
  });
});
