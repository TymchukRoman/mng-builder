import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type PromptName = 'panel-prompt-tags' | 'panel-prompt-natural' | 'appearance' | 'review';

const cache = new Map<PromptName, string>();

/** Reads src/prompts/<name>.md. Works from src (vitest) and from dist/prompts (tsc does not copy .md files). */
export function loadPrompt(name: PromptName): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const candidates = [
    fileURLToPath(new URL(`./${name}.md`, import.meta.url)),
    fileURLToPath(new URL(`../../src/prompts/${name}.md`, import.meta.url)),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`Prompt ${name}.md not found (looked in ${candidates.join(', ')})`);
  const text = readFileSync(file, 'utf8').trim();
  cache.set(name, text);
  return text;
}
