import { z } from 'zod';
import { NewCharacterDraftSchema, MAX_NEW_CHARACTERS, formatEstimate, estimateChapter, sameName } from './episode.js';
import { DirectiveSchema, directivesOfChapter, type Directive } from './directives.js';
import { ImageModelFieldSchema } from './image-models.js';
import {
  ColorModeSchema, IdSchema, LanguageSchema, ReadingDirectionSchema,
  type ColorMode, type Settings,
} from './schemas.js';

/**
 * Auto-created manga (spec: "manga from a prompt"). One brief, a chapter count and pages per chapter; the server plans the
 * series, creates the cast, a poster and every chapter (each one an episode run with its own cover) without waiting for
 * anyone. The brief is free text: plot AND notes ("simplistic art style", "no romance", "short punchy dialogue").
 */
export const MAX_AUTO_CHAPTERS = 20;
export const AUTO_PORTRAITS_PER_CHARACTER = 2;
/** The title a manga gets while the plan has not named it: any other title is the user's and is kept. */
export const MANGA_TITLE_FROM_PLAN = 'Untitled manga';

export const AutoMangaInputSchema = z.object({
  /** Plot and notes in one text; the planner separates them. */
  brief: z.string().trim().min(1),
  chapters: z.number().int().min(1).max(MAX_AUTO_CHAPTERS).default(3),
  pagesPerChapter: z.number().int().min(1).max(30).default(8),
  /** Blank: the plan names the manga. */
  title: z.string().trim().default(''),
  language: LanguageSchema.default('en'),
  /** Omitted: the style preset's own colour mode. */
  colorMode: ColorModeSchema.optional(),
  readingDirection: ReadingDirectionSchema.default('rtl'),
  stylePreset: z.string().default('manga-bw'),
  /** The image model of the whole manga (null: Settings' routing). */
  imageModel: ImageModelFieldSchema.default(null),
  /** Per chapter, in order (index 0 = chapter 1): its own image model, null to inherit the manga's. Shorter than `chapters` is fine. */
  chapterModels: z.array(ImageModelFieldSchema).max(MAX_AUTO_CHAPTERS).default([]),
  /** Draw a poster for the manga (chapter covers are always drawn by their episodes). */
  poster: z.boolean().default(true),
});
export type AutoMangaInput = z.infer<typeof AutoMangaInputSchema>;

// ---- the plan: the first, and only free-form, LLM step ----
export const PlanChapterSchema = z.object({ title: z.string().trim().min(1), synopsis: z.string().trim().min(1), plot: z.string().trim().min(1) });
export type PlanChapter = z.infer<typeof PlanChapterSchema>;
/** Where the plan applies a directive: the cast, the manga's look, the notes every chapter gets, or the chapters named. */
export const PlanCoverageSchema = z.object({
  id: z.string().min(1), where: z.enum(['cast', 'style', 'notes', 'chapters']), chapters: z.array(z.number().int().min(1)).default([]),
});
export type PlanCoverage = z.infer<typeof PlanCoverageSchema>;
/** What the plan call answers; the run adds the directives (the ledger) it was written from. */
export const MangaPlanAnswerSchema = z.object({
  title: z.string().trim().min(1),
  synopsis: z.string().trim().min(1),
  /** 2–5 comma-separated words, for every chapter's premise. */
  tone: z.string().default(''),
  /** What the brief asked for besides the story, in the book language (pacing, content to avoid, dialogue style…). Never about looks. */
  notes: z.string().default(''),
  /** English Danbooru-style tags for the look the brief asked for; '' when it asked for none. Added to the manga's style prompt. */
  styleTags: z.string().default(''),
  /** English tags to avoid, added to the manga's negative prompt. */
  negativeTags: z.string().default(''),
  characters: z.array(NewCharacterDraftSchema).min(1).max(MAX_NEW_CHARACTERS),
  chapters: z.array(PlanChapterSchema).min(1).max(MAX_AUTO_CHAPTERS),
  /** The series poster: one striking moment with the leads, in the book language. */
  poster: z.object({ action: z.string().trim().min(1), background: z.string().default('') }),
  /** For every directive: where the plan applies it (every `must` one needs an entry; the schema refuses a plan that drops one). */
  coverage: z.array(PlanCoverageSchema).default([]),
});
export type MangaPlanAnswer = z.infer<typeof MangaPlanAnswerSchema>;
export const MangaPlanSchema = MangaPlanAnswerSchema.extend({ directives: z.array(DirectiveSchema).default([]) });
export type MangaPlan = z.infer<typeof MangaPlanSchema>;
export interface MangaPlanRules { chapters: number; directives?: readonly Directive[] }

/**
 * Refined so a wrong chapter count, a repeated name, or a requirement of the brief the plan does not account for goes through
 * the engine's correction round.
 */
export function mangaPlanSchemaFor(rules: MangaPlanRules): z.ZodType<MangaPlanAnswer> {
  return MangaPlanAnswerSchema.superRefine((value, ctx) => {
    const known = new Set((rules.directives ?? []).map((d) => d.id));
    value.coverage.forEach((c, i) => {
      if (!known.has(c.id)) ctx.addIssue({ code: 'custom', path: ['coverage', i, 'id'], message: `unknown directive "${c.id}"; use one of: ${[...known].join(', ') || '(none)'}` });
      if (c.where === 'chapters' && (c.chapters.length === 0 || c.chapters.some((n) => n > rules.chapters))) {
        ctx.addIssue({ code: 'custom', path: ['coverage', i, 'chapters'], message: `directive ${c.id}: "chapters" needs chapter numbers from 1 to ${rules.chapters}` });
      }
    });
    const covered = new Set(value.coverage.map((c) => c.id));
    const dropped = (rules.directives ?? []).filter((d) => d.must && !covered.has(d.id));
    if (dropped.length > 0) {
      ctx.addIssue({
        code: 'custom', path: ['coverage'],
        message: `the plan must account for every "must" directive; missing in "coverage": ${dropped.map((d) => `${d.id} (${d.text})`).join('; ')}. Apply each one in the cast, the chapters' plots, "styleTags" or "notes", then list it in "coverage"`,
      });
    }
    if (value.chapters.length !== rules.chapters) {
      ctx.addIssue({ code: 'custom', path: ['chapters'], message: `expected exactly ${rules.chapters} chapters, got ${value.chapters.length}` });
    }
    value.characters.forEach((c, i) => {
      if (value.characters.findIndex((o) => sameName(o.name, c.name)) !== i) {
        ctx.addIssue({ code: 'custom', path: ['characters', i, 'name'], message: `duplicate character "${c.name}"` });
      }
    });
  });
}

// ---- the run ----
export const AutoRunStatusSchema = z.enum(['running', 'done', 'failed', 'cancelled']);
export type AutoRunStatus = z.infer<typeof AutoRunStatusSchema>;
/** In order; `done` only with status done. */
export const AUTO_STAGES = ['plan', 'portraits', 'poster', 'chapters', 'done'] as const;
export const AutoStageSchema = z.enum(AUTO_STAGES);
export type AutoStage = z.infer<typeof AutoStageSchema>;
export const AutoRunSchema = z.object({
  id: IdSchema, mangaId: IdSchema, input: AutoMangaInputSchema,
  status: AutoRunStatusSchema, stage: AutoStageSchema,
  plan: MangaPlanSchema.nullable(),
  /** The chapters the plan created, in order. */
  chapterIds: z.array(IdSchema),
  /** The index into chapterIds being written (0-based). */
  currentChapter: z.number().int().min(0),
  error: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type AutoRun = z.infer<typeof AutoRunSchema>;
export const AUTO_ACTIVE_STATUSES: ReadonlySet<AutoRunStatus> = new Set(['running']);

export const StartAutoMangaSchema = z.object({ input: AutoMangaInputSchema });

/** The chapter's image model for chapter number `n` (1-based) of a new manga: its own, else the manga's. */
export function chapterModelFor(input: Pick<AutoMangaInput, 'imageModel' | 'chapterModels'>, n: number): string | null {
  return input.chapterModels[n - 1] ?? input.imageModel;
}

/** The text of the brief that every chapter's episode starts from: this chapter's slice of the plan. */
export function chapterPrompt(plan: Pick<MangaPlan, 'title'>, chapter: PlanChapter, n: number, total: number): string {
  const position = n === total ? (total === 1 ? 'the only chapter' : 'the final chapter: resolve the story') : `chapter ${n} of ${total}`;
  return `${plan.title}, ${position}: "${chapter.title}". ${chapter.plot}`;
}

/** Seconds and panels of the whole manga, each chapter at its own image model (the Create dialog shows it before the start). */
export function estimateManga(
  input: Pick<AutoMangaInput, 'chapters' | 'pagesPerChapter' | 'imageModel' | 'chapterModels'>, settings: Settings, colorMode?: ColorMode,
): { panels: number; seconds: number } {
  let panels = 0;
  let seconds = 0;
  for (let n = 1; n <= input.chapters; n++) {
    const one = estimateChapter(input.pagesPerChapter, settings, colorMode, chapterModelFor(input, n));
    panels += one.panels;
    seconds += one.seconds;
  }
  return { panels, seconds };
}

/** "3 chapters × 8 pages ≈ 108 panels ≈ 1 h 50 min" */
export function formatMangaEstimate(
  input: Pick<AutoMangaInput, 'chapters' | 'pagesPerChapter' | 'imageModel' | 'chapterModels'>, settings: Settings, colorMode?: ColorMode,
): string {
  const { panels, seconds } = estimateManga(input, settings, colorMode);
  return `${input.chapters} ${input.chapters === 1 ? 'chapter' : 'chapters'} × ${input.pagesPerChapter} ${input.pagesPerChapter === 1 ? 'page' : 'pages'} ≈ ${panels} panels ≈ ${formatEstimate(seconds).replace(/^~/, '')}`;
}

/**
 * The directives one chapter of a planned manga is written from: those that name it, those the plan applies to its chapters, and
 * those for the whole series (the cast, the look, the notes), so a character's details and "no romance" reach every chapter and a
 * plot detail only the chapters it belongs to.
 */
export function planChapterDirectives(plan: Pick<MangaPlan, 'directives' | 'coverage'>, chapter: number): Directive[] {
  const where = new Map(plan.coverage.map((c) => [c.id, c]));
  return directivesOfChapter(plan.directives, chapter).filter((d) => {
    const c = where.get(d.id);
    return d.chapters.length > 0 || c === undefined || c.where !== 'chapters' || c.chapters.includes(chapter);
  });
}
