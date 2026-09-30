// packages/server/src/workflows/episode/prompts.ts
import { loadPrompt } from '../../prompts/load.js';
import type { LlmStepName } from './steps.js';

export interface StepPrompt { system: string; user: string }

const SPLIT = '<!-- user -->';
const cache = new Map<LlmStepName, StepPrompt>();

/** src/prompts/episode/<step>.md (F28: M2's loadPrompt with a sub-folder), split into its system and user parts. */
export function loadStepPrompt(step: LlmStepName): StepPrompt {
  const hit = cache.get(step);
  if (hit) return hit;
  const text = loadPrompt(step, 'episode').replace(/\r\n/g, '\n');
  const at = text.indexOf(SPLIT);
  if (at < 0) throw new Error(`Episode prompt ${step}.md has no "${SPLIT}" line`);
  const prompt: StepPrompt = {
    system: text.slice(0, at).replace('<!-- system -->', '').trim(),
    user: text.slice(at + SPLIT.length).trim(),
  };
  cache.set(step, prompt);
  return prompt;
}

/** Replaces {{name}} placeholders; values are inserted literally (no `$&` expansion). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`template placeholder {{${key}}} has no value`);
    return value;
  });
}
