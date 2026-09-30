import type { ColorMode, LoraRef, StyleGuide } from './schemas.js';

/*
 * A style LoRA's `maleStrength` is the strength used when the subject (a portrait or sheet) or the panel has a male
 * human: the Mnga LoRA at 0.8 turned men into women even against "1boy, male focus" and an anti-female negative (GPU
 * tests A–C); at 0.4 it drew them male (E, J). Ashpwright keeps men male at 0.8 (F, G), so it has none.
 */
export interface StylePreset { id: string; label: string; colorMode: ColorMode; styleGuide: StyleGuide }

// (M2 F9) The shared negative gains the P1 style-LoRA negative token so a generation without an explicit
// per-request negative still steers away from it.
const NEGATIVE = 'lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality, nsfw';
const MANGA_STYLE = 'masterpiece, best quality, clean lineart, detailed background';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  'manga-bw': {
    id: 'manga-bw', label: 'Manga (B&W)', colorMode: 'bw',
    // (M2 F9) 'hatching (texture)' is the Mnga LoRA's trigger token (claude-image-gen presets.py STYLES['manga']).
    styleGuide: { recipe: 'anime', stylePrompt: `${MANGA_STYLE}, hatching (texture)`, negativePrompt: NEGATIVE, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8, maleStrength: 0.4 }] },
  },
  'manga-hatching': {
    id: 'manga-hatching', label: 'Manga hatching (B&W)', colorMode: 'bw',
    // (M2 F9) 'ashpwright' is the Ashpwright LoRA's trigger token (presets.py STYLES['manga-hatching']).
    styleGuide: { recipe: 'anime', stylePrompt: `${MANGA_STYLE}, ashpwright`, negativePrompt: NEGATIVE, loras: [{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }] },
  },
  'anime-color': {
    id: 'anime-color', label: 'Anime (colour)', colorMode: 'color',
    styleGuide: { recipe: 'anime', stylePrompt: 'masterpiece, best quality, vibrant colors, detailed background', negativePrompt: NEGATIVE, loras: [] },
  },
  'anima-bw': {
    id: 'anima-bw', label: 'Anima (B&W)', colorMode: 'bw',
    // (M2 F9) presets.py STYLES['anima-manga'] has no trigger token for the Anima LoRA, so stylePrompt is unchanged.
    styleGuide: { recipe: 'anima', stylePrompt: 'masterpiece, best quality, clean lineart', negativePrompt: NEGATIVE, loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] },
  },
};

/** maleStrength by LoRA file name, so a manga created before it existed (its stored style guide lacks it) gets it too. */
const MALE_STRENGTH: ReadonlyMap<string, number> = new Map(
  Object.values(STYLE_PRESETS).flatMap((p) => p.styleGuide.loras.flatMap((l) => (l.maleStrength === undefined ? [] : [[l.name, l.maleStrength] as const]))),
);

/**
 * The style LoRAs as a generation applies them: with a male human in the subject or panel, a LoRA with a
 * `maleStrength` (its own, else its preset's by file name) runs at that strength when it is weaker than the set one.
 * Returns the strengths applied (no maleStrength), as the image's generation parameters record them.
 */
export function styleLorasFor(loras: readonly LoraRef[], hasMale: boolean): LoraRef[] {
  return loras.map((lora) => {
    const male = lora.maleStrength ?? MALE_STRENGTH.get(lora.name);
    const strength = hasMale && male !== undefined && Math.abs(male) < Math.abs(lora.strength) ? male : lora.strength;
    return { name: lora.name, strength };
  });
}
