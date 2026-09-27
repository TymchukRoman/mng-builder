import type { EpisodeStepName, ReviewResult } from './schemas.js';

export type ImageGeneratePayload =
  | { target: 'panel'; panelId: string; recipe?: string | null; seed?: number | null; negativeExtra?: string | null; sceneSuffix?: string | null }
  | { target: 'character-portrait'; characterId: string; seed?: number | null }
  | { target: 'character-slot'; characterId: string; slot: 'fullbody' | 'side' | 'back' };
export interface ImageGenerateResult { imageId: string }
export interface ImageReviewPayload { imageId: string; panelId: string | null }
export type ImageReviewResult = ReviewResult;
export interface ImageUpscalePayload { imageId: string; factor: 2 | 4 }
export interface ImageUpscaleResult { imageId: string }
export interface CharacterRefsPayload { characterId: string }                  // generates fullbody → side → back
export interface CharacterRefsResult { imageIds: string[] }
export type LlmStepPayload =
  | { type: 'episode'; runId: string; step: EpisodeStepName }
  | { type: 'panel-prompt'; panelId: string }
  | { type: 'appearance'; characterId: string; description: string };
export interface ExportRenderPayload { target: { type: 'page' | 'chapter'; id: string }; format: 'png' | 'pdf'; outDir?: string }
export interface ExportRenderResult { files: string[] }
