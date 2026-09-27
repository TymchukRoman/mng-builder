import type { ColorMode, StyleGuide } from './schemas.js';

export interface StylePreset { id: string; label: string; colorMode: ColorMode; styleGuide: StyleGuide }

// (M2 F9) The shared negative gains the P1 style-LoRA negative token so a generation without an explicit
// per-request negative still steers away from it.
const NEGATIVE = 'lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality, nsfw';
const MANGA_STYLE = 'masterpiece, best quality, clean lineart, detailed background';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  'manga-bw': {
    id: 'manga-bw', label: 'Manga (B&W)', colorMode: 'bw',
    // (M2 F9) 'hatching (texture)' is the Mnga LoRA's trigger token (claude-image-gen presets.py STYLES['manga']).
    styleGuide: { recipe: 'anime', stylePrompt: `${MANGA_STYLE}, hatching (texture)`, negativePrompt: NEGATIVE, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }] },
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
