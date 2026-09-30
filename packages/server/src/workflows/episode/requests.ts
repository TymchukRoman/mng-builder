// packages/server/src/workflows/episode/requests.ts
import type { z } from 'zod';
import {
  PromptsOutputSchema, STEP_TASK, ScriptsOutputSchema, promptsSchemaFor, scriptsSchemaFor, type EpisodeRun, type Task,
} from '@manga/shared';
import type { Store } from '../../store/index.js';
import { buildStepContext, templateVars, type PromptsPanelBrief, type StepContext } from './context.js';
import { loadStepPrompt, renderTemplate } from './prompts.js';
import { STEP_PROGRESS, type LlmStepName } from './steps.js';
import { knownNames, validationSchema } from './validation.js';

/** F18: a long chapter's scripts in one call exceed the engines' timeouts and output caps, so they run in chunks. */
export const SCRIPTS_PAGES_PER_CALL = 4;

/** One engine call of a step: a JsonRequest without the signal/onProgress the job adds. */
export interface StepRequest {
  /** `episode.<step>`: the FAKE_RESPONSES key. */
  name: string;
  task: Task;
  system: string;
  prompt: string;
  /** This call's schema; a chunk's names absolute page numbers, so the correction round points at the right page. */
  schema: z.ZodType<unknown>;
  /** Job progress label, e.g. "Writing scripts (pages 5–8 of 10)…". */
  progress: string;
}

/**
 * The calls a step makes, in order. premise, outline and breakdown: one call. scripts: one call per
 * SCRIPTS_PAGES_PER_CALL pages, each with the same context but only its pages. prompts: one call per page, the
 * cover last (F18). Feed the answers, in the same order, to `combineAnswers`.
 */
export function stepRequests(store: Store, run: EpisodeRun, step: LlmStepName): StepRequest[] {
  const ctx = buildStepContext(store, run, step);
  const template = loadStepPrompt(step);
  const request = (c: StepContext, schema: z.ZodType<unknown>, progress: string): StepRequest => {
    const vars = templateVars(store, run, c);
    return {
      name: `episode.${step}`, task: STEP_TASK[step]!, system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
      schema, progress,
    };
  };
  if (ctx.step === 'scripts') {
    const names = knownNames(store, run);
    const total = ctx.pages.length;
    const out: StepRequest[] = [];
    for (let at = 0; at < total; at += SCRIPTS_PAGES_PER_CALL) {
      const pages = ctx.pages.slice(at, at + SCRIPTS_PAGES_PER_CALL);
      const first = at + 1;
      const last = at + pages.length;
      out.push(request(
        { ...ctx, pages, pageRange: { first, last, total } },
        scriptsSchemaFor({ panelCounts: pages.map((p) => p.panelCount), knownNames: names, lenientNames: true, pageOffset: at }),
        total <= SCRIPTS_PAGES_PER_CALL ? STEP_PROGRESS.scripts : `Writing scripts (pages ${first}–${last} of ${total})…`,
      ));
    }
    return out;
  }
  if (ctx.step === 'prompts') {
    const groups: PromptsPanelBrief[][] = [];
    for (const panel of ctx.panels) {
      const last = groups.at(-1);
      if (last && last[0]!.page === panel.page) last.push(panel);
      else groups.push([panel]);
    }
    const storyPages = groups.filter((g) => !g[0]!.isCover).length;
    return groups.map((panels) => request(
      { ...ctx, panels },
      promptsSchemaFor({ panelIds: panels.map((p) => p.panelId) }),
      panels[0]!.isCover ? 'Writing image prompts (cover)…' : `Writing image prompts (page ${panels[0]!.page} of ${storyPages})…`,
    ));
  }
  return [request(ctx, validationSchema(store, run, step, { source: 'llm' }), STEP_PROGRESS[step])];
}

/** Joins the answers of `stepRequests` (in order) and validates the whole with the step's LLM schema (ZodError when invalid). */
export function combineAnswers(store: Store, run: EpisodeRun, step: LlmStepName, answers: unknown[]): unknown {
  let whole: unknown;
  if (step === 'scripts') whole = { pages: answers.flatMap((a) => ScriptsOutputSchema.parse(a).pages) };
  else if (step === 'prompts') whole = { panels: answers.flatMap((a) => PromptsOutputSchema.parse(a).panels) };
  else if (answers.length === 1) whole = answers[0];
  else throw new Error(`step ${step} makes one call, got ${answers.length} answers`);
  return validationSchema(store, run, step, { source: 'llm' }).parse(whole);
}
