import type { ColorMode, StyleGuide } from './schemas.js';

export interface StylePreset { id: string; label: string; colorMode: ColorMode; styleGuide: StyleGuide }

const NEGATIVE = 'lowres, bad anatomy, bad hands, blurry, jpeg artifacts, worst quality';
const MANGA_STYLE = 'masterpiece, best quality, clean lineart, detailed background';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  'manga-bw': {
    id: 'manga-bw', label: 'Manga (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anime', stylePrompt: MANGA_STYLE, negativePrompt: NEGATIVE, loras: [{ name: 'Mnga-illustriousXL_v01_V1-CAME.safetensors', strength: 0.8 }] },
  },
  'manga-hatching': {
    id: 'manga-hatching', label: 'Manga hatching (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anime', stylePrompt: MANGA_STYLE, negativePrompt: NEGATIVE, loras: [{ name: 'Ashpwright_style_mix-000033.safetensors', strength: 0.8 }] },
  },
  'anime-color': {
    id: 'anime-color', label: 'Anime (colour)', colorMode: 'color',
    styleGuide: { recipe: 'anime', stylePrompt: 'masterpiece, best quality, vibrant colors, detailed background', negativePrompt: NEGATIVE, loras: [] },
  },
  'anima-bw': {
    id: 'anima-bw', label: 'Anima (B&W)', colorMode: 'bw',
    styleGuide: { recipe: 'anima', stylePrompt: 'masterpiece, best quality, clean lineart', negativePrompt: NEGATIVE, loras: [{ name: 'Mangalike_Anima.safetensors', strength: 0.8 }] },
  },
};
