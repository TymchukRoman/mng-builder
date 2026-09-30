import {
  estimateReviewSeconds, estimateSeconds, formatEstimate, hasNoHumansTag, stepIndex,
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
/** How many of a panel's cast are girls, boys and others (from the count tag in each character's appearanceTags). */
export interface CastCount { girl: number; boy: number; other: number }
/** What a retry needs to know about the flagged panel. `style` is the prompt style of the recipe the panel routes to. */
export interface RetryTarget { cast: CastCount; hasPortraitRefs: boolean; style: PromptStyle }

const MAX_COUNTED = 5;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * Genders come from the `1girl`/`1boy` tag each character's appearanceTags starts with; anything else counts as other.
 * A `no humans` character (a pet, a creature) is not a person and is not counted: the live smoke's kitten turned a
 * one-girl panel into "Exactly two people", and the retry drew a second girl.
 */
export function castCount(cast: Array<Pick<Character, 'appearanceTags'>>): CastCount {
  const count: CastCount = { girl: 0, boy: 0, other: 0 };
  for (const c of cast) {
    if (hasNoHumansTag(c.appearanceTags)) continue; // any spelling: no_humans, No Humans, no human (M4 final S4)
    const tags = c.appearanceTags.split(',').map((t) => t.trim().toLowerCase());
    count[tags.includes('1girl') ? 'girl' : tags.includes('1boy') ? 'boy' : 'other'] += 1;
  }
  return count;
}

const total = (c: CastCount): number => c.girl + c.boy + c.other;
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/**
 * The Danbooru people-count tag for the tags style (the M2 tag prompts' convention: `solo`, `2girls`, `1boy, 1girl`,
 * `multiple boys`, `no humans`).
 */
export function countTag(count: CastCount): string {
  const n = total(count);
  if (n === 0) return 'no humans';
  if (n === 1) return 'solo';
  return (['boy', 'girl', 'other'] as const)
    .filter((kind) => count[kind] > 0)
    .map((kind) => {
      const k = count[kind];
      return k === 1 ? `1${kind}` : k <= MAX_COUNTED ? `${k}${kind}s` : `multiple ${kind}s`;
    })
    .join(', ');
}

/** The people count as a sentence for the natural style (qwen/klein scenes are plain English sentences). */
export function countSentence(count: CastCount): string {
  const n = total(count);
  if (n === 0) return 'No people.';
  if (n === 1) return 'Exactly one person.';
  const head = `Exactly ${numberWord(n)} people`;
  if (count.other === n) return `${head}.`;
  const nouns: Record<keyof CastCount, [string, string]> = { girl: ['girl', 'girls'], boy: ['boy', 'boys'], other: ['other person', 'other people'] };
  const parts = (['girl', 'boy', 'other'] as const)
    .filter((kind) => count[kind] > 0)
    .map((kind) => `${numberWord(count[kind])} ${nouns[kind][count[kind] === 1 ? 0 : 1]}`);
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
  return `${head}: ${list}.`;
}

/**
 * The retry facts of a panel: its script cast (the characters that exist in this manga, as panelCharacters keeps
 * them), whether a referenced character has a portrait (F31), and the prompt style of the recipe it routes to.
 */
export function retryTarget(store: Store, settings: Settings, panel: Panel): RetryTarget {
  const { manga, characters, refCharacters } = panelContext(store, panel.id);
  const cast = [...new Set(panel.script.characters.map((c) => c.characterId))]
    .map((id) => store.characters.get(id))
    .filter((c): c is Character => c !== null && c.mangaId === manga.id);
  const route = routeRecipe({ settings, manga, panel, refCount: refCharacters.length, charCount: characters.length });
  return {
    cast: castCount(cast),
    hasPortraitRefs: refCharacters.some((c) => c.refs.portrait !== undefined && store.images.get(c.refs.portrait) !== null),
    style: promptStyleFor(route.recipe),
  };
}

/**
 * Spec §8 retry strategy, always with a new seed:
 * - identity → the drift recipe, only when the panel references a character with a portrait (F31: it needs refs);
 * - text → a stronger negative; anatomy → the anatomy negative (F14);
 * - character-count → the panel's people count in the scene (F14, amended): a tag for the tags style, a sentence for the
 *   natural style, judged on the recipe the retry actually uses;
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
  const count = style === 'natural' ? countSentence(target.cast) : countTag(target.cast);
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

async function generateAll(
  deps: DriverDeps, ctx: JobContext, run: EpisodeRun, reqs: GenRequest[], leftovers: Leftovers, jobIds: string[], label: string,
): Promise<{ done: Set<string>; failed: string[] }> {
  ctx.progress(label, 0, reqs.length); // before queueing, so the estimate is visible first
  const jobs = reqs.map((r) => {
    const adopted = leftovers.takeGenerate(r.panelId);
    if (adopted) return adopted;
    const payload: ImageGeneratePayload = { target: 'panel', panelId: r.panelId, ...r.patch };
    return deps.queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload, episodeRunId: run.id });
  });
  jobIds.push(...jobs.map((j) => j.id));
  const done = new Set<string>();
  const failed: string[] = [];
  let count = 0;
  await Promise.all(jobs.map(async (job, i) => {
    const finished = await waitForJob(deps.queue, job.id, ctx.signal);
    const panelId = reqs[i]!.panelId;
    if (finished.status === 'succeeded' && (finished.result as ImageGenerateResult | null)?.imageId) done.add(panelId);
    else failed.push(`${panelId}: ${finished.error ?? finished.status}`);
    ctx.progress(label, ++count, reqs.length);
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

/** Step 6 (spec §8): render, then batch review → re-render flagged, for at most settings.review.rounds rounds. */
export async function runRenderStep(deps: DriverDeps, ctx: JobContext, run: EpisodeRun): Promise<RenderOutput> {
  const { store } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const manga = store.mangas.require(chapter.mangaId);
  const settings = store.settings.get();
  const token = run.steps[stepIndex('render')]?.startedAt ?? null;
  const ids = chapterPanels(store, chapter.id, manga.readingDirection).map((e) => e.panel.id);
  if (ids.length === 0) throw new PermanentError('Nothing to render: the chapter has no panels yet (the scripts step creates them)');
  const current = (): Panel[] => ids.map((id) => store.panels.require(id));

  await ensurePortraits(deps, ctx, run, manga.id, current());
  const leftovers = new Leftovers(liveJobs(store, run.id));
  // Panels rendered since this step started are done; one with an unfinished job of an earlier attempt is adopted (F11).
  const todo = current().filter((p) => !renderedSince(store, p, token) || leftovers.hasGenerate(p.id));
  const jobIds: string[] = [];
  const estimate = formatEstimate(estimateRender(store, settings, manga, todo));
  const first = await generateAll(
    deps, ctx, run, todo.map((p) => ({ panelId: p.id })), leftovers, jobIds, `Rendering ${todo.length} panels · est. ${estimate}`,
  );
  if (first.failed.length > 0) {
    throw new PermanentError(
      `${first.failed.length} of ${todo.length} panel renders failed (${first.failed[0]}). Retry the render step to render only the missing panels.`,
    );
  }

  let reviewed = 0;
  let flagged = 0;
  let rounds = 0;
  if (settings.review.autoInEpisode && settings.review.rounds > 0) {
    const newSeed = deps.newSeed ?? randomSeed;
    let batch = current().filter((p) => p.activeImageId !== null && store.images.get(p.activeImageId)?.review == null);
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
  return { jobs: jobIds, reviewed, flagged, rounds };
}
