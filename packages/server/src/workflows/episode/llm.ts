import { ZodError } from 'zod';
import type { EpisodeRun } from '@manga/shared';
import { InvalidOutputError } from '../../engines/errors.js';
import { accepted, parseAgainst } from '../../engines/structured.js';
import type { Engines } from '../../engines/resolve.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { combineAnswers, stepRequests } from './requests.js';
import type { LlmStepName } from './steps.js';

/** Spec §13: after the correction round fails, the raw answer must be viewable in the stepper — it travels in the step error. */
export const RAW_OUTPUT_LIMIT = 4000;

/** What `completeStructured` appends to its message; the raw answer goes after the marker instead (F25). */
const ENGINE_RAW_TAIL = ' Raw output: ';

/**
 * The step error for an answer that could not be used: the engine's message without its own copy of the answer
 * (F25), then the raw answer once, after `--- raw output ---`.
 */
export function rawOutputError(err: InvalidOutputError): PermanentError {
  const at = err.message.indexOf(ENGINE_RAW_TAIL);
  const message = at >= 0 ? err.message.slice(0, at) : err.message;
  return new PermanentError(`${message}\n--- raw output ---\n${err.raw.slice(0, RAW_OUTPUT_LIMIT)}`);
}

/**
 * Runs an LLM step: the calls of `stepRequests` in order (scripts in page chunks, prompts one page per call, F18),
 * each answer repaired by `normalizeLlmAnswer`, joined and validated as a whole by `combineAnswers`. Every call runs on the engine of the job's LANE, never on
 * the live settings (I1, F1). Each call's correction round sees its own refined schema.
 */
export async function executeLlmStep(
  deps: { store: Store; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, run: EpisodeRun, step: LlmStepName,
): Promise<unknown> {
  const engine = deps.engines.forLane(ctx.job.lane);
  const requests = stepRequests(deps.store, run, step);
  const answers: unknown[] = [];
  try {
    for (const { name, task, system, prompt, schema, progress, relaxed, promptFor } of requests) {
      ctx.progress(progress);
      const sent = promptFor ? promptFor(answers) : prompt; // W1 Q1: a later scripts chunk sees the pages written before it
      try {
        answers.push(await engine.completeJson({ name, task, system, prompt: sent, schema, signal: ctx.signal, onProgress: (label) => ctx.progress(label) }));
      } catch (err) {
        // Still invalid after the correction round: a prompts answer whose only fault is a non-English scene is kept,
        // and the prompts effect writes those scenes from the cast (Roman's Ukrainian run).
        const kept = err instanceof InvalidOutputError && relaxed ? parseAgainst(err.raw, relaxed) : null;
        if (!kept?.ok) throw err;
        answers.push(accepted(kept, name));
      }
    }
  } catch (err) {
    throw err instanceof InvalidOutputError ? rawOutputError(err) : err;
  }
  try {
    const output = combineAnswers(deps.store, run, step, answers);
    const filled = requests.flatMap((r) => r.filled);
    if (filled.length > 0) {
      console.warn(`[manga] episode prompts: run ${run.id}: the AI wrote no scene for ${filled.length} panel(s), so it comes from the script: ${filled.join(', ')}`);
    }
    return output;
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    const problems = err.issues.map((i) => i.message).join('; ');
    throw rawOutputError(new InvalidOutputError(`episode.${step}: the joined answers are invalid (${problems})`, JSON.stringify(answers)));
  }
}
