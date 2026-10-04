// packages/server/src/workflows/auto/runner.ts
import {
  AUTO_PORTRAITS_PER_CHARACTER, EMPTY_SCRIPT, EPISODE_ACTIVE_STATUSES, MANGA_TITLE_FROM_PLAN, chapterPrompt,
  type AutoMangaInput, type AutoRun, type Character, type EpisodeInput, type EpisodeRun, type Image, type ImageGeneratePayload,
  type Job, type LlmStepPayload, type MangaPlan,
} from '@manga/shared';
import { setCharacterRef } from '../../domain/characters.js';
import { createManga } from '../../domain/mangas.js';
import { letterPage } from '../../domain/lettering.js';
import { createCoverPage } from '../../domain/pages.js';
import type { Engines } from '../../engines/resolve.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import { enqueuePortraits } from '../../imaging/portraits.js';
import { isTerminal, waitForJob, type JobContext, type JobQueue } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import type { EpisodeRunner } from '../episode/runner.js';
import { handlePlanJob } from './plan.js';

export interface AutoRunnerDeps {
  store: Store; bus: EventBus; queue: Pick<JobQueue, 'enqueue' | 'cancel' | 'waitFor'>;
  episodes: Pick<EpisodeRunner, 'start' | 'approve' | 'autopilot' | 'rerun' | 'cancel'>;
  engines: Pick<Engines, 'forLane' | 'laneFor'>;
}

/** How often a waiting driver looks at its episode run, in case it missed an event. */
export const EPISODE_POLL_MS = 5_000;
const LANES = ['claude', 'gpu', 'cpu'] as const;

const hasPortrait = (store: Store, c: Character): boolean => c.refs.portrait !== undefined && store.images.get(c.refs.portrait) !== null;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The oldest portrait image of a character: the one an unattended run picks. */
function firstPortrait(store: Store, characterId: string): Image | null {
  return store.images.listByOwner('character', characterId)
    .filter((i) => i.role === 'portrait')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** The characters the poster shows: the plan's leads (role main first, in the plan's order), at most three. */
export function posterLeads(characters: readonly Character[]): Character[] {
  const main = characters.filter((c) => c.role === 'main');
  return (main.length > 0 ? main : characters).slice(0, 3);
}

const POSITIONS: Record<number, Array<'left' | 'center' | 'right'>> = { 1: ['center'], 2: ['left', 'right'], 3: ['left', 'center', 'right'] };

/**
 * An auto-created manga (spec: manga from a prompt): the durable run row says which stage the manga is at, and one driver
 * per run walks the stages in order: plan (one story call: title, cast, a plot per chapter, notes, look) → portraits (a
 * few per character, the first becomes the reference, as an autopilot episode does) → poster → the chapters, one episode
 * run each, in autopilot, one after the other so each chapter's premise sees the chapters before it. A stage is safe to
 * run again: a restart, a retry after a failure and a resume all re-enter the loop at the stored stage and adopt the jobs and
 * episode runs that exist. The driver approves the render step's size stop itself (the whole manga's estimate was shown
 * before the start). The chapter covers are drawn by the episodes; the poster is the only picture this runner asks for.
 */
export class AutoRunner {
  private stopped = false;
  private readonly active = new Map<string, { abort: AbortController; mangaId: string }>();
  private readonly offBus: () => void;

  constructor(private readonly deps: AutoRunnerDeps) {
    // A deleted manga ends its driver: the cascade has removed the run row, so nothing is left to save.
    this.offBus = deps.bus.on((event) => {
      if (event.type !== 'entity' || event.entity !== 'manga' || event.op !== 'deleted') return;
      for (const { abort, mangaId } of this.active.values()) if (mangaId === event.id) abort.abort();
    });
  }

  get(runId: string): AutoRun {
    return this.deps.store.autoRuns.require(runId);
  }

  latest(mangaId: string): AutoRun | null {
    this.deps.store.mangas.require(mangaId);
    return this.deps.store.autoRuns.latestByManga(mangaId);
  }

  /** Creates the manga (named by the plan unless `input.title` is set) and the run, and starts driving it. */
  start(input: AutoMangaInput): AutoRun {
    const { store, bus } = this.deps;
    if (input.chapterModels.length > input.chapters) {
      throw new ValidationError(`chapterModels has ${input.chapterModels.length} entries but the manga has ${input.chapters} chapters`);
    }
    const created = store.tx(() => {
      const manga = createManga(store, {
        title: input.title === '' ? MANGA_TITLE_FROM_PLAN : input.title, synopsis: '', language: input.language,
        ...(input.colorMode ? { colorMode: input.colorMode } : {}), readingDirection: input.readingDirection,
        stylePreset: input.stylePreset, imageModel: input.imageModel,
      });
      const run = store.autoRuns.create({ mangaId: manga.id, input, status: 'running', stage: 'plan', plan: null, chapterIds: [], currentChapter: 0, error: null });
      return { manga, run };
    });
    emitEntity(bus, 'manga', created.manga.id, 'created', created.manga.id);
    emitEntity(bus, 'autoRun', created.run.id, 'created', created.manga.id);
    this.drive(created.run.id);
    return created.run;
  }

  /** Stops a running run: its driver, its unfinished jobs and the chapter's episode that is running. The manga keeps what exists. */
  cancel(runId: string): AutoRun {
    const run = this.get(runId);
    if (run.status !== 'running') throw new ConflictError(`the run is already ${run.status}`);
    this.active.get(runId)?.abort.abort();
    const saved = this.save(run, { status: 'cancelled' });
    this.cancelJobs(run);
    return saved;
  }

  /** Runs a failed or cancelled run again from its stage (a failed episode is retried at its failed step). */
  resumeRun(runId: string): AutoRun {
    const run = this.get(runId);
    if (run.status !== 'failed' && run.status !== 'cancelled') throw new ConflictError(`the run is ${run.status}, not failed or cancelled`);
    const saved = this.save(run, { status: 'running', error: null });
    this.drive(runId);
    return saved;
  }

  /** After a restart (startGlobal): drives every run that was running. */
  resume(): number {
    const runs = this.deps.store.autoRuns.listByStatus('running');
    for (const run of runs) this.drive(run.id);
    return runs.length;
  }

  /** The `llm.step {type:'manga-plan'}` handler. */
  handlePlan(ctx: JobContext, payload: LlmStepPayload): Promise<unknown> {
    return handlePlanJob({ store: this.deps.store, bus: this.deps.bus, engines: this.deps.engines }, ctx, payload);
  }

  stop(): void {
    this.stopped = true;
    this.offBus();
    for (const { abort } of this.active.values()) abort.abort();
  }

  // ---- the driver ----

  private drive(runId: string): void {
    if (this.stopped) return;
    const existing = this.active.get(runId);
    if (existing && !existing.abort.signal.aborted) return;
    const run = this.deps.store.autoRuns.get(runId);
    if (!run) return;
    const entry = { abort: new AbortController(), mangaId: run.mangaId };
    this.active.set(runId, entry);
    this.loop(runId, entry.abort.signal)
      .catch((err: unknown) => { if (!entry.abort.signal.aborted) this.failRun(runId, err); })
      .finally(() => { if (this.active.get(runId) === entry) this.active.delete(runId); })
      .catch((err: unknown) => { console.error('[manga] auto runner:', err); });
  }

  private async loop(runId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const run = this.deps.store.autoRuns.get(runId);
      if (!run || run.status !== 'running') return;
      switch (run.stage) {
        case 'plan': await this.planStage(run, signal); break;
        case 'portraits': await this.portraitsStage(run, signal); this.move(runId, { stage: 'poster' }); break;
        case 'poster': await this.posterStage(run, signal); this.move(runId, { stage: 'chapters' }); break;
        case 'chapters': await this.chaptersStage(run, signal); this.move(runId, { stage: 'done', status: 'done' }); break;
        case 'done': this.move(runId, { status: 'done' }); return;
      }
    }
  }

  /** One story call writes the plan and applies it (plan.ts); an unfinished plan job of this run is adopted. */
  private async planStage(run: AutoRun, signal: AbortSignal): Promise<void> {
    const { queue, engines } = this.deps;
    const job = this.findJob((p) => p.type === 'manga-plan' && p.autoRunId === run.id)
      ?? queue.enqueue({ kind: 'llm.step', lane: engines.laneFor('story'), payload: { type: 'manga-plan', autoRunId: run.id } satisfies LlmStepPayload, maxAttempts: 2 });
    const done = await waitForJob(queue, job.id, signal);
    if (this.deps.store.autoRuns.get(run.id)?.stage === 'plan') {
      throw new Error(done.status === 'cancelled' ? 'The series plan was cancelled' : done.error ?? 'The series plan could not be written');
    }
  }

  /** A few portrait variants per character without one; the oldest becomes its reference. Characters already set stay. */
  private async portraitsStage(run: AutoRun, signal: AbortSignal): Promise<void> {
    const { store, queue, bus } = this.deps;
    const missing = store.characters.listByManga(run.mangaId).filter((c) => !hasPortrait(store, c));
    const pending = LANES.flatMap((lane) => store.jobs.listUnfinished(lane, ['image.generate']));
    const waits: Array<Promise<Job>> = [];
    for (const c of missing) {
      const mine = pending.filter((j) => {
        const p = j.payload as ImageGeneratePayload;
        return p.target === 'character-portrait' && p.characterId === c.id;
      });
      const jobs = mine.length > 0 || firstPortrait(store, c.id) !== null ? mine : enqueuePortraits(queue, c, AUTO_PORTRAITS_PER_CHARACTER);
      waits.push(...jobs.map((j) => waitForJob(queue, j.id, signal)));
    }
    await Promise.all(waits);
    for (const c of missing) {
      const image = firstPortrait(store, c.id);
      if (!image) continue; // the chapters' render steps say so when a character without a portrait is on a panel
      setCharacterRef(store, c.id, 'portrait', image.id);
      emitEntity(bus, 'character', c.id, 'updated', run.mangaId);
    }
  }

  /**
   * The manga's poster: its cover page, one panel of the leads, a scene prompt written by the same step as the editor's
   * "AI write prompt", the picture, and the title frame. Optional, so a failure is a note on the run (`error`) and the
   * chapters go on. A poster that already has its picture is left alone.
   */
  private async posterStage(run: AutoRun, signal: AbortSignal): Promise<void> {
    const { store, bus, queue, engines } = this.deps;
    const plan = run.plan;
    if (!run.input.poster || plan === null) return;
    try {
      const manga = store.mangas.require(run.mangaId);
      const before = manga.coverPageId;
      const detail = createCoverPage(store, manga.id, null);
      if (detail.page.id !== before) {
        emitEntity(bus, 'page', detail.page.id, 'created', manga.id);
        emitEntity(bus, 'manga', manga.id, 'updated', manga.id);
      }
      const panel = detail.panels[0];
      if (!panel || panel.activeImageId !== null) return;
      const leads = posterLeads(store.characters.listByManga(manga.id));
      const positions = POSITIONS[leads.length] ?? ['center'];
      store.panels.update(panel.id, {
        script: {
          ...EMPTY_SCRIPT, action: `Series poster: ${plan.poster.action} Calm, simple space in the top third for the title.`,
          shot: 'medium', angle: 'low', background: plan.poster.background,
          characters: leads.map((c, i) => ({ characterId: c.id, pose: 'facing the reader', expression: 'determined', position: positions[i] ?? 'center' })),
        },
        refCharacterIds: leads.map((c) => c.id),
      });
      emitEntity(bus, 'panel', panel.id, 'updated', manga.id);
      const prompt = queue.enqueue({
        kind: 'llm.step', lane: engines.laneFor('prompts'), payload: { type: 'panel-prompt', panelId: panel.id } satisfies LlmStepPayload,
      });
      const written = await waitForJob(queue, prompt.id, signal);
      if (written.status !== 'succeeded') throw new Error(`the poster's prompt failed: ${written.error ?? written.status}`);
      const image = queue.enqueue({ kind: 'image.generate', lane: 'gpu', payload: { target: 'panel', panelId: panel.id } satisfies ImageGeneratePayload });
      const drawn = await waitForJob(queue, image.id, signal);
      if (drawn.status !== 'succeeded') throw new Error(`the poster's picture failed: ${drawn.error ?? drawn.status}`);
      for (const frame of letterPage(store, detail.page.id)) emitEntity(bus, 'textFrame', frame.id, 'created', manga.id);
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof NotFoundError) throw err; // the manga is gone
      console.warn(`[manga] auto run ${run.id}: no poster: ${messageOf(err)}`);
      this.note(run.id, `No poster: ${messageOf(err)}`);
    }
  }

  /** The chapters in order; each is an autopilot episode run, adopted when it exists. Fails on the first one that does not finish. */
  private async chaptersStage(run: AutoRun, signal: AbortSignal): Promise<void> {
    const { store } = this.deps;
    const plan = run.plan;
    if (plan === null) throw new Error('the run has no plan');
    for (let i = run.currentChapter; i < run.chapterIds.length; i++) {
      signal.throwIfAborted();
      const fresh = store.autoRuns.get(run.id);
      if (!fresh || fresh.status !== 'running') return;
      if (fresh.currentChapter !== i) this.move(run.id, { currentChapter: i });
      await this.writeChapter(run.id, plan, run.chapterIds[i]!, i, signal);
    }
  }

  private async writeChapter(runId: string, plan: MangaPlan, chapterId: string, index: number, signal: AbortSignal): Promise<void> {
    const { store, episodes } = this.deps;
    const run = this.get(runId);
    const chapter = store.chapters.require(chapterId);
    const planned = plan.chapters[index]!;
    let episode = store.episodes.latestByChapter(chapterId);
    if (episode?.status === 'done') return;
    if (episode === null) {
      const input: EpisodeInput = {
        prompt: chapterPrompt(plan, planned, index + 1, plan.chapters.length), notes: plan.notes, tone: plan.tone,
        pages: run.input.pagesPerChapter, characterIds: [], previewFirst: false,
      };
      episode = episodes.start(chapterId, input, 'autopilot');
    } else if (!EPISODE_ACTIVE_STATUSES.has(episode.status)) {
      // Failed or cancelled earlier (a retry of this run): its failed step runs again, the rest of its work is kept.
      episode = episodes.rerun(episode.id, episode.steps[episode.currentStep]!.name, false);
    }
    if (episode.mode !== 'autopilot') episode = episodes.autopilot(episode.id);
    const finished = await this.waitEpisode(episode.id, signal);
    if (finished.status !== 'done') {
      const step = finished.steps[finished.currentStep];
      throw new Error(`Chapter ${chapter.number} "${chapter.title}" ${finished.status}${step?.error ? `: ${step.error}` : ''}`);
    }
    await this.waitSummary(finished.id, signal);
  }

  /**
   * Resolves when the episode run is done, failed or cancelled. A run waiting at the render step's preview or size stop is
   * approved (the manga's estimate was shown before the start); a paused run waits for the user to resume it.
   */
  private waitEpisode(runId: string, signal: AbortSignal): Promise<EpisodeRun> {
    const { store, bus, episodes } = this.deps;
    return new Promise<EpisodeRun>((resolve, reject) => {
      let off: () => void = () => undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (done: () => void): void => {
        off();
        clearInterval(timer);
        signal.removeEventListener('abort', onAbort);
        done();
      };
      const onAbort = (): void => finish(() => reject(signal.reason as unknown));
      const check = (): void => {
        const run = store.episodes.get(runId);
        if (!run) return finish(() => reject(new Error('the chapter run is gone')));
        if (run.status === 'awaiting-review') {
          try {
            episodes.approve(run.id);
          } catch (err) {
            if (!(err instanceof ConflictError)) finish(() => reject(err));
          }
          return;
        }
        if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') finish(() => resolve(run));
      };
      off = bus.on((e) => { if (e.type === 'entity' && e.entity === 'episodeRun' && e.id === runId) check(); });
      timer = setInterval(check, EPISODE_POLL_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  /** The finished chapter's summary job (the next chapter's premise reads it); its failure never matters. */
  private async waitSummary(runId: string, signal: AbortSignal): Promise<void> {
    const { store, queue } = this.deps;
    const job = store.jobs.listByEpisodeRun(runId).find((j) => {
      const p = j.payload as { type?: string } | null;
      return !isTerminal(j.status) && j.kind === 'llm.step' && p?.type === 'chapter-summary';
    });
    if (job) await waitForJob(queue, job.id, signal);
  }

  // ---- internals ----

  /** An unfinished llm.step job of any lane whose payload satisfies `match`. */
  private findJob(match: (payload: { type?: string; autoRunId?: string }) => boolean): Job | null {
    for (const lane of LANES) {
      const found = this.deps.store.jobs.listUnfinished(lane, ['llm.step']).find((j) => match((j.payload ?? {}) as { type?: string; autoRunId?: string }));
      if (found) return found;
    }
    return null;
  }

  /** Cancels what a cancelled run left queued or running: its plan job, its characters' portraits, its poster, its chapter's episode. */
  private cancelJobs(run: AutoRun): void {
    const { store, queue, episodes } = this.deps;
    const plan = this.findJob((p) => p.type === 'manga-plan' && p.autoRunId === run.id);
    if (plan) queue.cancel(plan.id);
    const characters = new Set(store.characters.listByManga(run.mangaId).map((c) => c.id));
    const cover = store.mangas.get(run.mangaId)?.coverPageId ?? null;
    const posterPanels = new Set(cover === null ? [] : store.panels.listByPage(cover).map((p) => p.id));
    for (const lane of LANES) {
      for (const job of store.jobs.listUnfinished(lane, ['image.generate', 'llm.step'])) {
        const p = (job.payload ?? {}) as { type?: string; target?: string; characterId?: string; panelId?: string };
        const portrait = p.target === 'character-portrait' && p.characterId !== undefined && characters.has(p.characterId);
        const poster = (p.target === 'panel' || p.type === 'panel-prompt') && p.panelId !== undefined && posterPanels.has(p.panelId);
        if (portrait || poster) queue.cancel(job.id);
      }
    }
    const chapterId = run.chapterIds[run.currentChapter];
    const episode = chapterId === undefined ? null : store.episodes.latestByChapter(chapterId);
    if (episode && EPISODE_ACTIVE_STATUSES.has(episode.status)) {
      try {
        episodes.cancel(episode.id);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }
  }

  private failRun(runId: string, err: unknown): void {
    try {
      const run = this.deps.store.autoRuns.get(runId);
      if (!run || run.status !== 'running') return;
      this.save(run, { status: 'failed', error: messageOf(err) });
    } catch (inner) {
      console.error('[manga] auto runner: could not fail run', runId, inner);
    }
  }

  /** Moves the run on; no-op once it is no longer running (a cancel that raced the driver stays cancelled). */
  private move(runId: string, patch: Partial<Pick<AutoRun, 'stage' | 'status' | 'currentChapter'>>): void {
    const run = this.deps.store.autoRuns.get(runId);
    if (run && run.status === 'running') this.save(run, patch);
  }

  /** A non-fatal note about a part that was skipped; it stays on the run when it finishes. */
  private note(runId: string, text: string): void {
    const run = this.deps.store.autoRuns.get(runId);
    if (run) this.save(run, { error: text });
  }

  private save(run: AutoRun, patch: Partial<Pick<AutoRun, 'stage' | 'status' | 'currentChapter' | 'error'>>): AutoRun {
    const next = this.deps.store.autoRuns.update(run.id, patch);
    emitEntity(this.deps.bus, 'autoRun', next.id, 'updated', next.mangaId);
    return next;
  }
}
