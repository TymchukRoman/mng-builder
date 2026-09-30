// packages/server/src/workflows/episode/steps.ts
import type { z } from 'zod';
import { EPISODE_STEPS, stepIndex, type EpisodeRun, type EpisodeStep, type EpisodeStepName } from '@manga/shared';
import { ConflictError } from '../../errors.js';

export type LlmStepName = Exclude<EpisodeStepName, 'render' | 'lettering'>;
export const LLM_STEPS: readonly LlmStepName[] = ['premise', 'outline', 'breakdown', 'scripts', 'prompts'];

export function isLlmStep(name: EpisodeStepName): name is LlmStepName {
  return name !== 'render' && name !== 'lettering';
}

/** Job progress label shown while a step runs (spec §7: "Writing outline…"). */
export const STEP_PROGRESS: Record<EpisodeStepName, string> = {
  premise: 'Writing premise…', outline: 'Writing outline…', breakdown: 'Planning pages…', scripts: 'Writing scripts…',
  prompts: 'Writing image prompts…', render: 'Rendering images…', lettering: 'Lettering…',
};

export const nowIso = (): string => new Date().toISOString();

let lastToken = '';
/** Strictly increasing ISO timestamps in this process: a step's token (startedAt) must change on every dispatch, even within one millisecond. */
export function monotonicIso(): string {
  let t = new Date().toISOString();
  if (t <= lastToken) t = new Date(Date.parse(lastToken) + 1).toISOString();
  lastToken = t;
  return t;
}

export function freshStep(name: EpisodeStepName): EpisodeStep {
  return { name, status: 'pending', output: null, error: null, startedAt: null, finishedAt: null };
}

export function freshSteps(): EpisodeStep[] {
  return EPISODE_STEPS.map(freshStep);
}

export function patchStep(steps: EpisodeStep[], index: number, patch: Partial<EpisodeStep>): EpisodeStep[] {
  return steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

export function requireOutput<T>(run: EpisodeRun, name: EpisodeStepName, schema: z.ZodType<T>): T {
  const step = run.steps[stepIndex(name)];
  if (!step || step.output === null || step.output === undefined) throw new ConflictError(`step ${name} has no output yet`);
  return schema.parse(step.output);
}
