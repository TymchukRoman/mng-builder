// packages/server/src/workflows/episode/requests.ts
import { z } from 'zod';
import {
  AuditAnswerSchema, ExtractAnswerSchema, PremiseOutputSchema, PromptsOutputSchema, STEP_TASK, ScriptsOutputSchema, briefSegments, deriveArtTags, deriveNotes, mergeDirectives,
  promptsSchemaFor, scriptsSchemaFor, type EpisodeRun, type Task,
} from '@manga/shared';
import { auditRequest, extractRequest, ledgerFrom, type BriefInput, type PassRequest } from '../brief/analyze.js';
import type { Store } from '../../store/index.js';
import {
  buildStepContext, directiveBrief, pageActions, storyDigest, templateVars, type PromptsContext, type PromptsPanelBrief, type Revision, type ScriptsContext, type StepContext,
} from './context.js';
import { normalizeLlmAnswer } from './normalize.js';
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
  /**
   * This call's schema; a chunk's names absolute page numbers, so the correction round points at the right page.
   * Every answer (the correction round's too) goes through `normalizeLlmAnswer` first; its JSON Schema is unchanged.
   */
  schema: z.ZodType<unknown>;
  /** Job progress label, e.g. "Writing scripts (pages 5–8 of 10)…". */
  progress: string;
  /** Prompts: the panels the last normalised answer of this call left without a scene, written from their script. */
  filled: string[];
  /**
   * Prompts: when an answer is still invalid after the correction round, it is accepted if it fits this looser schema
   * (normalised the same way): only its English check failed, and the prompts effect writes those panels' scenes from
   * their cast instead, so a non-English scene never fails the run.
   */
  relaxed?: z.ZodType<unknown>;
  /**
   * W1 Q1 (scripts chunks after the first): this call's prompt given the answers of the calls before it, whose pages
   * become the context's `storySoFar`. `prompt` is the same prompt without it. executeLlmStep uses this when set.
   */
  promptFor?: (previous: readonly unknown[]) => string;
}

/**
 * The calls a step makes, in order. premise, outline and breakdown: one call. scripts: one call per
 * SCRIPTS_PAGES_PER_CALL pages, each with the same context but only its pages. prompts: one call per page, the
 * cover last (F18). Feed the answers, in the same order, to `combineAnswers`. W1 Q1: a scripts chunk after the first sees the
 * pages the earlier chunks wrote (`promptFor`), and a story page's prompts call sees the page before it (`previousPage`).
 */
export function stepRequests(store: Store, run: EpisodeRun, step: LlmStepName, opts: { revisions?: Revision[] } = {}): StepRequest[] {
  const ctx = buildStepContext(store, run, step);
  const template = loadStepPrompt(step);
  /** A scripts chunk's user prompt with its `storySoFar` (W1 Q1), rendered when the chunk is sent. */
  const userPrompt = (c: StepContext): string => renderTemplate(template.user, templateVars(store, run, c));
  const request = (c: StepContext, schema: z.ZodType<unknown>, progress: string, relaxed?: z.ZodType<unknown>): StepRequest => {
    const vars = templateVars(store, run, c);
    const filled: string[] = [];
    const offered = c.step === 'prompts' ? { panels: c.panels } : {};
    const normalized = (inner: z.ZodType<unknown>): z.ZodType<unknown> => z.preprocess((raw) => {
      const answer = normalizeLlmAnswer(step, raw, offered);
      filled.splice(0, filled.length, ...answer.filled);
      return answer.value;
    }, inner);
    return {
      name: `episode.${step}`, task: STEP_TASK[step]!, system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
      schema: normalized(schema), progress, filled, ...(relaxed ? { relaxed: normalized(relaxed) } : {}),
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
      const chunk: ScriptsContext = { ...ctx, pages, pageRange: { first, last, total }, ...(opts.revisions ? { revisions: opts.revisions } : {}) };
      const req = request(
        chunk,
        scriptsSchemaFor({ panelCounts: pages.map((p) => p.panelCount), knownNames: names, lenient: true, pageOffset: at }),
        total <= SCRIPTS_PAGES_PER_CALL ? STEP_PROGRESS.scripts : `Writing scripts (pages ${first}–${last} of ${total})…`,
      );
      out.push(at === 0 ? req : {
        ...req,
        promptFor: (previous) => {
          const written = previous.flatMap((a) => ScriptsOutputSchema.parse(a).pages);
          return userPrompt({ ...chunk, storySoFar: storyDigest(written, 1) });
        },
      });
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
    return groups.map((panels, g) => {
      const panelIds = panels.map((p) => p.panelId);
      const before = groups[g - 1];
      const previousPage = !panels[0]!.isCover && before !== undefined && !before[0]!.isCover ? pageActions(before) : '';
      const c: PromptsContext = { ...ctx, panels, ...(previousPage !== '' ? { previousPage } : {}) };
      return request(
        c,
        promptsSchemaFor({ panelIds, englishScenes: true }),
        panels[0]!.isCover ? 'Writing image prompts (cover)…' : `Writing image prompts (page ${panels[0]!.page} of ${storyPages})…`,
        promptsSchemaFor({ panelIds }),
      );
    });
  }
  const single = request(ctx, validationSchema(store, run, step, { source: 'llm' }), STEP_PROGRESS[step]);
  if (ctx.step !== 'premise' || run.input.directives !== undefined) return [single];
  // The premise reads the brief first, in two passes (extract, then an audit of what the first missed), and writes from the ledger.
  const manga = store.mangas.require(store.chapters.require(run.chapterId).mangaId);
  const brief: BriefInput = { language: manga.language, brief: run.input.prompt, ...(run.input.notes ? { notes: run.input.notes } : {}), chapters: null };
  const { request: extract, segments } = extractRequest(brief);
  const asStep = (r: PassRequest<unknown>): StepRequest => ({ name: r.name, task: r.task, system: r.system, prompt: r.prompt, schema: r.schema, progress: r.progress, filled: [] });
  const found = (previous: readonly unknown[]) => mergeDirectives([], ExtractAnswerSchema.parse(previous[0]).directives, segments.length);
  return [
    asStep(extract),
    { ...asStep(auditRequest(brief, segments, [])), promptFor: (previous) => auditRequest(brief, segments, found(previous)).prompt },
    {
      ...single,
      promptFor: (previous) => userPrompt({
        ...ctx, directives: ledgerFrom(ExtractAnswerSchema.parse(previous[0]), AuditAnswerSchema.parse(previous[1]), segments.length).map(directiveBrief),
      }),
    },
  ];
}

/** Joins the answers of `stepRequests` (in order) and validates the whole with the step's LLM schema (ZodError when invalid). */
export function combineAnswers(store: Store, run: EpisodeRun, step: LlmStepName, answers: unknown[]): unknown {
  let whole: unknown;
  if (step === 'premise') {
    // The last answer is the premise; the ledger is what was handed in, else what the two passes read. Notes and art tags come
    // from the ledger (code, not the model's memory of it); a premise written without a ledger keeps its own.
    const premise = PremiseOutputSchema.parse(answers.at(-1));
    const given = run.input.directives;
    const directives = given ?? ledgerFrom(
      ExtractAnswerSchema.parse(answers[0]), AuditAnswerSchema.parse(answers[1]), briefSegments(run.input.prompt, run.input.notes).length,
    );
    whole = directives.length === 0 ? premise : {
      ...premise, directives, notes: deriveNotes(directives), artTags: deriveArtTags(directives, { skipSeries: given !== undefined }),
    };
  } else if (step === 'scripts') whole = { pages: answers.flatMap((a) => ScriptsOutputSchema.parse(a).pages) };
  else if (step === 'prompts') whole = { panels: answers.flatMap((a) => PromptsOutputSchema.parse(a).panels) };
  else if (answers.length === 1) whole = answers[0];
  else throw new Error(`step ${step} makes one call, got ${answers.length} answers`);
  return validationSchema(store, run, step, { source: 'llm' }).parse(whole);
}
