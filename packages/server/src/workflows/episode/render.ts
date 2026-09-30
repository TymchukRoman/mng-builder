import {
  RenderOutputSchema, castCount, countSentence, countTag, estimateReviewSeconds, grownMen, estimateSeconds, formatEstimate, renderGate, stepIndex,
  type CastCount,
  type Character, type EpisodeRun, type Image, type ImageGeneratePayload, type ImageGenerateResult, type ImageReviewPayload,
  type Job, type Manga, type Panel, type RenderOutput, type ReviewResult, type Settings,
} from '@manga/shared';
import { setCharacterRef } from '../../domain/characters.js';
import { randomSeed } from '../../domain/seed.js';
import type { Engines } from '../../engines/resolve.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import { panelCharacters, panelContext } from '../../handlers/context.js';
import { enqueuePortraits } from '../../imaging/portraits.js';
import { promptStyleFor, routeRecipe, type PromptStyle } from '../../imaging/route.js';
import { PermanentError, isTerminal, waitForJob, type JobContext, type JobQueue } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { chapterPanels } from './chapter.js';

export type QueueLike = Pick<JobQueue, 'enqueue' | 'cancel' | 'waitFor'>;
export interface DriverDeps { store: Store; bus: EventBus; queue: QueueLike; engines: Pick<Engines, 'laneFor'>; newSeed?: () => number }

export const TEXT_NEGATIVE = 'text, letters, words, writing';
/** F14: an anatomy flag goes into the negative prompt; the reviewer's note names the defect, not the wanted result. */
export const ANATOMY_NEGATIVE = 'bad anatomy, extra arms, extra limbs, bad hands';
export interface RetryPatch { seed: number; recipe?: string; negativeExtra?: string; sceneSuffix?: string }
/** `grownMen`: every man of the cast is grown, so the natural count sentence says "grown man" as the build's does. */
export interface RetryTarget { cast: CastCount; hasPortraitRefs: boolean; style: PromptStyle; grownMen?: boolean }

/**
 * The retry facts of a panel: its people count (panelCharacters, the cast the panel build counts, so a
 * character-count retry repeats exactly the count the build already put first), whether a referenced character has
 * a portrait (F31), and the prompt style of the recipe it routes to.
 */
export function retryTarget(store: Store, settings: Settings, panel: Panel): RetryTarget {
  const { manga, characters, refCharacters } = panelContext(store, panel.id);
  const route = routeRecipe({ settings, manga, panel, refCount: refCharacters.length, charCount: characters.length });
  return {
    cast: castCount(characters),
    grownMen: grownMen(characters),
    hasPortraitRefs: refCharacters.some((c) => c.refs.portrait !== undefined && store.images.get(c.refs.portrait) !== null),
    style: promptStyleFor(route.recipe),
  };
}

/**
 * Spec §8 retry strategy, always with a new seed:
 * - identity → the drift recipe, only when the panel references a character with a portrait (F31: it needs refs);
 * - text → a stronger negative; anatomy → the anatomy negative (F14);
 * - character-count → the panel's people count in the scene (F14, amended): a tag for the tags style, a sentence for the
 *   natural style, judged on the recipe the retry actually uses. For a cast with people the build already puts this
 *   same count first (castPrompt, the same castCount), so the retry repeats it at the end as emphasis;
 * - script-mismatch / other → the reviewer's `fix` in the scene: the wanted state only (M4 final S1). Its `note`
 *   ("X instead of Y") is never used: in the positive prompt it asked for the defect again. A stored review without a
 *   `fix` adds no scene text.
 */
export function retryPatch(issues: ReviewResult['issues'], settings: Settings, seed: number, target: RetryTarget): RetryPatch {
  const kinds = new Set(issues.map((i) => i.kind));
  const recipe = kinds.has('identity') && target.hasPortraitRefs ? settings.routing.driftFallback : null;
  const style = recipe !== null ? promptStyleFor(recipe) : target.style;
  const negatives = [kinds.has('text') ? TEXT_NEGATIVE : null, kinds.has('anatomy') ? ANATOMY_NEGATIVE : null]
    .filter((n): n is string => n !== null);
  const notes = issues
    .filter((i) => i.kind === 'script-mismatch' || i.kind === 'other')
    .map((i) => i.fix?.trim() ?? '')
    .filter((n) => n.length > 0);
  const count = style === 'natural' ? countSentence(target.cast, { grownMen: target.grownMen === true }) : countTag(target.cast);
  const scene = [...(kinds.has('character-count') ? [count] : []), ...notes];
  return {
    seed,
    ...(recipe !== null ? { recipe } : {}),
    ...(negatives.length > 0 ? { negativeExtra: negatives.join(', ') } : {}),
    ...(scene.length > 0 ? { sceneSuffix: scene.join(style === 'natural' ? ' ' : ', ') } : {}),
  };
}

/**
 * Spec §8: "panels × recipe average", with the routing M2 would use right now (panelContext's counts, as the renderer),
 * plus the expected review rounds when the episode reviews its images (M4 final S5: the live render took 2–4× the
 * estimate that left them out).
 */
export function estimateRender(store: Store, settings: Settings, manga: Manga, panels: Panel[]): number {
  const renderSeconds = estimateSeconds(panels.flatMap((panel) => {
    const { characters, refCharacters } = panelContext(store, panel.id);
    const route = routeRecipe({ settings, manga, panel, refCount: refCharacters.length, charCount: characters.length });
    return route.refineWith ? [route.recipe, route.refineWith] : [route.recipe];
  }));
  const rounds = settings.review.autoInEpisode ? settings.review.rounds : 0;
  return renderSeconds + estimateReviewSeconds(renderSeconds, panels.length, rounds);
}

function renderedSince(store: Store, panel: Panel, token: string | null): boolean {
  if (token === null || panel.activeImageId === null) return false;
  const image = store.images.get(panel.activeImageId);
  return image !== null && image.createdAt >= token;
}

function firstPortrait(store: Store, characterId: string): Image | null {
  return store.images.listByOwner('character', characterId)
    .filter((i) => i.role === 'portrait')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

const hasPortrait = (store: Store, c: Character): boolean => c.refs.portrait !== undefined && store.images.get(c.refs.portrait) !== null;

/** This run's jobs that have not finished yet (F11: after a restart they are re-queued, and the driver adopts them). */
function liveJobs(store: Store, runId: string): Job[] {
  return store.jobs.listByEpisodeRun(runId).filter((j) => !isTerminal(j.status));
}

/** Unfinished jobs of an earlier attempt of this step, by panel (generate) and by image (review); each is adopted once. */
class Leftovers {
  private readonly generate = new Map<string, Job>();
  private readonly review = new Map<string, Job>();

  constructor(jobs: Job[]) {
    for (const job of jobs) {
      if (job.kind === 'image.generate') {
        const p = job.payload as ImageGeneratePayload;
        if (p.target === 'panel' && !this.generate.has(p.panelId)) this.generate.set(p.panelId, job);
      } else if (job.kind === 'image.review') {
        const p = job.payload as ImageReviewPayload;
        if (!this.review.has(p.imageId)) this.review.set(p.imageId, job);
      }
    }
  }

  hasGenerate(panelId: string): boolean {
    return this.generate.has(panelId);
  }

  takeGenerate(panelId: string): Job | undefined {
    const job = this.generate.get(panelId);
    this.generate.delete(panelId);
    return job;
  }

  takeReview(imageId: string): Job | undefined {
    const job = this.review.get(imageId);
    this.review.delete(imageId);
    return job;
  }
}

async function ensurePortraits(deps: DriverDeps, ctx: JobContext, run: EpisodeRun, mangaId: string, panels: Panel[]): Promise<void> {
  const { store, queue, bus } = deps;
  const cast = new Map(panels.flatMap((p) => panelCharacters(store, p, mangaId)).map((c) => [c.id, c]));
  const missing = [...cast.values()].filter((c) => !hasPortrait(store, c));
  if (missing.length === 0) return;
  if (run.mode === 'review') {
    // F21 (accepted): review mode fails the step; the user picks portraits, then retries it.
    throw new PermanentError(`Pick a portrait for ${missing.map((c) => c.name).join(', ')} in the Characters tab, then retry the render step`);
  }
  for (const c of missing) {
    ctx.progress(`Choosing a portrait for ${c.name}`);
    let image = firstPortrait(store, c.id);
    if (!image) {
      // F13: the outline step's portraits for this character may still be queued behind other GPU work.
      const pending = liveJobs(store, run.id).filter((j) => {
        const p = j.payload as ImageGeneratePayload;
        return j.kind === 'image.generate' && p.target === 'character-portrait' && p.characterId === c.id;
      });
      if (pending.length > 0) {
        ctx.progress(`Waiting for ${c.name}'s portraits`);
        await Promise.all(pending.map((j) => waitForJob(queue, j.id, ctx.signal)));
        image = firstPortrait(store, c.id);
      }
    }
    if (!image) {
      const [job] = enqueuePortraits(queue, c, 1, run.id);
      const done = await waitForJob(queue, job!.id, ctx.signal);
      image = firstPortrait(store, c.id);
      if (!image) throw new PermanentError(`Could not generate a portrait for ${c.name}: ${done.error ?? done.status}`);
    }
    setCharacterRef(store, c.id, 'portrait', image.id);
    emitEntity(bus, 'character', c.id, 'updated', c.mangaId);
  }
}

interface GenRequest { panelId: string; patch?: RetryPatch }
interface GenFailure { panelId: string; error: string }

async function generateAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, reqs: GenRequest[], leftovers: Leftovers, jobIds: string[], label: string,
): Promise<{ done: Set<string>; failed: GenFailure[] }> {
  ctx.progress(label, 0, reqs.length); // before queueing, so the estimate is visible first
  const jobs = reqs.map((r) => {
    const adopted = leftovers.takeGenerate(r.panelId);
    if (adopted) return adopted;
    const payload: ImageGeneratePayload = { target: 'panel', panelId: r.panelId, ...r.patch };
    return deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  const done = new Set<string>();
  const failed: GenFailure[] = [];
  let count = 0;
  await Promise.all(jobs.map(async (job, i) => {
    const finished = await waitForJob(deps.queue, job.id, ctx.signal);
    const panelId = reqs[i]!.panelId;
    if (finished.status === 'succeeded' && (finished.result as ImageGenerateResult | null)?.imageId) done.add(panelId);
    else failed.push({ panelId, error: finished.error ?? finished.status });
    count++;
    // W1 R1: a failure is shown in the label and the render goes on.
    ctx.progress(failed.length > 0 ? `${label} · ${failed.length} failed` : label, count, reqs.length);
  }));
  return { done, failed };
}

async function reviewAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, panels: Panel[], leftovers: Leftovers, jobIds: string[], round: number,
): Promise<Array<{ panel: Panel; review: ReviewResult }>> {
  const lane = deps.engines.laneFor('review');
  const items = panels.flatMap((panel) => (panel.activeImageId ? [{ panel, imageId: panel.activeImageId }] : []));
  const label = `Reviewing ${items.length} images (round ${round})`;
  ctx.progress(label, 0, items.length);
  const jobs = items.map((it) => {
    const adopted = leftovers.takeReview(it.imageId);
    if (adopted) return adopted;
    const payload: ImageReviewPayload = { imageId: it.imageId, panelId: it.panel.id };
    return deps.queue.enqueue({ kind: 'image.review', lane, payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  let count = 0;
  const results = await Promise.all(jobs.map(async (job, i) => {
    await waitForJob(deps.queue, job.id, ctx.signal);
    ctx.progress(label, ++count, items.length);
    const review = deps.store.images.get(items[i]!.imageId)?.review ?? null; // a failed review counts as "not flagged"
    return review ? { panel: items[i]!.panel, review } : null;
  }));
  return results.filter((r): r is { panel: Panel; review: ReviewResult } => r !== null);
}

type PhaseCounts = Pick<RenderOutput, 'jobs' | 'reviewed' | 'flagged' | 'rounds'>;
const NOTHING_RENDERED: PhaseCounts = { jobs: [], reviewed: 0, flagged: 0, rounds: 0 };

/**
 * Renders `todo`, then batch review → re-render flagged, for at most settings.review.rounds rounds (spec §8). W1 R1: a failed
 * panel is recorded, not fatal; only a phase in which every panel failed is systemic (engine down, bad recipe) and fails the
 * step. Reviews cover the chapter's unreviewed images, never a panel whose render failed and never one in `unreviewable`.
 * `failed`: the panels whose render failed in this phase (a failed re-render in a review round keeps the first image).
 */
async function renderPanels(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, current: () => Panel[], todo: Panel[], leftovers: Leftovers, label: string,
  unreviewable: ReadonlySet<string>,
): Promise<{ counts: PhaseCounts; failed: ReadonlySet<string> }> {
  const { store } = deps;
  const settings = store.settings.get();
  const jobIds: string[] = [];
  const first = await generateAll(deps, ctx, run, todo.map((p) => ({ panelId: p.id })), leftovers, jobIds, label);
  if (todo.length > 0 && first.failed.length === todo.length) {
    const f = first.failed[0]!;
    throw new PermanentError(`All ${todo.length} panel renders failed (${f.panelId}: ${f.error}). Check the image engine, then retry the render step.`);
  }
  const failed = new Set(first.failed.map((f) => f.panelId));
  let reviewed = 0;
  let flagged = 0;
  let rounds = 0;
  if (settings.review.autoInEpisode && settings.review.rounds > 0) {
    const newSeed = deps.newSeed ?? randomSeed;
    let batch = current().filter((p) =>
      !failed.has(p.id) && !unreviewable.has(p.id) && p.activeImageId !== null && store.images.get(p.activeImageId)?.review == null);
    for (let round = 1; round <= settings.review.rounds && batch.length > 0; round++) {
      const results = await reviewAll(deps, ctx, run, batch, leftovers, jobIds, round);
      reviewed += results.length;
      const bad = results.filter((r) => !r.review.pass);
      if (bad.length === 0) break;
      rounds = round;
      flagged += bad.length;
      const again = await generateAll(
        deps, ctx, run,
        bad.map((b) => ({ panelId: b.panel.id, patch: retryPatch(b.review.issues, settings, newSeed(), retryTarget(store, settings, b.panel)) })),
        leftovers, jobIds, `Re-rendering ${bad.length} flagged panels (round ${round})`,
      );
      batch = current().filter((p) => again.done.has(p.id));
    }
  }
  return { counts: { jobs: jobIds, reviewed, flagged, rounds }, failed };
}

/**
 * Step 6 (spec §8), with W1's stops. The step's token (startedAt) marks what is done: panels rendered since it are skipped,
 * so a retry, a Continue and a resume all render only what is left.
 * - C2: with the preview off, a render whose estimate exceeds settings.episode.confirmRenderMinutes stops before any GPU
 *   work with `{confirm, panels, estimateSeconds}`. F18: a run stored before W1 (its input has no previewFirst) never stops.
 * - Q2: with the preview on, the cover and page 1 render first, then the step stops with `{preview, remainingPanels,
 *   estimateSeconds}` (no stop when nothing else is left).
 * A stop is returned as the output; the runner waits at awaiting-review in both modes. Continue keeps that output on the
 * step and dispatches it again, so `gate` is set and no second stop happens.
 */
export async function runRenderStep(deps: DriverDeps, ctx: JobContext, run: EpisodeRun): Promise<RenderOutput> {
  const { store } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const settings = store.settings.get();
  const step = run.steps[stepIndex('render')];
  const token = step?.startedAt ?? null;
  const entries = chapterPanels(store, chapter.id, manga.readingDirection);
  if (entries.length === 0) throw new PermanentError('Nothing to render: the chapter has no panels yet (the scripts step creates them)');
  const ids = entries.map((e) => e.panel.id);
  const current = (): Panel[] => ids.map((id) => store.panels.require(id));
  /**
   * Review M2: the panels whose render failed in this phase (one may keep an older image) plus every panel of `among` that
   * still has no image, in reading order, so the list matches the progress label's "N failed".
   */
  const failedPanels = (failed: ReadonlySet<string>, among: ReadonlySet<string> = new Set(ids)): string[] =>
    current().filter((p) => failed.has(p.id) || (p.activeImageId === null && among.has(p.id))).map((p) => p.id);
  const pendingWith = (leftovers: Leftovers): Panel[] =>
    current().filter((p) => !renderedSince(store, p, token) || leftovers.hasGenerate(p.id));
  const gate = renderGate(step?.output); // set: this dispatch is the Continue of that stop
  const previewed = new Set(entries.filter((e) => e.isCover || e.pageNumber === 1).map((e) => e.panel.id));

  if (gate === null && run.input.previewFirst === false) {
    const todo = pendingWith(new Leftovers(liveJobs(store, run.id)));
    // Review M4 (accepted): the stop comes before ensurePortraits, so a portrait the Continue still has to generate is not in
    // this estimate (a few recipes at most).
    const estimateSeconds = estimateRender(store, settings, manga, todo);
    if (estimateSeconds > settings.episode.confirmRenderMinutes * 60) {
      return { ...NOTHING_RENDERED, failedPanelIds: [], confirm: true, panels: todo.length, estimateSeconds };
    }
  }

  await ensurePortraits(deps, ctx, run, manga.id, current());
  // Panels rendered since this step started are done; one with an unfinished job of an earlier attempt is adopted (F11).
  const leftovers = new Leftovers(liveJobs(store, run.id));
  const todo = pendingWith(leftovers);
  const label = (panels: Panel[], what: string): string => `${what} · est. ${formatEstimate(estimateRender(store, settings, manga, panels))}`;

  if (gate === null && run.input.previewFirst === true) {
    const rest = todo.filter((p) => !previewed.has(p.id));
    if (rest.length > 0) {
      const now = todo.filter((p) => previewed.has(p.id));
      // Review M1: the preview reviews only the cover and page 1; an older image of a later page waits for the Continue.
      const later = new Set(ids.filter((id) => !previewed.has(id)));
      const phase = await renderPanels(
        deps, ctx, run, current, now, leftovers, label(now, `Rendering page 1 and the cover: ${now.length} panels`), later,
      );
      return {
        ...phase.counts, failedPanelIds: failedPanels(phase.failed, previewed), preview: true, remainingPanels: rest.length,
        estimateSeconds: estimateRender(store, settings, manga, rest),
      };
    }
  }

  // F14: the Continue after the preview never reviews a previewed panel it does not render again: the user checked that
  // page, and the preview's last review round may have re-rendered it without a review. The rest of the chapter is
  // reviewed as usual, so a Continue resumed after a restart still adopts its review jobs (F11).
  const todoIds = new Set(todo.map((p) => p.id));
  const checked = gate === 'preview' ? new Set([...previewed].filter((id) => !todoIds.has(id))) : new Set<string>();
  const phase = await renderPanels(deps, ctx, run, current, todo, leftovers, label(todo, `Rendering ${todo.length} panels`), checked);
  // Review M3: the output of the whole step, so the preview phase's jobs and review counts are kept.
  const before = gate === 'preview' ? RenderOutputSchema.parse(step?.output) : NOTHING_RENDERED;
  return {
    jobs: [...before.jobs, ...phase.counts.jobs], reviewed: before.reviewed + phase.counts.reviewed,
    flagged: before.flagged + phase.counts.flagged, rounds: Math.max(before.rounds, phase.counts.rounds),
    failedPanelIds: failedPanels(phase.failed),
  };
}
