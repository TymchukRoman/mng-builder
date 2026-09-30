import { STEP_TASK, type EngineName, type Job, type JobKind, type Lane, type Settings, type Task } from '@manga/shared';
import { PermanentError, type JobQueue } from '../jobs/index.js';
import type { Store } from '../store/index.js';
import type { TextEngine } from './types.js';

export function resolveEngine(settings: Settings, task: Task): EngineName {
  return settings.engine.tasks[task] ?? settings.engine.mode;
}

export class Engines {
  constructor(private readonly opts: { settings: () => Settings; claude: TextEngine; local: TextEngine }) {}

  for(task: Task): TextEngine {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? this.opts.claude : this.opts.local;
  }

  /** Claude work runs in the 'claude' lane; local LLM work shares the GPU with ComfyUI. */
  laneFor(task: Task): Lane {
    return resolveEngine(this.opts.settings(), task) === 'claude' ? 'claude' : 'gpu';
  }

  /**
   * The engine a text job runs on is decided by the lane it is in, never by the live settings (I1): local LLM work
   * can then only ever run in the gpu lane, serialised with ComfyUI, and a Claude call never parks in it. The model
   * per task still comes from the settings (claude models per task, the ollama text/vision model).
   */
  forLane(lane: Lane): TextEngine {
    if (lane === 'claude') return this.opts.claude;
    if (lane === 'gpu') return this.opts.local;
    throw new PermanentError(`No text engine runs in the "${lane}" lane`);
  }
}

/** Job kinds that run on a text engine. */
export const TEXT_JOB_KINDS: readonly JobKind[] = ['llm.step', 'image.review'];

/**
 * The task a text job runs, derived from its kind and payload; null when it cannot be derived. M2: panel-prompt and
 * appearance → 'prompts', image.review → 'review'. M4: an episode step → `STEP_TASK[step]` (render/lettering stay
 * null: they are cpu-lane drivers). W1 F10: the chapter summary → 'story', so an engine switch re-lanes it too.
 */
export function textTaskOf(job: Pick<Job, 'kind' | 'payload'>): Task | null {
  if (job.kind === 'image.review') return 'review';
  if (job.kind !== 'llm.step') return null;
  const payload = typeof job.payload === 'object' && job.payload !== null ? (job.payload as { type?: unknown; step?: unknown }) : {};
  if (payload.type === 'panel-prompt' || payload.type === 'appearance') return 'prompts';
  if (payload.type === 'chapter-summary') return 'story';
  if (payload.type === 'episode' && typeof payload.step === 'string' && Object.hasOwn(STEP_TASK, payload.step)) {
    return STEP_TASK[payload.step as keyof typeof STEP_TASK];
  }
  return null;
}

/**
 * I1: moves every queued (never running) text job to the lane of its task's engine under the current settings, so
 * an engine switch takes effect for work already waiting — including work stranded in a quota-paused claude lane.
 * Jobs whose task can't be derived, or that sit outside the claude/gpu lanes, stay. A no-op when nothing changed.
 * Returns the moved jobs (the queue publishes a job event for each).
 */
export function relaneTextJobs(store: Store, queue: JobQueue, engines: Engines): Job[] {
  const moved: Job[] = [];
  for (const job of store.jobs.listQueued(TEXT_JOB_KINDS)) {
    const task = textTaskOf(job);
    if (task === null || (job.lane !== 'claude' && job.lane !== 'gpu')) continue;
    const next = queue.relane(job.id, engines.laneFor(task));
    if (next) moved.push(next);
  }
  return moved;
}
