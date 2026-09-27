import type { LoraRef, RecipeInfo } from '@manga/shared';
import type { ComfyGraph } from '../comfy-graph.js';

export interface RecipeParams {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  loras: LoraRef[];
  /** ComfyUI input names returned by ComfyClient.uploadImage. */
  refs: string[];
  refWeight: number;
  control: { kind: 'pose' | 'lineart'; image: string; strength: number } | null;
  init: { image: string; denoise: number } | null;
  upscale: 2 | 4 | null;
  filenamePrefix: string;
}

export interface Recipe {
  id: string;
  label: string;
  family: 'sdxl' | 'qwen' | 'flux2' | 'anima' | 'upscale';
  maxRefs: number;
  requiresRefs: boolean;
  supportsPose: boolean;
  supportsLineart: boolean;
  supportsLoras: boolean;
  supportsInit: boolean;
  defaults: { steps: number; cfg: number };
  sizes: Array<[number, number]>;
  build(p: RecipeParams): ComfyGraph;
}

/** A recipe was given inputs it cannot build from (no reference, no pose image, …). */
export class RecipeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeInputError';
  }
}

export function recipeInfo(r: Recipe): RecipeInfo {
  return {
    id: r.id, label: r.label, maxRefs: r.maxRefs, requiresRefs: r.requiresRefs, supportsPose: r.supportsPose,
    supportsLineart: r.supportsLineart, supportsLoras: r.supportsLoras, supportsInit: r.supportsInit,
  };
}
