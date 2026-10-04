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
  | { type: 'appearance'; characterId: string; description: string }
  /** W1 Q1: the chapter's "what happened", queued when an episode run finishes. */
  | { type: 'chapter-summary'; chapterId: string; runId: string }
  /** The series plan of an auto-created manga (workflows/auto). */
  | { type: 'manga-plan'; autoRunId: string };

/** W1 R2: the gpu lane's pause reason when another app holds the GPU memory; only this pause is lifted automatically. */
export const GPU_BUSY_REASON = 'GPU busy: another app is using GPU memory';
/** W1 R2: the gpu lane's pause reason after "Pause GPU queue (images and local AI)"; never lifted automatically. */
export const GPU_MANUAL_PAUSE_REASON = 'Paused by you';
export interface ExportRenderPayload { target: { type: 'page' | 'chapter'; id: string }; format: 'png' | 'pdf'; outDir?: string }
export interface ExportRenderResult { files: string[] }
