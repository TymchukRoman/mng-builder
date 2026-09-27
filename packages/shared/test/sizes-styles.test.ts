import { describe, expect, it } from 'vitest';
import {
  buildPreset,
  BUNDLED_FONTS,
  computeRects,
  DEFAULT_FONT_SIZE,
  DEFAULT_PAGE_FORMAT,
  FONT_FOR_KIND,
  FrameKindSchema,
  MIN_READABLE_PT,
  pickSize,
  SDXL_SIZES,
  STYLE_PRESETS,
  StyleGuideSchema,
} from '@manga/shared';

describe('pickSize', () => {
  it('lists the nine SDXL buckets', () => {
    expect(SDXL_SIZES).toEqual([[1024, 1024], [896, 1152], [832, 1216], [768, 1344], [640, 1536], [1152, 896], [1216, 832], [1344, 768], [1536, 640]]);
  });

  it.each([
    [1, [1024, 1024]],
    [0.7, [832, 1216]],
    [0.75, [896, 1152]],
    [0.5, [768, 1344]],
    [0.3, [640, 1536]],
    [1.5, [1216, 832]],
    [2.5, [1536, 640]],
  ] as const)('aspect %f → %j', (aspect, size) => {
    expect(pickSize(aspect, SDXL_SIZES)).toEqual(size);
  });

  it('picks 832×1216 for a 2x2 panel on the default page', () => {
    let n = 0;
    const rect = computeRects(buildPreset('2x2', 'ltr', () => `pn_${++n}`), DEFAULT_PAGE_FORMAT)[0]?.rect;
    expect(rect).toBeDefined();
    const aspect = ((rect?.w ?? 0) * DEFAULT_PAGE_FORMAT.widthMm) / ((rect?.h ?? 1) * DEFAULT_PAGE_FORMAT.heightMm);
    expect(pickSize(aspect, SDXL_SIZES)).toEqual([832, 1216]);
  });

  it('rejects a non-positive aspect and an empty size list', () => {
    expect(() => pickSize(0, SDXL_SIZES)).toThrow(RangeError);
    expect(() => pickSize(Number.NaN, SDXL_SIZES)).toThrow(RangeError);
    expect(() => pickSize(1, [])).toThrow(RangeError);
  });
});

describe('STYLE_PRESETS', () => {
  it('ships the four presets from the contract', () => {
    expect(Object.keys(STYLE_PRESETS)).toEqual(['manga-bw', 'manga-hatching', 'anime-color', 'anima-bw']);
    for (const preset of Object.values(STYLE_PRESETS)) {
      expect(STYLE_PRESETS[preset.id]).toBe(preset);
      expect(StyleGuideSchema.safeParse(preset.styleGuide).success).toBe(true);
      expect(preset.styleGuide.negativePrompt).toBe('lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality');
    }
    expect(STYLE_PRESETS['manga-bw']?.styleGuide).toMatchObject({
      recipe: 'anime', stylePrompt: 'masterpiece, best quality, clean lineart, detailed background',
      loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }],
    });
    expect(STYLE_PRESETS['manga-hatching']?.styleGuide.loras).toEqual([{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }]);
    expect(STYLE_PRESETS['anime-color']).toMatchObject({ colorMode: 'color', styleGuide: { loras: [], stylePrompt: 'masterpiece, best quality, vibrant colors, detailed background' } });
    expect(STYLE_PRESETS['anima-bw']?.styleGuide).toMatchObject({ recipe: 'anima', stylePrompt: 'masterpiece, best quality, clean lineart', loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] });
  });
});

describe('fonts', () => {
  it('has a bundled font and a readable default size for every frame kind', () => {
    for (const kind of FrameKindSchema.options) {
      expect(BUNDLED_FONTS).toContain(FONT_FOR_KIND[kind]);
      expect(DEFAULT_FONT_SIZE[kind]).toBeGreaterThanOrEqual(MIN_READABLE_PT);
    }
  });
});
