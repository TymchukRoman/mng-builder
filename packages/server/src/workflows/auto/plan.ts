// packages/server/src/workflows/auto/plan.ts
import {
  MANGA_TITLE_FROM_PLAN, MAX_NEW_CHARACTERS, mangaPlanSchemaFor, type AutoRun, type Language, type LlmStepPayload, type MangaPlan,
} from '@manga/shared';
import { createChapter } from '../../domain/chapters.js';
import type { Engines } from '../../engines/resolve.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import { InvalidOutputError } from '../../engines/errors.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { Store } from '../../store/index.js';
import { APPEARANCE_COLOR_RULE, LANGUAGE_NAME, contextBlock } from '../episode/context.js';
import { addArtTags, createOutlineCharacters } from '../episode/effects.js';
import { rawOutputError } from '../episode/llm.js';
import { loadSplitPrompt, renderTemplate } from '../episode/prompts.js';

type PlanPayload = Extract<LlmStepPayload, { type: 'manga-plan' }>;

/** What the plan call reads: the brief as the author wrote it, the series size, and what is already decided about the manga. */
export interface PlanContext {
  step: 'manga-plan'; language: Language; manga: { title: string; colorMode: 'bw' | 'color' };
  request: { brief: string; chapters: number; pagesPerChapter: number };
}

export function planContext(store: Store, run: AutoRun): PlanContext {
  const manga = store.mangas.require(run.mangaId);
  return {
    step: 'manga-plan', language: manga.language,
    manga: { title: manga.title === MANGA_TITLE_FROM_PLAN ? '' : manga.title, colorMode: manga.colorMode },
    request: { brief: run.input.brief, chapters: run.input.chapters, pagesPerChapter: run.input.pagesPerChapter },
  };
}

/** The system and user prompts of the plan call. */
export function planPrompts(store: Store, run: AutoRun): { system: string; prompt: string } {
  const context = planContext(store, run);
  const template = loadSplitPrompt('plan', 'manga');
  const vars = {
    context: contextBlock(context), languageName: LANGUAGE_NAME[context.language], chapters: String(run.input.chapters),
    pages: String(run.input.pagesPerChapter), maxCharacters: String(MAX_NEW_CHARACTERS), appearanceColorRule: APPEARANCE_COLOR_RULE[context.manga.colorMode],
  };
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
        stylePrompt: addArtTags(manga.styleGuide.stylePrompt, plan.styleTags),
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
 * The `llm.step {type:'manga-plan'}` handler: one story-task call on the engine of the job's lane (I1), then `applyPlan`.
 * A run that is no longer running, already planned, or gone is skipped. An answer that stays invalid after the engine's
 * correction round fails the job with the raw answer attached, like an episode step.
 */
export async function handlePlanJob(
  deps: PlanDeps & { engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: LlmStepPayload,
): Promise<{ chapters: number } | { skipped: true }> {
  if (payload.type !== 'manga-plan') throw new PermanentError(`not a manga plan: ${payload.type}`);
  const { store } = deps;
  const live = (): AutoRun | null => {
    const run = store.autoRuns.get((payload as PlanPayload).autoRunId);
    return run !== null && run.status === 'running' && run.stage === 'plan' && run.plan === null ? run : null;
  };
  const run = live();
  if (run === null) return { skipped: true };
  const { system, prompt } = planPrompts(store, run);
  ctx.progress('Planning the series…');
  let plan: MangaPlan;
  try {
    plan = await deps.engines.forLane(ctx.job.lane).completeJson({
      name: 'manga.plan', task: 'story', system, prompt, schema: mangaPlanSchemaFor({ chapters: run.input.chapters }),
      signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
  } catch (err) {
    throw err instanceof InvalidOutputError ? rawOutputError(err) : err;
  }
  if (ctx.signal.aborted || live() === null) return { skipped: true };
  applyPlan(deps, run.id, plan);
  return { chapters: plan.chapters.length };
}
