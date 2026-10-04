import { ZodError } from 'zod';
import { CheckAnswerSchema, ScriptsOutputSchema, directivesFor, type EpisodeRun } from '@manga/shared';
import { InvalidOutputError } from '../../engines/errors.js';
import { accepted, parseAgainst } from '../../engines/structured.js';
import type { Engines } from '../../engines/resolve.js';
import type { TextEngine } from '../../engines/types.js';
import { PermanentError, type JobContext } from '../../jobs/index.js';
import type { Store } from '../../store/index.js';
import { SUMMARY_STORY_LIMIT } from './summary.js';
import { LANGUAGE_NAME, contextBlock, directiveBrief, ledgerOf, storyDigest, type Revision, type ScriptsAuditContext } from './context.js';
import { loadSplitPrompt, renderTemplate } from './prompts.js';
import { combineAnswers, stepRequests, type StepRequest } from './requests.js';
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
  let answers: unknown[];
  try {
    answers = await runRequests(engine, ctx, requests);
  } catch (err) {
    throw err instanceof InvalidOutputError ? rawOutputError(err) : err;
  }
  let output = joinAnswers(deps.store, run, step, requests, answers);
  if (step === 'scripts') output = await reviseScripts(deps, ctx, run, output);
  return output;
}

/** The calls of a step in order, each on `engine`; a prompts answer whose only fault is a non-English scene is kept (the effect writes those scenes from the cast). */
async function runRequests(engine: TextEngine, ctx: JobContext, requests: readonly StepRequest[]): Promise<unknown[]> {
  const answers: unknown[] = [];
  for (const { name, task, system, prompt, schema, progress, relaxed, promptFor } of requests) {
    ctx.progress(progress);
    const sent = promptFor ? promptFor(answers) : prompt; // W1 Q1: a later scripts chunk sees the pages written before it
    try {
      answers.push(await engine.completeJson({ name, task, system, prompt: sent, schema, signal: ctx.signal, onProgress: (label) => ctx.progress(label) }));
    } catch (err) {
      const kept = err instanceof InvalidOutputError && relaxed ? parseAgainst(err.raw, relaxed) : null;
      if (!kept?.ok) throw err;
      answers.push(accepted(kept, name));
    }
  }
  return answers;
}

function joinAnswers(store: Store, run: EpisodeRun, step: LlmStepName, requests: readonly StepRequest[], answers: unknown[]): unknown {
  try {
    const output = combineAnswers(store, run, step, answers);
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

/**
 * The second look at a chapter's script: one call checks it against the chapter's "must" directives (the author's details that
 * a script can show: plot, characters, setting, dialogue, structure, what to avoid). When some are unmet, the script is written
 * once more with the findings (`revisions`), and that second script is kept. Nothing here ever fails the step: a failed or
 * invalid check or rewrite keeps the first script (one warning), and a cancelled job still cancels.
 */
export async function reviseScripts(
  deps: { store: Store; engines: Pick<Engines, 'forLane'> }, ctx: JobContext, run: EpisodeRun, first: unknown,
): Promise<unknown> {
  const { store } = deps;
  const chapter = store.chapters.require(run.chapterId);
  const checked = directivesFor('scripts', ledgerOf(run), chapter.number).filter((d) => d.must && d.kind !== 'visual');
  if (checked.length === 0) return first;
  const engine = deps.engines.forLane(ctx.job.lane);
  try {
    ctx.progress('Checking the script against your details…');
    const manga = store.mangas.require(chapter.mangaId);
    const data: ScriptsAuditContext = {
      step: 'scripts-audit', language: manga.language, directives: checked.map(directiveBrief),
      story: storyDigest(ScriptsOutputSchema.parse(first).pages, 1, SUMMARY_STORY_LIMIT, { keepFirst: true }),
    };
    const template = loadSplitPrompt('script-audit', 'episode');
    const vars = { context: contextBlock(data), languageName: LANGUAGE_NAME[manga.language] };
    const verdict = await engine.completeJson({
      name: 'episode.scripts-audit', task: 'story', system: renderTemplate(template.system, vars), prompt: renderTemplate(template.user, vars),
      schema: CheckAnswerSchema, signal: ctx.signal, onProgress: (label) => ctx.progress(label),
    });
    const byId = new Map(checked.map((d) => [d.id, d]));
    const revisions: Revision[] = verdict.unmet.flatMap((u) => {
      const d = byId.get(u.id);
      return d ? [{ id: d.id, text: d.text, problem: u.problem, ...(u.page !== undefined ? { page: u.page } : {}) }] : [];
    });
    if (revisions.length === 0) return first;
    ctx.progress(`Rewriting the script: ${revisions.length} detail${revisions.length === 1 ? '' : 's'} were missing…`);
    const requests = stepRequests(store, run, 'scripts', { revisions });
    const answers = await runRequests(engine, ctx, requests);
    return joinAnswers(store, run, 'scripts', requests, answers);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.warn(`[manga] episode scripts: run ${run.id}: the check against the author's details failed, so the first script stays: ${err instanceof Error ? err.message : String(err)}`);
    return first;
  }
}
