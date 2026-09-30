// packages/server/src/workflows/episode/summary.ts
import { z } from 'zod';
import { ScriptsOutputSchema, type LlmStepPayload } from '@manga/shared';
import type { Engines } from '../../engines/resolve.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import type { JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { LANGUAGE_NAME, clip, contextBlock, storyDigest, type SummaryContext } from './context.js';
import { loadStepPrompt, renderTemplate } from './prompts.js';
import { requireOutput } from './steps.js';

/** The longest chapter summary kept; a longer answer is clipped, never refused (review M4). */
export const SUMMARY_LIMIT = 1500;

/**
 * The summary answer. Lenient like the episode steps' answers: a summary longer than SUMMARY_LIMIT is clipped before it is
 * validated, so a wordy answer never fails the job. The JSON Schema the engines see still says `maxLength` 1500.
 */
export const ChapterSummaryAnswerSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
    const { summary } = raw as { summary?: unknown };
    return typeof summary === 'string' ? { ...raw, summary: clip(summary.trim(), SUMMARY_LIMIT) } : raw;
  },
  z.object({ summary: z.string().trim().min(1).max(SUMMARY_LIMIT) }),
);
/** The story the summary call reads: much more than storySoFar, still a small call. */
export const SUMMARY_STORY_LIMIT = 12_000;

type SummaryPayload = Extract<LlmStepPayload, { type: 'chapter-summary' }>;

/**
 * Review M8 (like the M4 final M6/N3 title rule): the chapter's summary may be replaced only when it is empty or is a
 * summary that a run of this chapter wrote (`EpisodeRun.chapterSummary`); a summary the user wrote or edited is kept.
 */
function summaryIsReplaceable(store: Store, chapterId: string): boolean {
  const summary = store.chapters.get(chapterId)?.summary ?? '';
  if (summary.trim() === '') return true;
  return store.episodes.listByChapter(chapterId).some((r) => r.chapterSummary === summary);
}

/**
 * W1 Q1: one small story-task call when an episode run finishes: 3–5 sentences of "what happened", in the book language,
 * written to chapter.summary (later chapters read it instead of the synopsis) and to the run's `chapterSummary`. Runs on
 * the engine of the job's lane (I1); the story is in the prompt's <context>, the system prompt stays small (G2). The story
 * keeps the chapter's first page and its most recent pages (review M5). Skipped, before and after the call: a run that is
 * no longer the chapter's finished latest run, a chapter that is gone, and a summary the user wrote (review M8). Emits
 * `chapter updated` and `episodeRun updated` once each. The run never waits for this job, so its failure never fails the run.
 */
export async function writeChapterSummary(
  deps: { store: Store; bus: EventBus; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, payload: SummaryPayload,
): Promise<{ summary: string } | { skipped: true }> {
  const { store, bus } = deps;
  const current = (): boolean => {
    const run = store.episodes.get(payload.runId);
    return run !== null && run.status === 'done' && store.chapters.get(payload.chapterId) !== null
      && store.episodes.latestByChapter(payload.chapterId)?.id === run.id && summaryIsReplaceable(store, payload.chapterId);
  };
  if (!current()) return { skipped: true };
  const run = store.episodes.require(payload.runId);
  const chapter = store.chapters.require(payload.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const data: SummaryContext = {
    step: 'summary', language: manga.language,
    chapter: { number: chapter.number, title: chapter.title, synopsis: chapter.synopsis },
    story: storyDigest(requireOutput(run, 'scripts', ScriptsOutputSchema).pages, 1, SUMMARY_STORY_LIMIT, { keepFirst: true }),
  };
  const template = loadStepPrompt('summary');
  const vars = { context: contextBlock(data), languageName: LANGUAGE_NAME[manga.language] };
  ctx.progress('Summarising the chapter…');
  const { summary } = await deps.engines.forLane(ctx.job.lane).completeJson({
    name: 'episode.summary', task: 'story', system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
    schema: ChapterSummaryAnswerSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
  });
  if (ctx.signal.aborted || !current()) return { skipped: true };
  const [updated, done] = store.tx(() => [
    store.chapters.update(chapter.id, { summary }),
    store.episodes.update(run.id, { chapterSummary: summary }),
  ] as const);
  emitEntity(bus, 'chapter', updated.id, 'updated', updated.mangaId);
  emitEntity(bus, 'episodeRun', done.id, 'updated', updated.mangaId);
  return { summary };
}
