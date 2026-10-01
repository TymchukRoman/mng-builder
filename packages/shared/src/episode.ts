// packages/shared/src/episode.ts
import { z } from 'zod';
import { PRESET_NAMES, presetPanelCount } from './layout/index.js';
import {
  AngleSchema, CharacterRoleSchema, DialogueKindSchema, EPISODE_STEPS, ShotSchema, StagePositionSchema,
  type ColorMode, type EpisodeRun, type EpisodeStepName, type Settings, type Task,
} from './schemas.js';

/** Trim, collapse inner whitespace, lower-case (works for Cyrillic). */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

export function stepIndex(name: EpisodeStepName): number {
  return EPISODE_STEPS.indexOf(name);
}

/**
 * M4 final M6: the title a chapter gets when the user leaves it for the AI to fill (the New chapter dialog's Title is
 * optional while it has an AI prompt). Chapter titles cannot be empty, so this known text stands for "not typed by
 * the user": the premise step replaces it. Any other title is the user's and is never overwritten.
 */
export const CHAPTER_TITLE_FROM_PREMISE = 'Untitled chapter';

// ---- 1. premise ----
export const PremiseOutputSchema = z.object({
  title: z.string().min(1), synopsis: z.string().min(1), tone: z.string(), setting: z.string(),
});
export type PremiseOutput = z.infer<typeof PremiseOutputSchema>;

// ---- 2. outline ----
export const OutlineSceneSchema = z.object({
  summary: z.string().min(1), purpose: z.string(), location: z.string(), characterNames: z.array(z.string().min(1)),
});
export type OutlineScene = z.infer<typeof OutlineSceneSchema>;
/** Names are trimmed at the schema (M4 final M1): a whitespace-only name is refused where it is edited, not at approve. */
export const NewCharacterDraftSchema = z.object({
  name: z.string().trim().min(1), role: CharacterRoleSchema, personality: z.string(), speechStyle: z.string(), appearanceTags: z.string().min(1),
});
export type NewCharacterDraft = z.infer<typeof NewCharacterDraftSchema>;
/** The most new characters one outline may add (an adaptation brings its cast along); the outline prompt says the same. */
export const MAX_NEW_CHARACTERS = 8;
export const OutlineOutputSchema = z.object({
  scenes: z.array(OutlineSceneSchema).min(1), newCharacters: z.array(NewCharacterDraftSchema).max(MAX_NEW_CHARACTERS),
});
export type OutlineOutput = z.infer<typeof OutlineOutputSchema>;
export interface OutlineRules { knownNames: string[] }

/**
 * Closes the cast at the source: every scene's characterNames entry is a character the manga has or one this answer
 * adds in newCharacters. Otherwise the scripts step would meet names no character carries (an adaptation's cast
 * assumed to exist), and the refined schema sends the model through the correction round here instead.
 */
export function outlineSchemaFor(rules: OutlineRules): z.ZodType<OutlineOutput> {
  return OutlineOutputSchema.superRefine((value, ctx) => {
    const names = [...rules.knownNames, ...value.newCharacters.map((c) => c.name)];
    value.scenes.forEach((scene, i) => {
      scene.characterNames.forEach((name, k) => {
        if (names.some((n) => sameName(n, name))) return;
        ctx.addIssue({
          code: 'custom', path: ['scenes', i, 'characterNames', k],
          message: `unknown character "${name}": add "${name}" to newCharacters (with appearanceTags) or remove it; groups and crowds are not characters`,
        });
      });
    });
  });
}

// ---- 3. breakdown ----
export const BreakdownPageSchema = z.object({
  sceneIdx: z.array(z.number().int().min(0)).min(1),
  panelCount: z.number().int().min(1).max(9),
  pacing: z.string(),
  layoutPreset: z.string().min(1),
});
export type BreakdownPage = z.infer<typeof BreakdownPageSchema>;
export const BreakdownOutputSchema = z.object({ pages: z.array(BreakdownPageSchema).min(1).max(30) });
export type BreakdownOutput = z.infer<typeof BreakdownOutputSchema>;
export interface BreakdownRules { pages: number; sceneCount: number }

/** Refined so a violation goes through the engine's correction round (spec §8: preset must exist and match panelCount). */
export function breakdownSchemaFor(rules: BreakdownRules): z.ZodType<BreakdownOutput> {
  return BreakdownOutputSchema.superRefine((value, ctx) => {
    if (value.pages.length !== rules.pages) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `expected exactly ${rules.pages} pages, got ${value.pages.length}` });
    }
    value.pages.forEach((page, i) => {
      if (!PRESET_NAMES.includes(page.layoutPreset)) {
        ctx.addIssue({
          code: 'custom', path: ['pages', i, 'layoutPreset'],
          message: `unknown layout preset "${page.layoutPreset}"; use one of: ${PRESET_NAMES.join(', ')}`,
        });
      } else {
        const count = presetPanelCount(page.layoutPreset);
        if (count !== page.panelCount) {
          ctx.addIssue({
            code: 'custom', path: ['pages', i, 'panelCount'],
            message: `layout "${page.layoutPreset}" has ${count} panels but panelCount is ${page.panelCount}`,
          });
        }
      }
      page.sceneIdx.forEach((s, j) => {
        if (s >= rules.sceneCount) {
          ctx.addIssue({
            code: 'custom', path: ['pages', i, 'sceneIdx', j],
            message: `scene index ${s} does not exist (the outline has ${rules.sceneCount} scenes, numbered from 0)`,
          });
        }
      });
    });
  });
}

// ---- 4. scripts (names, not ids; mapped to ids on materialization) ----
export const PanelCharacterDraftSchema = z.object({
  name: z.string().min(1), pose: z.string(), expression: z.string(), position: StagePositionSchema,
});
/** Models often emit "" (or whitespace) for a narration/sfx speaker; that means no speaker. */
const SpeakerSchema = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().min(1).nullable());
export const DialogueDraftSchema = z.object({ speaker: SpeakerSchema, kind: DialogueKindSchema, text: z.string().min(1) });
export const PanelScriptDraftSchema = z.object({
  action: z.string().min(1), shot: ShotSchema, angle: AngleSchema,
  characters: z.array(PanelCharacterDraftSchema).max(4), background: z.string(), dialogue: z.array(DialogueDraftSchema).max(6),
});
export type PanelScriptDraft = z.infer<typeof PanelScriptDraftSchema>;
export const ScriptsOutputSchema = z.object({ pages: z.array(z.object({ panels: z.array(PanelScriptDraftSchema).min(1) })).min(1) });
export type ScriptsOutput = z.infer<typeof ScriptsOutputSchema>;
export interface ScriptsRules {
  panelCounts: number[];
  knownNames: string[];
  /**
   * An LLM answer (true): only the page count is checked (pages cannot be invented). A name outside knownNames is not an
   * error (materialization drops it from the panel's cast and nulls its speaker), and neither is a page whose panel count
   * differs from panelCounts (materialization picks a layout with that many panels). One stray detail never fails the
   * step. A user edit (false) stays strict, so a typo or a missing panel is caught.
   */
  lenient?: boolean;
  /** Where panelCounts come from, for the messages: "the breakdown" (default) or, for an edit of materialized pages, "its page layout". */
  panelSource?: string;
  /** For a chunk of the chapter (scripts run in page chunks): pages before it, so messages name absolute page numbers. */
  pageOffset?: number;
}

export function scriptsSchemaFor(rules: ScriptsRules): z.ZodType<ScriptsOutput> {
  const known = (name: string): boolean => rules.knownNames.some((k) => sameName(k, name));
  const valid = rules.knownNames.join(', ') || '(none — this manga has no characters, so use no characters and null speakers)';
  return ScriptsOutputSchema.superRefine((value, ctx) => {
    const offset = rules.pageOffset ?? 0;
    const want = rules.panelCounts.length;
    if (value.pages.length !== want) {
      const source = offset === 0 ? 'from the breakdown' : `pages ${offset + 1}–${offset + want} of the breakdown`;
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `expected exactly ${want} pages (${source}), got ${value.pages.length}` });
    }
    if (rules.lenient) return;
    const from = rules.panelSource ?? 'the breakdown';
    value.pages.forEach((page, i) => {
      const panels = rules.panelCounts[i];
      if (panels !== undefined && page.panels.length !== panels) {
        ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels'], message: `page ${offset + i + 1} needs exactly ${panels} panels (from ${from}), got ${page.panels.length}` });
      }
      page.panels.forEach((p, j) => {
        p.characters.forEach((c, k) => {
          if (!known(c.name)) ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels', j, 'characters', k, 'name'], message: `unknown character "${c.name}"; use one of: ${valid}` });
        });
        p.dialogue.forEach((d, k) => {
          if (d.speaker !== null && !known(d.speaker)) {
            ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels', j, 'dialogue', k, 'speaker'], message: `unknown character "${d.speaker}"; use one of: ${valid}` });
          }
        });
      });
    });
  });
}

// ---- 5. prompts ----
export const PromptsOutputSchema = z.object({
  // `negative` is an optional string (null reads as absent). Written as a preprocess, not a transform, so its JSON Schema
  // stays {"type":"string"} and optional: a transform made it {} and required, and the local engine's constrained
  // decoding then let the model put an object there (Roman's run: "negative": {"extra people": "extra people"}).
  panels: z.array(z.object({
    panelId: z.string().min(3), scene: z.string().min(1), negative: z.preprocess((v) => v ?? undefined, z.string().optional()),
  })).min(1),
});
export type PromptsOutput = z.infer<typeof PromptsOutputSchema>;
export interface PromptsRules {
  panelIds: string[];
  /**
   * An LLM answer's request (true): a scene with Cyrillic or without Latin text is an issue, so the correction round
   * asks again (image models read only English; a Ukrainian book's model may follow the Ukrainian script). A user
   * edit (false) is stored verbatim.
   */
  englishScenes?: boolean;
}

/** Image models read English only: a scene needs Latin letters and no Cyrillic. */
export function isEnglishScene(text: string): boolean {
  return !/\p{Script=Cyrillic}/u.test(text) && /[a-z]/i.test(text);
}

export const ENGLISH_SCENE_MESSAGE = 'scene must be English (Danbooru-style tags or plain English sentences as asked), with no Cyrillic and no character names';

export function promptsSchemaFor(rules: PromptsRules): z.ZodType<PromptsOutput> {
  const allowed = new Set(rules.panelIds);
  return PromptsOutputSchema.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.panels.forEach((p, i) => {
      if (rules.englishScenes && !isEnglishScene(p.scene)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'scene'], message: ENGLISH_SCENE_MESSAGE });
      if (seen.has(p.panelId)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'panelId'], message: `duplicate panelId "${p.panelId}"` });
      else if (!allowed.has(p.panelId)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'panelId'], message: `unknown panelId "${p.panelId}"; use one of: ${rules.panelIds.join(', ')}` });
      seen.add(p.panelId);
    });
    const missing = rules.panelIds.filter((id) => !seen.has(id));
    if (missing.length > 0) ctx.addIssue({ code: 'custom', path: ['panels'], message: `missing panelIds: ${missing.join(', ')}` });
  });
}

// ---- 6. render, 7. lettering (informational outputs) ----
export const RenderOutputSchema = z.object({
  jobs: z.array(z.string()), reviewed: z.number().int().min(0), flagged: z.number().int().min(0), rounds: z.number().int().min(0),
  /**
   * W1 R1: panels whose render failed in this step, plus any still without an image. A panel re-rendered on a re-run may
   * keep its older image and still be listed. Outputs stored before W1 have none.
   */
  failedPanelIds: z.array(z.string()).default([]),
  /** W1 Q2, the preview stop: the cover and page 1 are rendered; `remainingPanels` wait for Continue. */
  preview: z.literal(true).optional(),
  remainingPanels: z.number().int().min(0).optional(),
  /** W1 C2, the size stop: nothing is rendered yet; `panels` wait for Continue. */
  confirm: z.literal(true).optional(),
  panels: z.number().int().min(0).optional(),
  /**
   * Both stops: the expected seconds of the panels that wait (review rounds included). The size stop leaves out any portrait
   * the Continue still has to generate.
   */
  estimateSeconds: z.number().min(0).optional(),
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;
export type RenderGate = 'preview' | 'confirm';

/** W1 Q2/C2: which stop a render step output is, or null (a finished render, or not a render output at all). */
export function renderGate(output: unknown): RenderGate | null {
  const parsed = RenderOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  if (parsed.data.preview === true) return 'preview';
  return parsed.data.confirm === true ? 'confirm' : null;
}
/**
 * W1 F20: the question a run asks while its render step waits at the preview or size stop, or null. The UI's status text and
 * the CLI's run line both show it, so a `--wait` run that stopped there says how much is left and how long it takes.
 */
export function gateText(run: EpisodeRun): string | null {
  const at = stepIndex('render');
  const step = run.steps[at];
  if (run.status !== 'awaiting-review' || run.currentStep !== at || !step) return null;
  // Task 7 minor 5: one parse (renderGate's rules); a count the output lacks is left out rather than shown as 0.
  const parsed = RenderOutputSchema.safeParse(step.output);
  if (!parsed.success) return null;
  const out = parsed.data;
  const est = formatEstimate(out.estimateSeconds ?? 0);
  if (out.preview === true) {
    return `Page 1 is ready — continue with ${out.remainingPanels !== undefined ? `${out.remainingPanels} panels` : 'the rest'} (${est})?`;
  }
  if (out.confirm === true) return `Render ${out.panels !== undefined ? `${out.panels} panels` : 'the chapter'} (${est})?`;
  return null;
}
export const LetteringOutputSchema = z.object({ frames: z.number().int().min(0) });
export type LetteringOutput = z.infer<typeof LetteringOutputSchema>;

/** Spec §8 "Task(s)". scripts writes all the dialogue, so it runs as 'dialogue' (keeps the Settings dialogue engine/model live). render/lettering are not LLM steps. */
export const STEP_TASK: Record<EpisodeStepName, Task | null> = {
  premise: 'story', outline: 'story', breakdown: 'story', scripts: 'dialogue', prompts: 'prompts', render: null, lettering: null,
};

export const EDITABLE_STEPS: ReadonlySet<EpisodeStepName> = new Set<EpisodeStepName>(['premise', 'outline', 'breakdown', 'scripts', 'prompts']);

/**
 * M4 final M2: an outline or breakdown drives only the step after it (outline acceptance creates the characters; the
 * breakdown shapes the scripts). Once done, it can be edited only while that next step is still pending; after that,
 * an edit would change nothing or desync the run, so the server answers 409 with this message.
 */
export const EDIT_NEEDS_PENDING_NEXT: ReadonlySet<EpisodeStepName> = new Set<EpisodeStepName>(['outline', 'breakdown']);
export const EDIT_TOO_LATE_MESSAGE = 'Re-run from this step instead';

// ---- render-time estimate (spec §8: "panels × recipe average") ----
/**
 * Seconds per image, seeded from the live timings (M2 Task 24 live check / P1 bake-off):
 * anime-ref ~32 s per panel incl. ComfyUI overhead; anime ~30 s; qwen-edit-ref 115-135 s (8 steps x 11-13 s + model load);
 * klein-ref 6.5 s, anima 21.7 s, anima-turbo 3.8 s from the bake-off, each + ~10 s overhead; upscale ~10 s.
 * anime-pose and anime-refine are assumed, not measured. (A character portrait is ~15 s; it is not a panel recipe.)
 * The default routing (Roman's mixed-routing choice, 2026-09-30) sends multi-character panels to klein-ref (17 s) and keeps
 * qwen-edit-ref (125 s) for the identity-drift retry.
 */
export const RECIPE_AVG_SECONDS: Record<string, number> = {
  anime: 30, 'anime-ref': 32, 'anime-pose': 32 /* assumed, not measured */, 'anime-refine': 20 /* assumed, not measured */, 'qwen-edit-ref': 125, 'klein-ref': 17, anima: 32, 'anima-turbo': 14, upscale: 10,
};
export const DEFAULT_RECIPE_SECONDS = 20;

export function estimateSeconds(recipes: Array<string | null>): number {
  return recipes.reduce((sum, r) => sum + (r !== null ? RECIPE_AVG_SECONDS[r] ?? DEFAULT_RECIPE_SECONDS : DEFAULT_RECIPE_SECONDS), 0);
}

/**
 * M4 final S5: the review rounds of the render step. No live M2 review timing is stored, so these are constants:
 * one review takes ~10 s (Task 22 live smoke: Claude reviews took 6–15 s each), and about half of the images are
 * flagged per round (assumed: the smoke flagged 2–4 of 6 per round). Revisit with more live runs.
 */
export const REVIEW_AVG_SECONDS = 10;
export const REVIEW_RETRY_SHARE = 0.5;

/**
 * The expected extra seconds of `rounds` review rounds over `images` images that take `renderSeconds` to render:
 * round 1 reviews every image; in round k a REVIEW_RETRY_SHARE^k share is re-rendered and, before the last round
 * ends, reviewed again (the render step does not review the last round's re-renders).
 */
export function estimateReviewSeconds(renderSeconds: number, images: number, rounds: number): number {
  if (rounds <= 0 || images <= 0) return 0;
  let total = images * REVIEW_AVG_SECONDS;
  for (let k = 1; k <= rounds; k++) {
    const share = REVIEW_RETRY_SHARE ** k;
    total += share * renderSeconds + (k < rounds ? share * images * REVIEW_AVG_SECONDS : 0);
  }
  return total;
}

/** Rounds first, then picks the unit, so a value never renders as "~60 s" / "~60 min" / "1 h 60 min". 0 renders "~0 s" (a real, empty estimate). */
export function formatEstimate(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `~${Math.max(0, s)} s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
}

/** W1 C2: the panels a page typically gets (the breakdown prompt aims for 3–5 per page). */
export const TYPICAL_PANELS_PER_PAGE = 4.5;

/**
 * The recipes that take natural-language prompts (the server's promptStyleFor: the qwen and flux2 families). A black-and-white
 * book adds the `routing.bwRefine` pass after each of them (the server's refineFor). A server test keeps the two in step.
 */
export const NATURAL_PROMPT_RECIPES: ReadonlySet<string> = new Set(['qwen-edit-ref', 'klein-ref']);

/**
 * W1 C2: the render time of a chapter not broken down yet: pages × TYPICAL_PANELS_PER_PAGE panels, each at the mean of the
 * three routed recipes (no characters, one, several), plus the review rounds when episodes review their images. Task 2 M4:
 * for a black-and-white book (`colorMode` 'bw') a routed natural-prompt recipe also counts the `routing.bwRefine` pass, as
 * the server's estimateRender does.
 */
export function estimateChapter(pages: number, settings: Settings, colorMode?: ColorMode): { panels: number; seconds: number } {
  const panels = Math.round(pages * TYPICAL_PANELS_PER_PAGE);
  const { noChars, oneChar, multiChar, bwRefine } = settings.routing;
  const refine = (recipe: string): string[] =>
    colorMode === 'bw' && bwRefine !== null && NATURAL_PROMPT_RECIPES.has(recipe) ? [recipe, bwRefine] : [recipe];
  const perPanel = estimateSeconds([noChars, oneChar, multiChar].flatMap(refine)) / 3;
  const render = panels * perPanel;
  const rounds = settings.review.autoInEpisode ? settings.review.rounds : 0;
  return { panels, seconds: Math.round(render + estimateReviewSeconds(render, panels, rounds)) };
}

/** "8 pages ≈ 36 panels ≈ 37 min" (the AI section and `manga episode start`). */
export function formatChapterEstimate(pages: number, settings: Settings, colorMode?: ColorMode): string {
  const { panels, seconds } = estimateChapter(pages, settings, colorMode);
  return `${pages} ${pages === 1 ? 'page' : 'pages'} ≈ ${panels} panels ≈ ${formatEstimate(seconds).replace(/^~/, '')}`;
}
