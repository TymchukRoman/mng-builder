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
  printSizePx,
  pickSize,
  SDXL_SIZES,
  STYLE_PRESETS,
  StyleGuideSchema,
  styleLorasFor,
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
      // No content-rating steering: the app never asks the image model to avoid or favour anything adult.
      expect(preset.styleGuide.negativePrompt).toBe('lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality');
    }
    expect(STYLE_PRESETS['manga-bw']?.styleGuide).toMatchObject({
      recipe: 'anime', stylePrompt: 'masterpiece, best quality, clean lineart, detailed background, hatching (texture)',
      loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8, maleStrength: 0.4 }],
    });
    expect(STYLE_PRESETS['manga-hatching']?.styleGuide).toMatchObject({
      stylePrompt: 'masterpiece, best quality, clean lineart, detailed background, ashpwright',
      loras: [{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }],
    });
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

describe('printSizePx', () => {
  it('is the exact export pixel size, round(mm / 25.4 * dpi), optionally scaled', () => {
    expect(printSizePx(DEFAULT_PAGE_FORMAT)).toEqual({ w: 2150, h: 3035 });
    expect(printSizePx(DEFAULT_PAGE_FORMAT, 0.5)).toEqual({ w: 1075, h: 1518 });
    expect(printSizePx({ ...DEFAULT_PAGE_FORMAT, widthMm: 25.4, heightMm: 50.8, dpi: 100 })).toEqual({ w: 100, h: 200 });
  });
});

describe('styleLorasFor (the style LoRA strength for a male subject)', () => {
  const mnga = STYLE_PRESETS['manga-bw']!.styleGuide.loras;
  const ash = STYLE_PRESETS['manga-hatching']!.styleGuide.loras;

  it("runs the 'manga' Mnga LoRA at 0.4 with a male in the subject or panel, and at 0.8 otherwise", () => {
    expect(styleLorasFor(mnga, true)).toEqual([{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.4 }]);
    expect(styleLorasFor(mnga, false)).toEqual([{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }]);
  });

  it('keeps Ashpwright at 0.8 for men (it has no maleStrength)', () => {
    expect(styleLorasFor(ash, true)).toEqual([{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }]);
  });

  it("finds the preset's maleStrength by file name for a manga stored before it existed, and never raises a weaker set strength", () => {
    expect(styleLorasFor([{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }], true)[0]!.strength).toBe(0.4);
    expect(styleLorasFor([{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.3 }], true)[0]!.strength).toBe(0.3);
    expect(styleLorasFor([{ name: 'custom.safetensors', strength: 0.7 }], true)).toEqual([{ name: 'custom.safetensors', strength: 0.7 }]);
  });
});
