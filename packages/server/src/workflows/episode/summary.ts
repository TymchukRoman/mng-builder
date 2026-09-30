// packages/server/src/workflows/episode/summary.ts
import { z } from 'zod';
import { ScriptsOutputSchema, type LlmStepPayload } from '@manga/shared';
import type { Engines } from '../../engines/resolve.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { LANGUAGE_NAME, contextBlock, storyDigest, type SummaryContext } from './context.js';
import { loadStepPrompt, renderTemplate } from './prompts.js';
import { requireOutput } from './steps.js';

export const ChapterSummaryAnswerSchema = z.object({ summary: z.string().trim().min(1).max(1500) });
/** The story the summary call reads: much more than storySoFar, still a small call. */
export const SUMMARY_STORY_LIMIT = 12_000;

type SummaryPayload = Extract<LlmStepPayload, { type: 'chapter-summary' }>;

/**
 * W1 Q1: one small story-task call when an episode run finishes: 3–5 sentences of "what happened", in the book language,
 * written to chapter.summary (later chapters read it instead of the synopsis). Runs on the engine of the job's lane (I1);
 * the story is in the prompt's <context>, the system prompt stays small (G2). A run that is no longer the chapter's finished
 * latest run, or a chapter that is gone, is skipped. Emits `chapter updated` once. The run never waits for this job, so
 * its failure never fails the run.
 */
export async function writeChapterSummary(
  deps: { store: Store; bus: EventBus; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: SummaryPayload,
): Promise<{ summary: string } | { skipped: true }> {
  const { store, bus } = deps;
  const current = (): boolean => {
    const run = store.episodes.get(payload.runId);
    return run !== null && run.status === 'done' && store.chapters.get(payload.chapterId) !== null
      && store.episodes.latestByChapter(payload.chapterId)?.id === run.id;
  };
  if (!current()) return { skipped: true };
  const run = store.episodes.require(payload.runId);
  const chapter = store.chapters.require(payload.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const data: SummaryContext = {
    step: 'summary', language: manga.language,
    chapter: { number: chapter.number, title: chapter.title, synopsis: chapter.synopsis },
    story: storyDigest(requireOutput(run, 'scripts', ScriptsOutputSchema).pages, 1, SUMMARY_STORY_LIMIT),
  };
  const template = loadStepPrompt('summary');
  const vars = { context: contextBlock(data), languageName: LANGUAGE_NAME[manga.language] };
  ctx.progress('Summarising the chapter…');
  const { summary } = await deps.engines.forLane(ctx.job.lane).completeJson({
    name: 'episode.summary', task: 'story', system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
    schema: ChapterSummaryAnswerSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
  });
  if (ctx.signal.aborted || !current()) return { skipped: true };
  const updated = store.chapters.update(chapter.id, { summary });
  emitEntity(bus, 'chapter', updated.id, 'updated', updated.mangaId);
  return { summary };
}
