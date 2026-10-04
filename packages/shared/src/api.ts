import { z } from 'zod';
import {
  BoxSchema,
  ChapterStatusSchema,
  CharacterRoleSchema,
  ColorModeSchema,
  EpisodeInputSchema,
  FrameKindSchema,
  IdSchema,
  ImageTransformSchema,
  LanguageSchema,
  PageFormatSchema,
  PanelScriptSchema,
  PointSchema,
  ReadingDirectionSchema,
  StyleGuideSchema,
} from './schemas.js';
import { ImageModelFieldSchema } from './image-models.js';
import type { Image, Lane, Page, Panel, TextFrame } from './schemas.js';

export const CreateMangaSchema = z.object({
  title: z.string().min(1), synopsis: z.string().default(''),
  language: LanguageSchema.default('en'), colorMode: ColorModeSchema.default('bw'),
  readingDirection: ReadingDirectionSchema.default('rtl'), stylePreset: z.string().default('manga-bw'),
  imageModel: ImageModelFieldSchema.default(null),
});
export const UpdateMangaSchema = z.object({
  title: z.string().min(1), synopsis: z.string(), language: LanguageSchema, colorMode: ColorModeSchema,
  readingDirection: ReadingDirectionSchema, pageFormat: PageFormatSchema, styleGuide: StyleGuideSchema,
  imageModel: ImageModelFieldSchema,
}).partial();
export const CreateCharacterSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema.default('supporting'), personality: z.string().default(''),
  speechStyle: z.string().default(''), appearanceTags: z.string().default(''),
  seed: z.number().int().min(0).optional(), recipe: z.string().nullable().default(null),
});
export const UpdateCharacterSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema, personality: z.string(), speechStyle: z.string(),
  appearanceTags: z.string(), seed: z.number().int().min(0), recipe: z.string().nullable(),
}).partial();
export const CreateChapterSchema = z.object({ title: z.string().min(1), synopsis: z.string().default(''), imageModel: ImageModelFieldSchema.default(null) });
export const UpdateChapterSchema = z.object({ title: z.string().min(1), synopsis: z.string(), summary: z.string(), number: z.number().int().min(1), status: ChapterStatusSchema, imageModel: ImageModelFieldSchema }).partial();
export const CreatePageSchema = z.object({ layoutPreset: z.string().default('2x2'), index: z.number().int().min(0).optional() });
export const ReorderSchema = z.object({ ids: z.array(IdSchema).min(1) });
export const ApplyPresetSchema = z.object({ preset: z.string(), confirm: z.boolean().default(false) });
export const SplitSchema = z.object({ panelId: IdSchema, dir: z.enum(['h', 'v']) });
export const MergeSchema = z.object({ panelIdA: IdSchema, panelIdB: IdSchema });
export const ResizeSchema = z.object({ path: z.array(z.enum(['a', 'b'])), ratio: z.number().gt(0).lt(1) });
export const UpdatePanelSchema = z.object({
  script: PanelScriptSchema, prompt: z.object({ scene: z.string(), negative: z.string() }),
  recipe: z.string().nullable(), seedLock: z.boolean(), seed: z.number().int().min(0),
  refCharacterIds: z.array(IdSchema), activeImageId: IdSchema.nullable(), imageTransform: ImageTransformSchema,
}).partial();
export const CreateFrameSchema = z.object({
  kind: FrameKindSchema, text: z.string().default(''), panelId: IdSchema.nullable().default(null),
  speakerId: IdSchema.nullable().default(null), box: BoxSchema.optional(), tail: PointSchema.nullable().optional(),
  rotation: z.number().default(0), font: z.string().optional(), fontSize: z.number().positive().optional(),
  autoFit: z.boolean().default(true), align: z.enum(['left', 'center', 'right']).default('center'),
});
export const UpdateFrameSchema = z.object({
  kind: FrameKindSchema, text: z.string(), panelId: IdSchema.nullable(), speakerId: IdSchema.nullable(),
  box: BoxSchema, tail: PointSchema.nullable(), rotation: z.number(), font: z.string().min(1),
  fontSize: z.number().positive(), autoFit: z.boolean(), align: z.enum(['left', 'center', 'right']), order: z.number().int().min(0),
}).partial();
export const PickImageSchema = z.object({ imageId: IdSchema });
export const GeneratePanelSchema = z.object({ recipe: z.string().optional(), seed: z.number().int().min(0).optional() });
export const PortraitsSchema = z.object({ n: z.number().int().min(1).max(8).default(4) });
export const SuggestAppearanceSchema = z.object({ description: z.string().min(1).max(4000) });
/** W1 Q2: an API start previews page 1 unless it says otherwise (the spec's default); a stored input without the key is off. */
export const StartEpisodeSchema = z.object({
  input: EpisodeInputSchema.extend({ previewFirst: z.boolean().default(true) }),
  mode: z.enum(['review', 'autopilot']).default('review'),
});
export const StepOutputSchema = z.object({ output: z.unknown() });
export const RerunStepSchema = z.object({ confirm: z.boolean().default(false) });
export const ExportSchema = z.object({
  target: z.object({ type: z.enum(['page', 'chapter']), id: IdSchema }),
  format: z.enum(['png', 'pdf']).default('pdf'), outDir: z.string().optional(),
});

export interface PageDetail { page: Page; panels: Panel[]; frames: TextFrame[]; images: Record<string, Image> /* active images by id */ }
export interface JobRef { jobId: string }
export interface JobRefs { jobIds: string[] }
export interface PresetInfo { name: string; panelCount: number }
export interface RecipeInfo { id: string; label: string; maxRefs: number; requiresRefs: boolean; supportsPose: boolean; supportsLineart: boolean; supportsLoras: boolean; supportsInit: boolean }
export interface ServiceState { ok: boolean; detail: string }
export interface ServiceStatus { claude: ServiceState; ollama: ServiceState; comfy: ServiceState; queue: { queued: number; running: number; pausedLanes: Array<{ lane: Lane; until: string | null; reason: string }> } }
export interface ApiErrorBody { error: { code: 'not_found' | 'validation' | 'conflict' | 'needs_confirm' | 'engine_unavailable' | 'forbidden' | 'internal'; message: string; details?: unknown } }

/** POST /api/queue/gpu/pause|resume (W1 R2). */
export interface QueueLanes { pausedLanes: ServiceStatus['queue']['pausedLanes'] }
/** GET /api/chapters/:id/render-missing (W1 R1): the story and cover panels without an active image, cover last. */
export interface MissingPanels { panelIds: string[] }
