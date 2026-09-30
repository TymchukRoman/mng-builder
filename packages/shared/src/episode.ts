// packages/shared/src/episode.ts
import { z } from 'zod';
import { PRESET_NAMES, presetPanelCount } from './layout/index.js';
import {
  AngleSchema, CharacterRoleSchema, DialogueKindSchema, EPISODE_STEPS, ShotSchema, StagePositionSchema,
  type EpisodeStepName, type Task,
} from './schemas.js';

/** Trim, collapse inner whitespace, lower-case (works for Cyrillic). */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

export function stepIndex(name: EpisodeStepName): number {
  return EPISODE_STEPS.indexOf(name);
}

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
export const NewCharacterDraftSchema = z.object({
  name: z.string().min(1), role: CharacterRoleSchema, personality: z.string(), speechStyle: z.string(), appearanceTags: z.string().min(1),
});
export type NewCharacterDraft = z.infer<typeof NewCharacterDraftSchema>;
export const OutlineOutputSchema = z.object({
  scenes: z.array(OutlineSceneSchema).min(1), newCharacters: z.array(NewCharacterDraftSchema).max(5),
});
export type OutlineOutput = z.infer<typeof OutlineOutputSchema>;

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
const SpeakerSchema = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().min(1).nullable());
export const DialogueDraftSchema = z.object({ speaker: SpeakerSchema, kind: DialogueKindSchema, text: z.string().min(1) });
export const PanelScriptDraftSchema = z.object({
  action: z.string().min(1), shot: ShotSchema, angle: AngleSchema,
  characters: z.array(PanelCharacterDraftSchema).max(4), background: z.string(), dialogue: z.array(DialogueDraftSchema).max(6),
});
export type PanelScriptDraft = z.infer<typeof PanelScriptDraftSchema>;
export const ScriptsOutputSchema = z.object({ pages: z.array(z.object({ panels: z.array(PanelScriptDraftSchema).min(1) })).min(1) });
export type ScriptsOutput = z.infer<typeof ScriptsOutputSchema>;
export interface ScriptsRules { panelCounts: number[]; knownNames: string[] }

export function scriptsSchemaFor(rules: ScriptsRules): z.ZodType<ScriptsOutput> {
  const known = (name: string): boolean => rules.knownNames.some((k) => sameName(k, name));
  const valid = rules.knownNames.join(', ') || '(none — this manga has no characters, so use no characters and null speakers)';
  return ScriptsOutputSchema.superRefine((value, ctx) => {
    if (value.pages.length !== rules.panelCounts.length) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `expected exactly ${rules.panelCounts.length} pages (from the breakdown), got ${value.pages.length}` });
    }
    value.pages.forEach((page, i) => {
      const want = rules.panelCounts[i];
      if (want !== undefined && page.panels.length !== want) {
        ctx.addIssue({ code: 'custom', path: ['pages', i, 'panels'], message: `page ${i + 1} needs exactly ${want} panels (from the breakdown), got ${page.panels.length}` });
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
  panels: z.array(z.object({ panelId: z.string().min(3), scene: z.string().min(1), negative: z.string().nullish().transform((v) => v ?? undefined) })).min(1),
});
export type PromptsOutput = z.infer<typeof PromptsOutputSchema>;
export interface PromptsRules { panelIds: string[] }

export function promptsSchemaFor(rules: PromptsRules): z.ZodType<PromptsOutput> {
  const allowed = new Set(rules.panelIds);
  return PromptsOutputSchema.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.panels.forEach((p, i) => {
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
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;
export const LetteringOutputSchema = z.object({ frames: z.number().int().min(0) });
export type LetteringOutput = z.infer<typeof LetteringOutputSchema>;

/** Base (unrefined) schema per step: what the UI can check locally. The server validates edits with the refined ones. */
export const STEP_OUTPUT_SCHEMAS: Record<EpisodeStepName, z.ZodType> = {
  premise: PremiseOutputSchema, outline: OutlineOutputSchema, breakdown: BreakdownOutputSchema, scripts: ScriptsOutputSchema,
  prompts: PromptsOutputSchema, render: RenderOutputSchema, lettering: LetteringOutputSchema,
};

/** Spec §8 "Task(s)". scripts writes all the dialogue, so it runs as 'dialogue' (keeps the Settings dialogue engine/model live). render/lettering are not LLM steps. */
export const STEP_TASK: Record<EpisodeStepName, Task | null> = {
  premise: 'story', outline: 'story', breakdown: 'story', scripts: 'dialogue', prompts: 'prompts', render: null, lettering: null,
};

export const EDITABLE_STEPS: ReadonlySet<EpisodeStepName> = new Set<EpisodeStepName>(['premise', 'outline', 'breakdown', 'scripts', 'prompts']);

// ---- render-time estimate (spec §8: "panels × recipe average") ----
/**
 * Seconds per image, seeded from the live timings (M2 Task 24 live check / P1 bake-off):
 * anime-ref ~32 s per panel incl. ComfyUI overhead; anime ~30 s; qwen-edit-ref 115-135 s (8 steps x 11-13 s + model load);
 * klein-ref 6.5 s, anima 21.7 s, anima-turbo 3.8 s from the bake-off, each + ~10 s overhead; upscale ~10 s.
 * anime-pose and anime-refine are assumed, not measured. (A character portrait is ~15 s; it is not a panel recipe.) Revisit after the routing decision.
 */
export const RECIPE_AVG_SECONDS: Record<string, number> = {
  anime: 30, 'anime-ref': 32, 'anime-pose': 32 /* assumed, not measured */, 'anime-refine': 20 /* assumed, not measured */, 'qwen-edit-ref': 125, 'klein-ref': 17, anima: 32, 'anima-turbo': 14, upscale: 10,
};
export const DEFAULT_RECIPE_SECONDS = 20;

export function estimateSeconds(recipes: Array<string | null>): number {
  return recipes.reduce((sum, r) => sum + (r !== null ? RECIPE_AVG_SECONDS[r] ?? DEFAULT_RECIPE_SECONDS : DEFAULT_RECIPE_SECONDS), 0);
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
