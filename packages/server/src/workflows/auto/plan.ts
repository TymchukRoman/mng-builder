// packages/server/src/workflows/auto/plan.ts
import {
  CheckAnswerSchema, MANGA_TITLE_FROM_PLAN, MAX_NEW_CHARACTERS, deriveArtTags, mangaPlanSchemaFor,
  type AutoRun, type Directive, type Language, type LlmStepPayload, type MangaPlan, type MangaPlanAnswer,
} from '@manga/shared';
import { createChapter } from '../../domain/chapters.js';
import type { Engines } from '../../engines/resolve.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import { InvalidOutputError } from '../../engines/errors.js';
import type { TextEngine } from '../../engines/types.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { Store } from '../../store/index.js';
import { analyzeBrief } from '../brief/analyze.js';
import { APPEARANCE_COLOR_RULE, LANGUAGE_NAME, contextBlock, directiveBrief, type DirectiveBrief } from '../episode/context.js';
import { addArtTags, createOutlineCharacters } from '../episode/effects.js';
import { rawOutputError } from '../episode/llm.js';
import { loadSplitPrompt, renderTemplate } from '../episode/prompts.js';

type PlanPayload = Extract<LlmStepPayload, { type: 'manga-plan' }>;

/** A directive as the plan call and its check read it: what it asks, how strictly, the chapters it names, and its look tags. */
export interface PlanDirective extends DirectiveBrief { chapters: number[]; tags: string }
const planDirective = (d: Directive): PlanDirective => ({ ...directiveBrief(d), chapters: d.chapters, tags: d.tags });

/** What the plan call reads: the directives of the brief, the series size, what is already decided about the manga, and on a second try what to fix. */
export interface PlanContext {
  step: 'manga-plan'; language: Language; manga: { title: string; colorMode: 'bw' | 'color' };
  request: { brief: string; chapters: number; pagesPerChapter: number };
  directives: PlanDirective[];
  revisions?: Array<{ id: string; text: string; problem: string }>;
  previousPlan?: MangaPlanAnswer;
}

/** A second try of the plan: the first plan and what an audit found wrong with it. */
export interface PlanRetry { revisions: NonNullable<PlanContext['revisions']>; previousPlan: MangaPlanAnswer }

export function planContext(store: Store, run: AutoRun, ledger: readonly Directive[], retry?: PlanRetry): PlanContext {
  const manga = store.mangas.require(run.mangaId);
  return {
    step: 'manga-plan', language: manga.language,
    manga: { title: manga.title === MANGA_TITLE_FROM_PLAN ? '' : manga.title, colorMode: manga.colorMode },
    request: { brief: run.input.brief, chapters: run.input.chapters, pagesPerChapter: run.input.pagesPerChapter },
    directives: ledger.map(planDirective), ...(retry ?? {}),
  };
}

/** The system and user prompts of the plan call. */
export function planPrompts(store: Store, run: AutoRun, ledger: readonly Directive[], retry?: PlanRetry): { system: string; prompt: string } {
  const context = planContext(store, run, ledger, retry);
  const template = loadSplitPrompt('plan', 'manga');
  const vars = {
    context: contextBlock(context), languageName: LANGUAGE_NAME[context.language], chapters: String(run.input.chapters),
    pages: String(run.input.pagesPerChapter), maxCharacters: String(MAX_NEW_CHARACTERS), appearanceColorRule: APPEARANCE_COLOR_RULE[context.manga.colorMode],
  };
  return { system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars) };
}

/** The context of the check of a plan against the directives. */
export interface PlanAuditContext { step: 'plan-audit'; language: Language; directives: PlanDirective[]; plan: MangaPlanAnswer }

export function planAuditPrompts(language: Language, ledger: readonly Directive[], plan: MangaPlanAnswer): { system: string; prompt: string } {
  const template = loadSplitPrompt('plan-audit', 'manga');
  const context: PlanAuditContext = { step: 'plan-audit', language, directives: ledger.map(planDirective), plan };
  const vars = { context: contextBlock(context), languageName: LANGUAGE_NAME[language] };
  return { system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars) };
}

export interface PlanDeps { store: Store; bus: EventBus }

/**
 * Writes the plan into the library, once (`run.plan` is the marker): the cast, the chapters (each with its own image model
 * from the run's input) and the manga's own title, synopsis and look. A title the user typed is kept. The plan's `styleTags`
 * and `negativeTags` join the manga's style and negative prompts, so every chapter and the poster share one look.
 * The run moves on to the portraits stage in the same transaction as the chapters, so a crash leaves nothing half-applied
 * but the cast, which a second attempt skips by name.
 */
export function applyPlan({ store, bus }: PlanDeps, runId: string, plan: MangaPlan): AutoRun {
  const run = store.autoRuns.require(runId);
  if (run.plan !== null) return run;
  const manga = store.mangas.require(run.mangaId);
  createOutlineCharacters({ store, bus }, manga.id, plan.characters);
  const { next, chapters } = store.tx(() => {
    const created = plan.chapters.map((c, i) =>
      createChapter(store, manga.id, { title: c.title, synopsis: c.synopsis, imageModel: run.input.chapterModels[i] ?? null }));
    const owned = manga.title === MANGA_TITLE_FROM_PLAN;
    store.mangas.update(manga.id, {
      title: owned ? plan.title : manga.title, synopsis: plan.synopsis,
      styleGuide: {
        ...manga.styleGuide,
        // The look comes from the directives (code, so every tag the brief asked for is there), then whatever else the plan added.
        stylePrompt: addArtTags(addArtTags(manga.styleGuide.stylePrompt, deriveArtTags(plan.directives.filter((d) => d.chapters.length === 0))), plan.styleTags),
        negativePrompt: addArtTags(manga.styleGuide.negativePrompt, plan.negativeTags),
      },
    });
    return {
      chapters: created,
      next: store.autoRuns.update(run.id, { plan, chapterIds: created.map((c) => c.id), currentChapter: 0, stage: 'portraits', error: null }),
    };
  });
  emitEntity(bus, 'manga', manga.id, 'updated', manga.id);
  for (const c of chapters) emitEntity(bus, 'chapter', c.id, 'created', manga.id);
  emitEntity(bus, 'autoRun', run.id, 'updated', manga.id);
  return next;
}

/**
 * The directives the audit found unmet, as `{id, problem}`; only "must" ones. A check that fails or answers badly counts as
 * "nothing found" (one warning): the plan is never lost to its own check, but a cancelled job still cancels.
 */
async function auditPlan(
  engine: TextEngine, ctx: JobContext, language: Language, ledger: readonly Directive[], plan: MangaPlanAnswer,
): Promise<Array<{ id: string; problem: string }>> {
  const must = new Set(ledger.filter((d) => d.must).map((d) => d.id));
  if (must.size === 0) return [];
  try {
    ctx.progress('Checking the plan against your details…');
    const { system, prompt } = planAuditPrompts(language, ledger, plan);
    const verdict = await engine.completeJson({
      name: 'manga.plan-audit', task: 'story', system, prompt, schema: CheckAnswerSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    return verdict.unmet.filter((u) => must.has(u.id));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.warn(`[manga] manga plan: the check against the author's details failed, so the plan is taken as it is: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * The `llm.step {type:'manga-plan'}` handler, on the engine of the job's lane (I1), in passes: the brief is read into directives
 * (extract, then an audit of what that missed), the plan is written from them (the schema refuses a plan that leaves a "must"
 * directive out of its coverage), the plan is checked against them, and when the check finds some unmet it is written once more with the
 * findings and checked again. What is still unmet after that stays marked on its directive, for the user to see. Then `applyPlan`.
 * A run that is no longer running, already planned, or gone is skipped. An answer that stays invalid after the engine's correction
 * round fails the job with the raw answer attached, like an episode step.
 */
export async function handlePlanJob(
  deps: PlanDeps & { engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: LlmStepPayload,
): Promise<{ chapters: number; directives: number } | { skipped: true }> {
  if (payload.type !== 'manga-plan') throw new PermanentError(`not a manga plan: ${payload.type}`);
  const { store } = deps;
  const live = (): AutoRun | null => {
    const run = store.autoRuns.get((payload as PlanPayload).autoRunId);
    return run !== null && run.status === 'running' && run.stage === 'plan' && run.plan === null ? run : null;
  };
  const run = live();
  if (run === null) return { skipped: true };
  const engine = deps.engines.forLane(ctx.job.lane);
  const language = store.mangas.require(run.mangaId).language;
  const io = { signal: ctx.signal, onProgress: (label: string) => ctx.progress(label) };
  const ledger = await analyzeBrief(engine, { language, brief: run.input.brief, chapters: run.input.chapters }, io);
  const schema = mangaPlanSchemaFor({ chapters: run.input.chapters, directives: ledger });
  const write = async (retry?: PlanRetry): Promise<MangaPlanAnswer> => {
    const { system, prompt } = planPrompts(store, run, ledger, retry);
    ctx.progress(retry ? 'Planning the series again…' : 'Planning the series…');
    try {
      return await engine.completeJson({ name: 'manga.plan', task: 'story', system, prompt, schema, ...io });
    } catch (err) {
      throw err instanceof InvalidOutputError ? rawOutputError(err) : err;
    }
  };
  let answer = await write();
  let unmet = await auditPlan(engine, ctx, language, ledger, answer);
  if (unmet.length > 0) {
    try {
      const revised = await write({ revisions: unmet.flatMap((u) => { const d = ledger.find((x) => x.id === u.id); return d ? [{ id: d.id, text: d.text, problem: u.problem }] : []; }), previousPlan: answer });
      unmet = await auditPlan(engine, ctx, language, ledger, revised);
      answer = revised;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      console.warn(`[manga] manga plan: the second try failed, so the first plan stays: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problem = new Map(unmet.map((u) => [u.id, u.problem]));
  const directives = ledger.map((d): Directive => (!d.must ? d : problem.has(d.id) ? { ...d, status: 'unmet', note: problem.get(d.id)! } : { ...d, status: 'applied' }));
  if (ctx.signal.aborted || live() === null) return { skipped: true };
  applyPlan(deps, run.id, { ...answer, directives });
  return { chapters: answer.chapters.length, directives: directives.length };
}
