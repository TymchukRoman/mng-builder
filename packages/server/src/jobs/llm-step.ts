import type { LlmStepPayload } from '@manga/shared';
import { PermanentError, type JobContext, type JobHandler } from './index.js';

export type LlmStepHandler = (ctx: JobContext, payload: LlmStepPayload) => Promise<unknown>;

const steps = new Map<LlmStepPayload['type'], LlmStepHandler>();

/** M2 registers 'panel-prompt' and 'appearance'; M4 registers 'episode'. The last registration for a type wins. */
export function registerLlmStep(type: LlmStepPayload['type'], handler: LlmStepHandler): void {
  steps.set(type, handler);
}

export function llmStepJobHandler(): JobHandler {
  return async (ctx: JobContext) => {
    const payload = ctx.job.payload as LlmStepPayload;
    const type = typeof payload === 'object' && payload !== null ? payload.type : undefined;
    const handler = type ? steps.get(type) : undefined;
    if (!handler) throw new PermanentError(`No llm.step handler registered for "${String(type)}"`);
    return handler(ctx, payload);
  };
}
