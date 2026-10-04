import { z } from 'zod';
import type { Settings } from './schemas.js';

/**
 * An image model as a user picks it for a whole manga or chapter: one choice that fills the three panel routes
 * (no characters, one character, several), so nobody has to know which recipe takes references. `null` everywhere
 * means "the routing of Settings".
 *
 * The presets only use recipes that exist in the server's recipe list (a server test keeps the two in step).
 * The identity-drift retry (`settings.routing.driftFallback`) and the B&W refine pass stay as Settings say.
 */
export interface ImageModel {
  id: string;
  label: string;
  /** One line for the picker: what it is good at and what it costs. */
  summary: string;
  routing: { noChars: string; oneChar: string; multiChar: string };
  /** Whether panels keep a character's face from its portrait (false: only the appearance tags carry identity). */
  usesReferences: boolean;
}

export const IMAGE_MODELS: Record<string, ImageModel> = {
  sdxl: {
    id: 'sdxl', label: 'SDXL · WAI Illustrious', usesReferences: true,
    summary: 'Classic anime look with the manga LoRA; one or two characters keep their face (~30 s a panel).',
    routing: { noChars: 'anime', oneChar: 'anime-ref', multiChar: 'anime-ref' },
  },
  flux2: {
    id: 'flux2', label: 'FLUX.2 klein', usesReferences: true,
    summary: 'Fast, follows the scene well and keeps up to four characters from their portraits (~17 s a panel).',
    routing: { noChars: 'klein-ref', oneChar: 'klein-ref', multiChar: 'klein-ref' },
  },
  qwen: {
    id: 'qwen', label: 'Qwen Image Edit', usesReferences: true,
    summary: 'Best identity with references, slow (~2 min a panel with characters).',
    routing: { noChars: 'klein-ref', oneChar: 'qwen-edit-ref', multiChar: 'qwen-edit-ref' },
  },
  anima: {
    id: 'anima', label: 'Anima', usesReferences: false,
    summary: 'Clean manga lineart from tags alone, no references (~30 s a panel).',
    routing: { noChars: 'anima', oneChar: 'anima', multiChar: 'anima' },
  },
  'anima-turbo': {
    id: 'anima-turbo', label: 'Anima Turbo', usesReferences: false,
    summary: 'The fastest option, no references (~14 s a panel); good for drafts.',
    routing: { noChars: 'anima-turbo', oneChar: 'anima-turbo', multiChar: 'anima-turbo' },
  },
};

export const IMAGE_MODEL_IDS: string[] = Object.keys(IMAGE_MODELS);

/** The preset with this id, or null for `null`, an empty id and an id that is not a preset. */
export function imageModelById(id: string | null | undefined): ImageModel | null {
  return typeof id === 'string' && Object.hasOwn(IMAGE_MODELS, id) ? IMAGE_MODELS[id]! : null;
}

/** The model a chapter renders with: its own, else its manga's, else null (Settings' routing). */
export function effectiveImageModel(chapter: { imageModel?: string | null } | null | undefined, manga: { imageModel?: string | null }): string | null {
  return chapter?.imageModel ?? manga.imageModel ?? null;
}

/** `settings` with the routes of the model written over its routing; unchanged for null or an unknown id. */
export function applyImageModel(settings: Settings, id: string | null | undefined): Settings {
  const model = imageModelById(id);
  return model === null ? settings : { ...settings, routing: { ...settings.routing, ...model.routing } };
}

/** An API field that names an image model: a preset id, or null for "Settings' routing". */
export const ImageModelFieldSchema = z.string().nullable().refine(
  (id) => id === null || Object.hasOwn(IMAGE_MODELS, id),
  { message: `unknown image model; use one of: ${IMAGE_MODEL_IDS.join(', ')}` },
);
