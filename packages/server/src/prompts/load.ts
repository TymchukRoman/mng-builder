import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type PromptName = 'panel-prompt-tags' | 'panel-prompt-natural' | 'appearance' | 'review';
/** Sub-folders of src/prompts (M4: the episode step prompts live in prompts/episode). */
export type PromptFolder = 'episode';

const cache = new Map<string, string>();

/** Reads src/prompts/[<folder>/]<name>.md. Works from src (vitest) and from dist/prompts (tsc does not copy .md files). */
export function loadPrompt(name: PromptName): string;
export function loadPrompt(name: string, folder: PromptFolder): string;
export function loadPrompt(name: string, folder?: PromptFolder): string {
  const rel = folder === undefined ? name : `${folder}/${name}`;
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  const candidates = [
    fileURLToPath(new URL(`./${rel}.md`, import.meta.url)),
    fileURLToPath(new URL(`../../src/prompts/${rel}.md`, import.meta.url)),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`Prompt ${rel}.md not found (looked in ${candidates.join(', ')})`);
  const text = readFileSync(file, 'utf8').trim();
  cache.set(rel, text);
  return text;
}
