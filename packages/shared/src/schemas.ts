import { z } from 'zod';

export const IdSchema = z.string().min(3);
export const LanguageSchema = z.enum(['en', 'uk']);
export const ColorModeSchema = z.enum(['bw', 'color']);
export const ReadingDirectionSchema = z.enum(['rtl', 'ltr']);
export type Language = z.infer<typeof LanguageSchema>;
export type ColorMode = z.infer<typeof ColorModeSchema>;
export type ReadingDirection = z.infer<typeof ReadingDirectionSchema>;

export const PageFormatSchema = z.object({
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  dpi: z.number().int().positive(),
  marginsMm: z.object({ top: z.number().min(0), bottom: z.number().min(0), inner: z.number().min(0), outer: z.number().min(0) }),
  gutterColMm: z.number().min(0),
  gutterRowMm: z.number().min(0),
  borderMm: z.number().min(0),
});
export type PageFormat = z.infer<typeof PageFormatSchema>;
export const DEFAULT_PAGE_FORMAT: PageFormat = {
  widthMm: 182, heightMm: 257, dpi: 300,
  marginsMm: { top: 12, bottom: 12, inner: 10, outer: 10 },
  gutterColMm: 3, gutterRowMm: 6, borderMm: 0.8,
};

/** `maleStrength` (style LoRAs only): the strength used when the subject or panel has a male human (styles.ts). */
export const LoraRefSchema = z.object({ name: z.string().min(1), strength: z.number().min(-2).max(2), maleStrength: z.number().min(-2).max(2).optional() });
export type LoraRef = z.infer<typeof LoraRefSchema>;
export const StyleGuideSchema = z.object({
  recipe: z.string().min(1),
  stylePrompt: z.string(),
  negativePrompt: z.string(),
  loras: z.array(LoraRefSchema),
});
export type StyleGuide = z.infer<typeof StyleGuideSchema>;

const Timestamps = { createdAt: z.string(), updatedAt: z.string() };

export const MangaSchema = z.object({
  id: IdSchema, title: z.string().min(1), synopsis: z.string(),
  language: LanguageSchema, colorMode: ColorModeSchema, readingDirection: ReadingDirectionSchema,
  pageFormat: PageFormatSchema, styleGuide: StyleGuideSchema,
  coverPageId: IdSchema.nullable(), ...Timestamps,
});
export type Manga = z.infer<typeof MangaSchema>;

export const CharacterRoleSchema = z.enum(['main', 'supporting', 'minor']);
export const RefSlotSchema = z.enum(['portrait', 'fullbody', 'side', 'back']);
export type RefSlot = z.infer<typeof RefSlotSchema>;
export const CharacterRefsSchema = z.object({
  portrait: IdSchema.optional(), fullbody: IdSchema.optional(), side: IdSchema.optional(), back: IdSchema.optional(),
});
export const CharacterSchema = z.object({
  id: IdSchema, mangaId: IdSchema, name: z.string().min(1), role: CharacterRoleSchema,
  personality: z.string(), speechStyle: z.string(), appearanceTags: z.string(),
  seed: z.number().int().min(0), recipe: z.string().nullable(), refs: CharacterRefsSchema, ...Timestamps,
});
export type Character = z.infer<typeof CharacterSchema>;

export const ChapterStatusSchema = z.enum(['draft', 'generating', 'ready']);
export const ChapterSchema = z.object({
  id: IdSchema, mangaId: IdSchema, number: z.number().int().min(1), title: z.string().min(1), synopsis: z.string(),
  /** W1 Q1: "what happened", written when an episode run finishes; the next chapters' premise and outline read it. */
  summary: z.string().default(''),
  coverPageId: IdSchema.nullable(), status: ChapterStatusSchema, order: z.number().int().min(0), ...Timestamps,
});
export type Chapter = z.infer<typeof ChapterSchema>;

export type SplitDir = 'h' | 'v';
/** 'h' = horizontal cut: a on top, b below. 'v' = vertical cut: a left, b right (absolute geometry). */
export type LayoutNode =
  | { type: 'panel'; id: string }
  | { type: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };
export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('panel'), id: IdSchema }),
    z.object({ type: z.literal('split'), dir: z.enum(['h', 'v']), ratio: z.number().gt(0).lt(1), a: LayoutNodeSchema, b: LayoutNodeSchema }),
  ]),
);

export const PageKindSchema = z.enum(['page', 'cover']);
export const PageSchema = z.object({
  id: IdSchema, mangaId: IdSchema, chapterId: IdSchema.nullable(), kind: PageKindSchema,
  order: z.number().int().min(0), layout: LayoutNodeSchema, ...Timestamps,
});
export type Page = z.infer<typeof PageSchema>;

export const ShotSchema = z.enum(['extreme-close', 'close', 'medium', 'wide', 'extreme-wide']);
export const AngleSchema = z.enum(['eye', 'low', 'high', 'dutch', 'overhead']);
export const StagePositionSchema = z.enum(['left', 'center', 'right']);
export const DialogueKindSchema = z.enum(['speech', 'thought', 'shout', 'narration', 'sfx']);
export type DialogueKind = z.infer<typeof DialogueKindSchema>;
export const PanelCharacterSchema = z.object({
  characterId: IdSchema, pose: z.string(), expression: z.string(), position: StagePositionSchema,
});
export const DialogueLineSchema = z.object({ speakerId: IdSchema.nullable(), kind: DialogueKindSchema, text: z.string().min(1) });
export type DialogueLine = z.infer<typeof DialogueLineSchema>;
export const PanelScriptSchema = z.object({
  action: z.string(), shot: ShotSchema, angle: AngleSchema,
  characters: z.array(PanelCharacterSchema), background: z.string(), dialogue: z.array(DialogueLineSchema),
});
export type PanelScript = z.infer<typeof PanelScriptSchema>;
export const EMPTY_SCRIPT: PanelScript = { action: '', shot: 'medium', angle: 'eye', characters: [], background: '', dialogue: [] };

/** x,y: offset of the image centre from the panel centre, in panel-normalized units. scale ≥ 1; 1 = cover-fit. */
export const ImageTransformSchema = z.object({ x: z.number(), y: z.number(), scale: z.number().min(1).max(8) });
export type ImageTransform = z.infer<typeof ImageTransformSchema>;
export const DEFAULT_TRANSFORM: ImageTransform = { x: 0, y: 0, scale: 1 };

export const PanelSchema = z.object({
  id: IdSchema, pageId: IdSchema, script: PanelScriptSchema,
  prompt: z.object({ scene: z.string(), negative: z.string() }),
  recipe: z.string().nullable(), seedLock: z.boolean(), seed: z.number().int().min(0),
  refCharacterIds: z.array(IdSchema), activeImageId: IdSchema.nullable(), imageTransform: ImageTransformSchema, ...Timestamps,
});
export type Panel = z.infer<typeof PanelSchema>;

export const FrameKindSchema = z.enum(['speech', 'thought', 'shout', 'narration', 'sfx', 'title']);
export type FrameKind = z.infer<typeof FrameKindSchema>;
/** Page-normalized box: 0..1 of page width/height. */
export const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
export type Box = z.infer<typeof BoxSchema>;
export const PointSchema = z.object({ x: z.number(), y: z.number() });
export const TextFrameSchema = z.object({
  id: IdSchema, pageId: IdSchema, panelId: IdSchema.nullable(), kind: FrameKindSchema, text: z.string(),
  speakerId: IdSchema.nullable(), box: BoxSchema, tail: PointSchema.nullable(), rotation: z.number(),
  font: z.string().min(1), fontSize: z.number().positive(), autoFit: z.boolean(),
  align: z.enum(['left', 'center', 'right']), order: z.number().int().min(0), ...Timestamps,
});
export type TextFrame = z.infer<typeof TextFrameSchema>;

export const ImageOwnerTypeSchema = z.enum(['character', 'panel']);
export const ImageSourceSchema = z.enum(['generated', 'uploaded', 'upscaled']);
export const GenParamsSchema = z.object({
  recipe: z.string(), prompt: z.string(), negative: z.string(), seed: z.number().int().min(0),
  steps: z.number().int().positive(), cfg: z.number(), width: z.number().int().positive(), height: z.number().int().positive(),
  loras: z.array(LoraRefSchema), refs: z.array(IdSchema),
  control: z.object({ kind: z.enum(['pose', 'lineart']), imageId: IdSchema, strength: z.number() }).nullable(),
  initImageId: IdSchema.nullable(), denoise: z.number().nullable(),
  comfyPromptId: z.string(), durationMs: z.number().int().min(0),
});
export type GenParams = z.infer<typeof GenParamsSchema>;
export const ReviewIssueKindSchema = z.enum(['character-count', 'identity', 'anatomy', 'text', 'script-mismatch', 'other']);
export type ReviewIssueKind = z.infer<typeof ReviewIssueKindSchema>;
export const ReviewResultSchema = z.object({
  engine: z.enum(['claude', 'local']), pass: z.boolean(),
  // `fix` (M4 final S1): the picture as it should be, for the retry prompt; reviews stored before it have none.
  issues: z.array(z.object({ kind: ReviewIssueKindSchema, note: z.string(), fix: z.string().optional() })), at: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export const ImageSchema = z.object({
  id: IdSchema, mangaId: IdSchema, ownerType: ImageOwnerTypeSchema, ownerId: IdSchema, role: RefSlotSchema.nullable(),
  path: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(),
  source: ImageSourceSchema, parentImageId: IdSchema.nullable(), gen: GenParamsSchema.nullable(),
  review: ReviewResultSchema.nullable(), createdAt: z.string(),
});
export type Image = z.infer<typeof ImageSchema>;

export const JobKindSchema = z.enum(['image.generate', 'image.review', 'image.upscale', 'character.refs', 'llm.step', 'export.render']);
export type JobKind = z.infer<typeof JobKindSchema>;
export const LaneSchema = z.enum(['gpu', 'claude', 'cpu']);
export type Lane = z.infer<typeof LaneSchema>;
export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const JobProgressSchema = z.object({ label: z.string(), value: z.number().optional(), max: z.number().optional() });
export type JobProgress = z.infer<typeof JobProgressSchema>;
export const JobSchema = z.object({
  id: IdSchema, kind: JobKindSchema, lane: LaneSchema, status: JobStatusSchema, priority: z.number().int(),
  payload: z.unknown(), result: z.unknown().nullable(), error: z.string().nullable(),
  attempts: z.number().int().min(0), maxAttempts: z.number().int().min(1), nextRunAt: z.string(),
  progress: JobProgressSchema.nullable(), episodeRunId: IdSchema.nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const EpisodeStepNameSchema = z.enum(['premise', 'outline', 'breakdown', 'scripts', 'prompts', 'render', 'lettering']);
export type EpisodeStepName = z.infer<typeof EpisodeStepNameSchema>;
export const EPISODE_STEPS: EpisodeStepName[] = ['premise', 'outline', 'breakdown', 'scripts', 'prompts', 'render', 'lettering'];
export const REVIEW_POINTS: ReadonlySet<EpisodeStepName> = new Set(['outline', 'scripts', 'render', 'lettering']);
export const StepStatusSchema = z.enum(['pending', 'running', 'awaiting-review', 'done', 'failed', 'paused']);
export const EpisodeStepSchema = z.object({
  name: EpisodeStepNameSchema, status: StepStatusSchema, output: z.unknown().nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type EpisodeStep = z.infer<typeof EpisodeStepSchema>;
export const EpisodeInputSchema = z.object({
  prompt: z.string().min(1), characterIds: z.array(IdSchema).default([]),
  pages: z.number().int().min(1).max(30).default(8), tone: z.string().default(''),
  /** W1 Q2: render the cover and page 1 first, then wait. Absent on runs stored before W1, which means off. */
  previewFirst: z.boolean().optional(),
});
export type EpisodeInput = z.infer<typeof EpisodeInputSchema>;
export const EpisodeRunStatusSchema = z.enum(['running', 'awaiting-review', 'done', 'failed', 'cancelled', 'paused']);
/**
 * A live run (M4 final M10, the one definition): running, waiting at a review point, or paused (W1 C1: a paused run is
 * live too, so a chapter still has one live run); the others have ended. The
 * server refuses a second live run per chapter, the UI shows the run controls, and the CLI's --wait stops at a review
 * point or an end.
 */
export const EPISODE_ACTIVE_STATUSES: ReadonlySet<z.infer<typeof EpisodeRunStatusSchema>> = new Set(['running', 'awaiting-review', 'paused']);
export const EpisodeRunSchema = z.object({
  id: IdSchema, chapterId: IdSchema, input: EpisodeInputSchema, mode: z.enum(['review', 'autopilot']),
  steps: z.array(EpisodeStepSchema), currentStep: z.number().int().min(0), status: EpisodeRunStatusSchema,
  /**
   * W1 Q1 (review M8): the chapter summary this run wrote when it finished; null or absent when it wrote none. A later
   * summary replaces the chapter's summary only when it is empty or one a run of the chapter wrote, never a user's edit.
   */
  chapterSummary: z.string().nullish(),
  ...Timestamps,
});
export type EpisodeRun = z.infer<typeof EpisodeRunSchema>;

export const TaskSchema = z.enum(['story', 'prompts', 'dialogue', 'review']);
export type Task = z.infer<typeof TaskSchema>;
export const EngineNameSchema = z.enum(['claude', 'local']);
export type EngineName = z.infer<typeof EngineNameSchema>;
export const SettingsSchema = z.object({
  engine: z.object({
    mode: EngineNameSchema,
    tasks: z.object({ story: EngineNameSchema.optional(), prompts: EngineNameSchema.optional(), dialogue: EngineNameSchema.optional(), review: EngineNameSchema.optional() }),
  }),
  claude: z.object({ models: z.object({ story: z.string(), dialogue: z.string(), prompts: z.string(), review: z.string() }) }),
  ollama: z.object({ textModel: z.string(), visionModel: z.string() }),
  review: z.object({ autoInEpisode: z.boolean(), rounds: z.number().int().min(0).max(5) }),
  episode: z.object({ confirmRenderMinutes: z.number().int().min(1).max(1440) }),
  routing: z.object({
    noChars: z.string(), oneChar: z.string(), multiChar: z.string(),
    bwRefine: z.string().nullable(), driftFallback: z.string(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  engine: { mode: 'claude', tasks: {} },
  claude: { models: { story: 'opus', dialogue: 'opus', prompts: 'sonnet', review: 'sonnet' } },
  ollama: { textModel: 'qwen3:14b', visionModel: 'qwen3-vl:8b' },
  review: { autoInEpisode: true, rounds: 2 },
  episode: { confirmRenderMinutes: 45 },
  routing: { noChars: 'anime', oneChar: 'anime-ref', multiChar: 'klein-ref', bwRefine: null, driftFallback: 'qwen-edit-ref' },
};
/** Each top-level section is optional; within a section every key is optional. `engine.tasks` is replaced whole. */
export const SettingsPatchSchema = z.object({
  engine: z.object({ mode: EngineNameSchema, tasks: SettingsSchema.shape.engine.shape.tasks }).partial().optional(),
  claude: z.object({ models: SettingsSchema.shape.claude.shape.models.partial() }).partial().optional(),
  ollama: SettingsSchema.shape.ollama.partial().optional(),
  review: SettingsSchema.shape.review.partial().optional(),
  routing: SettingsSchema.shape.routing.partial().optional(),
  episode: SettingsSchema.shape.episode.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const AppConfigSchema = z.object({
  libraryPath: z.string(), port: z.number().int().default(4317),
  comfyRoot: z.string().default('C:/Users/roman/Dev/Exalink/claude-image-gen'),
  comfyUrl: z.string().default('http://127.0.0.1:8188'),
  ollamaUrl: z.string().default('http://127.0.0.1:11434'),
  claudeBin: z.string().default('claude'),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
