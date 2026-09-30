import {
  BreakdownOutputSchema, EDITABLE_STEPS, EPISODE_STEPS, OutlineOutputSchema, PremiseOutputSchema, PromptsOutputSchema,
  REVIEW_POINTS, STEP_TASK, ScriptsOutputSchema, panelIds, stepIndex,
  type Chapter, type EpisodeInput, type EpisodeRun, type EpisodeStepName, type ImageGeneratePayload, type Job, type LlmStepPayload,
} from '@manga/shared';
import { deletePage } from '../../domain/delete.js';
import { NeedsConfirmError } from '../../domain/pages.js';
import { InvalidOutputError } from '../../engines/errors.js';
import type { Engines } from '../../engines/resolve.js';
import { ConflictError, ValidationError } from '../../errors.js';
import { emitEntity, type EventBus } from '../../events/bus.js';
import { enqueuePortraits } from '../../imaging/portraits.js';
import { isTerminal, PermanentError, waitForJob, type JobContext } from '../../jobs/index.js';
import type { EpisodePatch, Store } from '../../store/index.js';
import { storyPages } from './chapter.js';
import { applyPremise, applyPrompts, applyScripts, createOutlineCharacters, materializeScripts, type EffectDeps } from './effects.js';
import { runLetteringStep } from './lettering.js';
import { executeLlmStep, rawOutputError } from './llm.js';
import { runRenderStep, type DriverDeps, type QueueLike } from './render.js';
import { freshStep, freshSteps, monotonicIso, nowIso, patchStep, requireOutput } from './steps.js';
import { validationSchema } from './validation.js';

/** I1 (F1): an LLM step runs on the engine of its job's lane (`forLane`); `laneFor` picks that lane at enqueue time. */
export interface RunnerDeps { store: Store; bus: EventBus; queue: QueueLike; engines: Pick<Engines, 'forLane' | 'laneFor'>; newSeed?: () => number }

/** Outline acceptance queues this many portrait variants per new character (spec §8; the sheet stays manual, F36). */
export const PORTRAITS_PER_NEW_CHARACTER = 4;

const ACTIVE: ReadonlySet<EpisodeRun['status']> = new Set(['running', 'awaiting-review']);

const isPortraitJob = (job: Job): boolean =>
  job.kind === 'image.generate' && (job.payload as ImageGeneratePayload | null)?.target === 'character-portrait';

/**
 * The durable episode state machine (spec §8). Every transition is written to the run row first; the step jobs are
 * `llm.step {type:'episode'}` jobs tagged with the run id. A step's `startedAt` is its token: a result or failure
 * that arrives for another token (the step was re-run meanwhile) is discarded.
 */
export class EpisodeRunner {
  private stopped = false;
  /** Aborted by stop(): releases every job watch (they would otherwise wait for jobs a shutdown re-queues). */
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: RunnerDeps) {}

  get(runId: string): EpisodeRun {
    return this.deps.store.episodes.require(runId);
  }

  latest(chapterId: string): EpisodeRun | null {
    this.deps.store.chapters.require(chapterId);
    return this.deps.store.episodes.latestByChapter(chapterId);
  }

  start(chapterId: string, input: EpisodeInput, mode: EpisodeRun['mode']): EpisodeRun {
    const { store } = this.deps;
    const chapter = store.chapters.require(chapterId);
    const latest = store.episodes.latestByChapter(chapterId);
    if (latest && ACTIVE.has(latest.status)) throw new ConflictError('an episode run is already active for this chapter; cancel it first');
    if (storyPages(store, chapterId).length > 0) throw new ConflictError('the chapter already has pages; start the episode in an empty chapter');
    for (const id of input.characterIds) {
      if (store.characters.require(id).mangaId !== chapter.mangaId) throw new ValidationError(`character ${id} belongs to another manga`);
    }
    const run = store.episodes.create({ chapterId, input, mode, steps: freshSteps(), currentStep: 0, status: 'running' });
    this.emitRun(run, 'created');
    this.setChapterStatus(chapterId, 'generating');
    this.dispatch(run.id);
    return this.get(run.id);
  }

  approve(runId: string): EpisodeRun {
    const run = this.get(runId);
    const idx = run.currentStep;
    if (run.status !== 'awaiting-review' || run.steps[idx]?.status !== 'awaiting-review') {
      throw new ConflictError('nothing to approve: the run is not waiting for review');
    }
    const saved = this.save(run, { status: 'running', steps: patchStep(run.steps, idx, { status: 'done' }) });
    this.accept(saved, idx);
    return this.get(runId);
  }

  /** "Run to end": no more review points; approves the step that is waiting, if any. */
  autopilot(runId: string): EpisodeRun {
    const run = this.get(runId);
    if (!ACTIVE.has(run.status)) throw new ConflictError(`the run is ${run.status}`);
    const saved = this.save(run, { mode: 'autopilot' });
    return saved.status === 'awaiting-review' ? this.approve(runId) : saved;
  }

  cancel(runId: string): EpisodeRun {
    const run = this.get(runId);
    if (!ACTIVE.has(run.status)) throw new ConflictError(`the run is already ${run.status}`);
    const steps = run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const, error: 'Cancelled', finishedAt: nowIso() } : s));
    const saved = this.save(run, { steps, status: 'cancelled' });
    this.cancelJobs(run.id, { keepPortraits: false });
    this.setChapterStatus(run.chapterId, 'draft');
    return saved;
  }

  editOutput(runId: string, name: EpisodeStepName, output: unknown): EpisodeRun {
    const run = this.get(runId);
    const idx = stepIndex(name);
    const step = run.steps[idx]!;
    if (!EDITABLE_STEPS.has(name)) throw new ValidationError(`the ${name} output is informational and cannot be edited`);
    if (step.status !== 'awaiting-review' && step.status !== 'done') {
      throw new ConflictError(`step ${name} has no output to edit (it is ${step.status})`);
    }
    const value = validationSchema(this.deps.store, run, name).parse(output); // ZodError → 400 validation
    const fx = this.effectDeps();
    if (name === 'premise') applyPremise(fx, run.chapterId, PremiseOutputSchema.parse(value));
    if (name === 'scripts') applyScripts(fx, run.chapterId, ScriptsOutputSchema.parse(value));
    if (name === 'prompts') applyPrompts(fx, run.chapterId, PromptsOutputSchema.parse(value), { source: 'user' }); // verbatim (F2)
    const fresh = this.get(runId);
    return this.save(fresh, { steps: patchStep(fresh.steps, idx, { output: value }) });
  }

  /**
   * Re-runs `name` and resets every later step. A failed current step keeps its token (a retry: the render step then
   * continues where it stopped). Replacing the chapter's story pages needs `confirm` (F24 message). Queued outline
   * portraits survive (F12): they belong to the characters, not to a step.
   */
  rerun(runId: string, name: EpisodeStepName, confirm: boolean): EpisodeRun {
    const { store } = this.deps;
    const run = this.get(runId);
    const idx = stepIndex(name);
    if (store.episodes.latestByChapter(run.chapterId)?.id !== run.id) throw new ConflictError('only the latest run of a chapter can be re-run');
    const target = run.steps[idx]!;
    if (idx > run.currentStep || target.status === 'pending') throw new ConflictError(`step ${name} has not run yet`);
    const pages = storyPages(store, run.chapterId);
    const replacesPages = idx <= stepIndex('scripts') && pages.length > 0;
    if (replacesPages && !confirm) {
      throw new NeedsConfirmError(pages.flatMap((p) => panelIds(p.layout)), `re-running ${name} replaces the chapter's pages; resend with confirm=true`);
    }
    this.cancelJobs(run.id, { keepPortraits: true });
    if (replacesPages) for (const page of pages) this.deletePage(page.id);
    const retry = target.status === 'failed' && idx === run.currentStep;
    const steps = run.steps.map((s, i) => {
      if (i < idx) return s;
      if (i === idx && retry) return { ...s, status: 'pending' as const, error: null, finishedAt: null };
      return freshStep(s.name);
    });
    this.save(this.get(runId), { steps, currentStep: idx, status: 'running' });
    this.setChapterStatus(run.chapterId, 'generating');
    this.dispatch(run.id);
    return this.get(run.id);
  }

  /**
   * After a restart (episodeModule.start), for the latest run of every chapter that is `running`: a pending current
   * step is dispatched; a running one is re-attached to its unfinished job, or enqueued again when there is none;
   * a done one (the process stopped between completing it and moving on) is accepted. Returns how many runs moved.
   */
  resume(): number {
    const { store } = this.deps;
    let resumed = 0;
    for (const manga of store.mangas.list()) {
      for (const chapter of store.chapters.listByManga(manga.id)) {
        const run = store.episodes.latestByChapter(chapter.id);
        const step = run?.steps[run.currentStep];
        if (!run || run.status !== 'running' || !step) continue;
        if (step.status === 'pending') {
          this.dispatch(run.id);
        } else if (step.status === 'running') {
          const token = step.startedAt ?? this.stampToken(run, run.currentStep);
          const job = this.findStepJob(run.id, step.name);
          if (job) this.watch(run.id, step.name, token, job.id);
          else this.enqueueStep(run.id, step.name, token);
        } else if (step.status === 'done') {
          this.accept(run, run.currentStep);
        } else {
          continue;
        }
        resumed++;
      }
    }
    return resumed;
  }

  /** The `llm.step {type:'episode'}` handler. */
  async handleStepJob(ctx: JobContext, payload: LlmStepPayload): Promise<unknown> {
    if (payload.type !== 'episode') throw new PermanentError(`not an episode step: ${payload.type}`);
    const idx = stepIndex(payload.step);
    const run = this.deps.store.episodes.get(payload.runId);
    const step = run?.steps[idx];
    if (!run || !step || run.status !== 'running' || run.currentStep !== idx || step.status !== 'running') return { skipped: true };
    const token = step.startedAt;
    const output = await this.execute(ctx, run, payload.step);
    const fresh = this.deps.store.episodes.get(run.id);
    const now = fresh?.steps[idx];
    if (!fresh || !now || fresh.status !== 'running' || now.status !== 'running' || now.startedAt !== token) return { skipped: true };
    try {
      this.applyResult(fresh, payload.step, output);
    } catch (err) {
      // An LLM answer the effect cannot use (e.g. no usable scene for a panel): fail like an invalid answer.
      throw err instanceof InvalidOutputError ? rawOutputError(err) : err;
    }
    this.complete(fresh.id, idx, output);
    return { step: payload.step };
  }

  stop(): void {
    this.stopped = true;
    this.lifetime.abort(new Error('episode runner stopped'));
  }

  // ---- internals ----

  private execute(ctx: JobContext, run: EpisodeRun, name: EpisodeStepName): Promise<unknown> {
    if (name === 'render') return runRenderStep(this.driverDeps(), ctx, run);
    if (name === 'lettering') return runLetteringStep(this.effectDeps(), ctx, run);
    return executeLlmStep(this.deps, ctx, run, name);
  }

  /** premise → chapter, scripts → pages and panels, prompts → panel prompts (finished like M2's panel-prompt, F2). */
  private applyResult(run: EpisodeRun, name: EpisodeStepName, output: unknown): void {
    const fx = this.effectDeps();
    if (name === 'premise') applyPremise(fx, run.chapterId, PremiseOutputSchema.parse(output));
    if (name === 'scripts') {
      materializeScripts(fx, run.chapterId, {
        breakdown: requireOutput(run, 'breakdown', BreakdownOutputSchema), scripts: ScriptsOutputSchema.parse(output),
        premise: requireOutput(run, 'premise', PremiseOutputSchema),
      });
    }
    if (name === 'prompts') applyPrompts(fx, run.chapterId, PromptsOutputSchema.parse(output), { source: 'llm' });
  }

  private complete(runId: string, idx: number, output: unknown): void {
    const run = this.get(runId);
    const pause = REVIEW_POINTS.has(EPISODE_STEPS[idx]!) && run.mode === 'review';
    const steps = patchStep(run.steps, idx, { status: pause ? 'awaiting-review' : 'done', output, error: null, finishedAt: nowIso() });
    const saved = this.save(run, pause ? { steps, status: 'awaiting-review' } : { steps });
    if (!pause) this.accept(saved, idx);
  }

  private accept(run: EpisodeRun, idx: number): void {
    if (EPISODE_STEPS[idx] === 'outline') this.createCharacters(run);
    if (idx >= EPISODE_STEPS.length - 1) {
      this.save(this.get(run.id), { status: 'done' });
      this.setChapterStatus(run.chapterId, 'ready');
      return;
    }
    this.save(this.get(run.id), { currentStep: idx + 1 });
    this.dispatch(run.id);
  }

  /** Outline acceptance (spec §8, F36): the new characters, plus portrait variants; autopilot picks the first at render time. */
  private createCharacters(run: EpisodeRun): void {
    const outline = requireOutput(run, 'outline', OutlineOutputSchema);
    const chapter = this.deps.store.chapters.require(run.chapterId);
    const created = createOutlineCharacters(this.effectDeps(), chapter.mangaId, outline.newCharacters); // skips existing names
    for (const c of created) enqueuePortraits(this.deps.queue, c, PORTRAITS_PER_NEW_CHARACTER, run.id);
  }

  private dispatch(runId: string): void {
    if (this.stopped) return;
    const run = this.get(runId);
    const step = run.steps[run.currentStep];
    if (run.status !== 'running' || !step || step.status !== 'pending') return;
    const token = step.startedAt ?? monotonicIso();
    this.save(run, { steps: patchStep(run.steps, run.currentStep, { status: 'running', startedAt: token, error: null, finishedAt: null }) });
    this.enqueueStep(run.id, step.name, token);
  }

  /** A running step without a token (never written by this runner): give it one so late results can be matched. */
  private stampToken(run: EpisodeRun, idx: number): string {
    const token = monotonicIso();
    this.save(run, { steps: patchStep(run.steps, idx, { startedAt: token }) });
    return token;
  }

  private enqueueStep(runId: string, name: EpisodeStepName, token: string): void {
    const task = STEP_TASK[name];
    const payload: LlmStepPayload = { type: 'episode', runId, step: name };
    const job = this.deps.queue.enqueue(task
      ? { kind: 'llm.step', lane: this.deps.engines.laneFor(task), payload, episodeRunId: runId }
      : { kind: 'llm.step', lane: 'cpu', payload, episodeRunId: runId, maxAttempts: 1 });
    this.watch(runId, name, token, job.id);
  }

  /** A failed or cancelled step job fails the step (and the run), unless the step was re-run meanwhile. */
  private watch(runId: string, name: EpisodeStepName, token: string, jobId: string): void {
    waitForJob(this.deps.queue, jobId, this.lifetime.signal).then(
      (job) => { if (job.status !== 'succeeded') this.failStep(runId, name, token, job.status === 'cancelled' ? 'Cancelled' : job.error ?? 'Step failed'); },
      () => undefined, // the runner stopped
    );
  }

  private failStep(runId: string, name: EpisodeStepName, token: string, error: string): void {
    if (this.stopped) return;
    const run = this.deps.store.episodes.get(runId);
    const idx = stepIndex(name);
    const step = run?.steps[idx];
    if (!run || !step || step.status !== 'running' || step.startedAt !== token) return;
    const status: EpisodeRun['status'] = run.status === 'running' ? 'failed' : run.status;
    this.save(run, { status, steps: patchStep(run.steps, idx, { status: 'failed', error, finishedAt: nowIso() }) });
    if (status === 'failed') this.setChapterStatus(run.chapterId, 'draft');
  }

  /** The unfinished job of a step, if any (F11: the run's own jobs, no table scan over every job). */
  private findStepJob(runId: string, name: EpisodeStepName): Job | null {
    return this.deps.store.jobs.listByEpisodeRun(runId).find((j) => {
      const p = j.payload as { type?: string; step?: string } | null;
      return !isTerminal(j.status) && j.kind === 'llm.step' && p?.type === 'episode' && p.step === name;
    }) ?? null;
  }

  /** Cancels the run's unfinished jobs; a rerun keeps the character portraits (F12), a run cancel does not. */
  private cancelJobs(runId: string, opts: { keepPortraits: boolean }): void {
    for (const job of this.deps.store.jobs.listByEpisodeRun(runId)) {
      if (isTerminal(job.status) || (opts.keepPortraits && isPortraitJob(job))) continue;
      this.deps.queue.cancel(job.id);
    }
  }

  /** Deletes a page and emits exactly what DELETE /api/pages/:id emits (F7, G5). */
  private deletePage(pageId: string): void {
    const { bus } = this.deps;
    const { page, panelIds: removed, clearedCoverOf } = deletePage(this.deps.store, pageId);
    for (const id of removed) emitEntity(bus, 'panel', id, 'deleted', page.mangaId);
    emitEntity(bus, 'page', page.id, 'deleted', page.mangaId);
    if (clearedCoverOf !== null) emitEntity(bus, clearedCoverOf.entity, clearedCoverOf.id, 'updated', page.mangaId);
  }

  private effectDeps(): EffectDeps {
    return { store: this.deps.store, bus: this.deps.bus };
  }

  private driverDeps(): DriverDeps {
    const { store, bus, queue, engines, newSeed } = this.deps;
    return { store, bus, queue, engines, ...(newSeed ? { newSeed } : {}) };
  }

  private save(run: EpisodeRun, patch: EpisodePatch): EpisodeRun {
    const next = this.deps.store.episodes.update(run.id, patch);
    this.emitRun(next, 'updated');
    return next;
  }

  private emitRun(run: EpisodeRun, op: 'created' | 'updated'): void {
    emitEntity(this.deps.bus, 'episodeRun', run.id, op, this.deps.store.chapters.get(run.chapterId)?.mangaId ?? null);
  }

  private setChapterStatus(chapterId: string, status: Chapter['status']): void {
    const chapter = this.deps.store.chapters.update(chapterId, { status });
    emitEntity(this.deps.bus, 'chapter', chapter.id, 'updated', chapter.mangaId);
  }
}
