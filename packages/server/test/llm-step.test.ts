import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmStepPayload } from '@manga/shared';
import { llmStepJobHandler, registerLlmStep } from '../src/jobs/llm-step.js';
import { PermanentError } from '../src/jobs/index.js';
import { jobContext } from './helpers/job-context.js';
import { openTestLibrary, type TestLibrary } from './helpers/library.js';

let lib: TestLibrary;
beforeEach(() => { lib = openTestLibrary(); });
afterEach(() => { lib.close(); });

describe('llm.step dispatcher', () => {
  it('routes the payload to the handler registered for its type', async () => {
    const seen: LlmStepPayload[] = [];
    registerLlmStep('appearance', async (_ctx, payload) => {
      seen.push(payload);
      return { appearanceTags: '1girl' };
    });
    const payload: LlmStepPayload = { type: 'appearance', characterId: 'cr_dispatch01', description: 'a girl' };
    const { ctx } = jobContext(lib.store, 'llm.step', payload);
    await expect(llmStepJobHandler()(ctx)).resolves.toEqual({ appearanceTags: '1girl' });
    expect(seen).toEqual([payload]);
  });

  it('lets a later registration replace an earlier one', async () => {
    registerLlmStep('panel-prompt', async () => 'first');
    registerLlmStep('panel-prompt', async () => 'second');
    const { ctx } = jobContext(lib.store, 'llm.step', { type: 'panel-prompt', panelId: 'pn_dispatch01' });
    await expect(llmStepJobHandler()(ctx)).resolves.toBe('second');
  });

  it('fails permanently for a type nobody registered', async () => {
    const { ctx } = jobContext(lib.store, 'llm.step', { type: 'episode', runId: 'er_dispatch01', step: 'premise' });
    const err = await llmStepJobHandler()(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('No llm.step handler registered for "episode"');
  });
});
