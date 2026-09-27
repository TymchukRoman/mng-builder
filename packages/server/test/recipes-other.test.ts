import { describe, expect, it } from 'vitest';
import { SDXL_SIZES } from '@manga/shared';
import { nodesOf } from '../src/imaging/comfy-graph.js';
import { qwenEditRef } from '../src/imaging/recipes/qwen-edit-ref.js';
import { kleinRef } from '../src/imaging/recipes/klein-ref.js';
import { anima } from '../src/imaging/recipes/anima.js';
import { animaTurbo } from '../src/imaging/recipes/anima-turbo.js';
import { upscale } from '../src/imaging/recipes/upscale.js';
import { RECIPES, RecipeInputError, type RecipeParams } from '../src/imaging/recipes/index.js';
import { expectLinked, one, params, source } from './helpers/graph.js';

describe('qwen-edit-ref', () => {
  it('builds Qwen-Image-Edit-2511 Q5 GGUF + Lightning 8-step with up to three pictures', () => {
    const g = qwenEditRef.build(params({ refs: ['manga-builder/a.png', 'manga-builder/b.png', 'manga-builder/c.png', 'manga-builder/d.png'], steps: 8, cfg: 1 }));
    expectLinked(g);
    expect(one(g, 'UnetLoaderGGUF').inputs).toEqual({ unet_name: 'qwen-image-edit-2511-Q5_K_M.gguf' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'qwen_image_vae.safetensors' });
    expect(one(g, 'ModelSamplingAuraFlow').inputs['shift']).toBe(3.1);
    expect(one(g, 'CFGNorm').inputs['strength']).toBe(1);
    expect(one(g, 'LoraLoaderModelOnly').inputs).toMatchObject({ lora_name: 'Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors', strength_model: 1 });

    // P1 alignment (F3, controller ruling): the positive and negative each get their own
    // TextEncodeQwenImageEditPlus (not a ConditioningZeroOut), sharing the same pictures.
    const [encode, negEncode] = nodesOf(g, 'TextEncodeQwenImageEditPlus');
    expect(nodesOf(g, 'TextEncodeQwenImageEditPlus')).toHaveLength(2);
    expect(encode!.inputs['prompt']).toBe('POS');
    expect(negEncode!.inputs['prompt']).toBe('NEG');
    expect(source(g, encode!.inputs['vae'])).toBe('VAELoader');

    // image1 is scaled through FluxKontextImageScale before it reaches either encoder.
    expect(source(g, encode!.inputs['image1'])).toBe('FluxKontextImageScale');
    expect(negEncode!.inputs['image1']).toEqual(encode!.inputs['image1']);
    const scale = one(g, 'FluxKontextImageScale');
    expect(source(g, scale.inputs['image'])).toBe('LoadImage');
    expect(g[(scale.inputs['image'] as [string, number])[0]]!.inputs['image']).toBe('manga-builder/a.png');
    expect(g[(encode!.inputs['image2'] as [string, number])[0]]!.inputs['image']).toBe('manga-builder/b.png');
    expect(g[(encode!.inputs['image3'] as [string, number])[0]]!.inputs['image']).toBe('manga-builder/c.png');
    expect(negEncode!.inputs['image2']).toEqual(encode!.inputs['image2']);
    expect(negEncode!.inputs['image3']).toEqual(encode!.inputs['image3']);
    expect(encode!.inputs['image4']).toBeUndefined();

    // Both the positive and the negative pass through FluxKontextMultiReferenceLatentMethod.
    const refMethods = nodesOf(g, 'FluxKontextMultiReferenceLatentMethod');
    expect(refMethods).toHaveLength(2);
    for (const n of refMethods) expect(n.inputs['reference_latents_method']).toBe('index_timestep_zero');
    expect(nodesOf(g, 'ConditioningZeroOut')).toHaveLength(0);

    expect(one(g, 'EmptySD3LatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    const sampler = one(g, 'KSampler');
    expect(sampler.inputs).toMatchObject({ seed: 42, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
    expect(source(g, sampler.inputs['model'])).toBe('LoraLoaderModelOnly');
    expect(source(g, sampler.inputs['positive'])).toBe('FluxKontextMultiReferenceLatentMethod');
    expect(source(g, sampler.inputs['negative'])).toBe('FluxKontextMultiReferenceLatentMethod');
    expect(qwenEditRef).toMatchObject({ family: 'qwen', maxRefs: 3, requiresRefs: true, supportsLoras: false, defaults: { steps: 8, cfg: 1 } });
  });

  it('needs a reference', () => {
    expect(() => qwenEditRef.build(params())).toThrow(RecipeInputError);
  });
});

describe('klein-ref', () => {
  it('builds FLUX.2 klein 4B with one ReferenceLatent pair per reference', () => {
    const g = kleinRef.build(params({ refs: ['manga-builder/a.png', 'manga-builder/b.png'], steps: 4, cfg: 1 }));
    expectLinked(g);
    expect(one(g, 'UNETLoader').inputs).toEqual({ unet_name: 'flux-2-klein-4b-fp8.safetensors', weight_dtype: 'default' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'flux2-vae.safetensors' });
    expect(nodesOf(g, 'ImageScaleToTotalPixels').map((n) => n.inputs)).toEqual([
      expect.objectContaining({ upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 }),
      expect.objectContaining({ upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 }),
    ]);
    expect(nodesOf(g, 'ReferenceLatent')).toHaveLength(4);
    const guider = one(g, 'CFGGuider');
    expect(guider.inputs['cfg']).toBe(1);
    expect(source(g, guider.inputs['positive'])).toBe('ReferenceLatent');
    expect(source(g, guider.inputs['negative'])).toBe('ReferenceLatent');
    expect(one(g, 'Flux2Scheduler').inputs).toEqual({ steps: 4, width: 832, height: 1216 });
    expect(one(g, 'RandomNoise').inputs).toEqual({ noise_seed: 42 });
    expect(one(g, 'KSamplerSelect').inputs).toEqual({ sampler_name: 'euler' });
    expect(one(g, 'EmptyFlux2LatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(source(g, one(g, 'VAEDecode').inputs['samples'])).toBe('SamplerCustomAdvanced');
    expect(kleinRef).toMatchObject({ family: 'flux2', maxRefs: 4, requiresRefs: false, defaults: { steps: 4, cfg: 1 } });
  });

  it('works without references as text-to-image', () => {
    const g = kleinRef.build(params());
    expectLinked(g);
    expect(nodesOf(g, 'ReferenceLatent')).toHaveLength(0);
    expect(source(g, one(g, 'CFGGuider').inputs['positive'])).toBe('CLIPTextEncode');
  });
});

describe('anima and anima-turbo', () => {
  it('builds Anima with its own text encoder and the Qwen VAE', () => {
    const g = anima.build(params());
    expectLinked(g);
    expect(one(g, 'UNETLoader').inputs).toEqual({ unet_name: 'anima-aesthetic-v1.1.safetensors', weight_dtype: 'default' });
    expect(one(g, 'CLIPLoader').inputs).toEqual({ clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' });
    expect(one(g, 'VAELoader').inputs).toEqual({ vae_name: 'qwen_image_vae.safetensors' });
    expect(one(g, 'EmptyLatentImage').inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    expect(one(g, 'KSampler').inputs).toMatchObject({ sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
    expect(anima).toMatchObject({ family: 'anima', supportsPose: true, supportsLineart: true, supportsLoras: true, defaults: { steps: 30, cfg: 4 } });
  });

  it('applies an LLLite pose or lineart patch to the model before any LoRA', () => {
    const pose = anima.build(params({ control: { kind: 'pose', image: 'manga-builder/pose.png', strength: 0.8 } }));
    expectLinked(pose);
    expect(one(pose, 'ModelPatchLoader').inputs).toEqual({ name: 'anima-lllite-pose-1.safetensors' });
    const apply = one(pose, 'AnimaLLLiteApply');
    expect(apply.inputs).toMatchObject({ strength: 0.8, start_percent: 0, end_percent: 1 });
    expect(source(pose, apply.inputs['model_patch'])).toBe('ModelPatchLoader');
    expect(source(pose, one(pose, 'KSampler').inputs['model'])).toBe('AnimaLLLiteApply');
    const lineart = anima.build(params({ control: { kind: 'lineart', image: 'manga-builder/line.png', strength: 0.6 } }));
    expect(one(lineart, 'ModelPatchLoader').inputs).toEqual({ name: 'anima-lllite-lineart-1.safetensors' });
  });

  it('takes style LoRAs on the model only (P1 alignment, F5): LoraLoaderModelOnly, clip stays the CLIPLoader output', () => {
    const g = anima.build(params({ loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] }));
    expectLinked(g);
    const lora = one(g, 'LoraLoaderModelOnly');
    expect(lora.inputs).toEqual({ model: expect.anything(), lora_name: 'Mangalike_Anima.safetensors', strength_model: 0.8 });
    expect(lora.inputs['strength_clip']).toBeUndefined();
    expect(source(g, one(g, 'KSampler').inputs['model'])).toBe('LoraLoaderModelOnly');
    for (const n of nodesOf(g, 'CLIPTextEncode')) expect(source(g, n.inputs['clip'])).toBe('CLIPLoader');
  });

  it('applies control before the LoRA chain, per P1', () => {
    const g = anima.build(params({
      control: { kind: 'pose', image: 'manga-builder/pose.png', strength: 0.8 },
      loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }],
    }));
    expectLinked(g);
    const lora = one(g, 'LoraLoaderModelOnly');
    expect(source(g, lora.inputs['model'])).toBe('AnimaLLLiteApply');
    expect(source(g, one(g, 'KSampler').inputs['model'])).toBe('LoraLoaderModelOnly');
  });

  it('turbo uses the turbo weights and 8 steps at cfg 1', () => {
    const g = animaTurbo.build(params());
    expect(one(g, 'UNETLoader').inputs['unet_name']).toBe('anima-turbo-v1.1.safetensors');
    expect(animaTurbo.defaults).toEqual({ steps: 8, cfg: 1 });
  });
});

describe('upscale', () => {
  it('runs 4x-AnimeSharp, and halves it for 2x', () => {
    const four = upscale.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 1 }, upscale: 4 }));
    expectLinked(four);
    expect(one(four, 'UpscaleModelLoader').inputs).toEqual({ model_name: '4x-AnimeSharp.safetensors' });
    expect(source(four, one(four, 'SaveImage').inputs['images'])).toBe('ImageUpscaleWithModel');
    expect(nodesOf(four, 'ImageScaleBy')).toHaveLength(0);
    const two = upscale.build(params({ init: { image: 'manga-builder/im_a.png', denoise: 1 }, upscale: 2 }));
    expect(one(two, 'ImageScaleBy').inputs).toMatchObject({ upscale_method: 'lanczos', scale_by: 0.5 });
    expect(source(two, one(two, 'SaveImage').inputs['images'])).toBe('ImageScaleBy');
    expect(() => upscale.build(params())).toThrow('needs an input image');
  });
});

describe('RECIPES', () => {
  const valid: Record<string, Partial<RecipeParams>> = {
    anime: {}, 'anime-ref': { refs: ['r.png'] }, 'anime-pose': { control: { kind: 'pose', image: 'p.png', strength: 0.8 } },
    'qwen-edit-ref': { refs: ['r.png'] }, 'klein-ref': {}, anima: {}, 'anima-turbo': {},
    'anime-refine': { init: { image: 'i.png', denoise: 0.3 } }, upscale: { init: { image: 'i.png', denoise: 1 }, upscale: 4 },
  };

  it('has exactly the contract recipe ids', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(Object.keys(valid).sort());
    for (const [id, recipe] of Object.entries(RECIPES)) expect(recipe.id).toBe(id);
  });

  it.each(Object.keys(valid))('%s builds a linked, serialisable graph with one SaveImage', (id) => {
    const recipe = RECIPES[id]!;
    const g = recipe.build(params(valid[id]));
    expectLinked(g);
    expect(nodesOf(g, 'SaveImage')).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    expect(recipe.sizes).toEqual(id === 'upscale' ? [] : SDXL_SIZES);
  });
});
